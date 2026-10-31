// provision-nation - FN Hub control plane (assisted provisioning).
// Deploy on the fnhub-platform project (CI: deploy-platform-functions.yml, or
// `supabase functions deploy provision-nation --project-ref <platform-ref>`).
//
// SUPER-ADMIN ONLY. The panel sends the caller's platform user JWT as the
// bearer; this function verifies the caller is in super_admins before doing
// anything. It then stands up a NEW nation against a Supabase project the
// operator already created.
//
// Steps (each is best-effort and reported back; a failure never throws out):
//   1. Run the bootstrap schema on the new project   (Management API)
//      - schema is AUTO-FETCHED from the repo if not supplied in the payload
//      - project ref is AUTO-DERIVED from the URL if not supplied
//   2. Create the housing-files storage bucket        (new project service key)
//   3. Seed the first ED staff row                     (new project service key)
//   4. Create the first ED sign-in (auth user)         (new project service key)
//      - password from payload, else generated + returned in the response
//   5. Upsert the control-plane registry row           (platform service key)
//   6. (manual) Deploy the nation Edge Functions + secrets - documented
//
// Secrets required on the platform project:
//   SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY  (auto-injected)
//   SB_MGMT_TOKEN  - a Supabase Management API token (org access token),
//                          required for step 1 to run the schema.
//   BOOTSTRAP_SCHEMA_URL - optional override for the auto-fetched schema URL.
// Source ASCII-only.

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || ''
const ANON_KEY     = Deno.env.get('SUPABASE_ANON_KEY') || ''
const SERVICE_KEY  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || ''
// Supabase reserves the SUPABASE_ prefix for its own secrets, so the custom
// Management API token secret must be named SB_MGMT_TOKEN (legacy name kept as
// a fallback in case it was ever set another way).
const MGMT_TOKEN   = Deno.env.get('SB_MGMT_TOKEN') || Deno.env.get('SUPABASE_MGMT_TOKEN') || ''
const MGMT_BASE    = 'https://api.supabase.com'
const SCHEMA_URL   = Deno.env.get('BOOTSTRAP_SCHEMA_URL') ||
  'https://raw.githubusercontent.com/fnhub-app/fnhub-platform/main/supabase/bootstrap/schema.sql'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
function json(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } })
}

const SUB_RE = /^[a-z0-9](?:[a-z0-9-]{0,40}[a-z0-9])?$/   // safe subdomain label
function trimSlash(s: string): string { return String(s || '').replace(/\/+$/, '') }
function refFromUrl(url: string): string {
  const m = /^https?:\/\/([a-z0-9-]+)\.supabase\.co/i.exec(String(url || '').trim())
  return m ? m[1] : ''
}
function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)) }
function genPassword(): string {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789'
  const buf = new Uint8Array(18)
  crypto.getRandomValues(buf)
  let s = ''
  for (let i = 0; i < buf.length; i++) s += chars[buf[i] % chars.length]
  return s
}

// Resolve + authorize the caller. Returns the lowercased super-admin email, or null.
async function authorizeSuperAdmin(admin: any, token: string): Promise<string | null> {
  if (!token) return null
  let email = ''
  try {
    const r = await fetch(SUPABASE_URL + '/auth/v1/user', {
      headers: { apikey: ANON_KEY, Authorization: 'Bearer ' + token },
    })
    if (!r.ok) return null
    const u = await r.json()
    email = String((u && u.email) || '').toLowerCase()
  } catch (_e) { return null }
  if (!email) return null
  const { data } = await admin.from('super_admins').select('email').ilike('email', email).limit(1)
  return (data && data.length) ? email : null
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  if (req.method !== 'POST')    return json({ error: 'method_not_allowed' }, 405)
  if (!SUPABASE_URL || !SERVICE_KEY) return json({ error: 'not_configured' }, 500)

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } })
  const token = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '')
  const actor = await authorizeSuperAdmin(admin, token)
  if (!actor) return json({ error: 'forbidden' }, 403)

  let body: any = {}
  try { body = await req.json() } catch (_e) { return json({ error: 'bad_json' }, 400) }

  const nation   = body.nation   || {}
  const target   = body.target   || {}   // { ref, url, anon, service_role }
  const firstEd  = body.first_ed || {}   // { email, name, password }
  const schemaSql = String(body.schema_sql || '')

  const sub = String(nation.subdomain || '').trim().toLowerCase()
  if (!SUB_RE.test(sub))        return json({ error: 'bad_subdomain' }, 400)
  if (!nation.display_name || !nation.short) return json({ error: 'missing_nation_fields' }, 400)

  const targetUrl = trimSlash(target.url)
  const ref = (target.ref && String(target.ref).trim()) || refFromUrl(targetUrl)

  // Guard: never provision a nation onto the control-plane project itself.
  // SUPABASE_URL is THIS (platform) project's own URL; if the target resolves to
  // the same ref, the operator pasted the control-plane project by mistake --
  // which would put housing tables + a nation ED onto the platform database.
  const PLATFORM_REF = refFromUrl(SUPABASE_URL)
  if (ref && PLATFORM_REF && ref === PLATFORM_REF) {
    return json({ error: 'target_is_control_plane',
      message: 'The target Supabase project (' + ref + ') is the control-plane project. A nation must be provisioned onto its OWN project, not the platform project. Re-enter the nation project\'s URL, ref, anon and service_role keys.' }, 400)
  }

  const steps: Array<{ name: string; ok: boolean; detail: string }> = []
  const step = (name: string, ok: boolean, detail: string) => { steps.push({ name, ok, detail }) }

  // --- Step 1: run the bootstrap schema on the new project (Management API) ---
  // Schema is auto-fetched from the repo when the payload doesn't include it.
  let schemaToRun = schemaSql
  let schemaSource = schemaSql ? 'uploaded' : ''
  if (!schemaToRun) {
    try {
      const sr = await fetch(SCHEMA_URL)
      if (sr.ok) { schemaToRun = await sr.text(); schemaSource = 'auto-fetched' }
    } catch (_e) { /* handled by the skip message below */ }
  }
  if (schemaToRun && ref && MGMT_TOKEN) {
    try {
      const r = await fetch(MGMT_BASE + '/v1/projects/' + encodeURIComponent(ref) + '/database/query', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + MGMT_TOKEN, 'Content-Type': 'application/json' },
        // After the schema: grant sequence usage to the API roles (tables created
        // via the Management API as `postgres` don't auto-grant sequence access,
        // so inserts on serial-id tables like staff 403 on their *_id_seq), then
        // NOTIFY so PostgREST reloads its cache and sees the new tables.
        body: JSON.stringify({ query: schemaToRun +
          "\n;\ngrant usage, select on all sequences in schema public to anon, authenticated, service_role;" +
          "\n;\nnotify pgrst, 'reload schema';" }),
      })
      const txt = await r.text()
      step('bootstrap_schema', r.ok, r.ok ? ('Schema applied (' + schemaSource + ').') : ('Management API ' + r.status + ': ' + txt.slice(0, 300)))
      if (r.ok) await sleep(2500)   // give PostgREST a moment to reload
    } catch (e) { step('bootstrap_schema', false, 'Error: ' + String(e).slice(0, 200)) }
  } else {
    const miss: string[] = []
    if (!MGMT_TOKEN)    miss.push('SB_MGMT_TOKEN secret (set once on the platform project)')
    if (!ref)          miss.push('project ref or URL')
    if (!schemaToRun)  miss.push('schema (upload one, or the repo URL was unreachable)')
    step('bootstrap_schema', false, 'Skipped: needs ' + miss.join(' + ') + '.')
  }

  // --- Step 2: create the housing-files storage bucket on the new project -----
  if (targetUrl && target.service_role) {
    try {
      const r = await fetch(targetUrl + '/storage/v1/bucket', {
        method: 'POST',
        headers: { apikey: target.service_role, Authorization: 'Bearer ' + target.service_role, 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: 'housing-files', name: 'housing-files', public: false }),
      })
      const txt = await r.text()
      const already = /already exists/i.test(txt)
      step('storage_bucket', r.ok || already, r.ok ? 'Bucket created.' : (already ? 'Bucket already existed.' : (r.status + ': ' + txt.slice(0, 200))))
    } catch (e) { step('storage_bucket', false, 'Error: ' + String(e).slice(0, 200)) }
  } else {
    step('storage_bucket', false, 'Skipped: needs target.url + target.service_role.')
  }

  // --- Step 3: seed the first ED staff row on the new project -----------------
  // Retry once on a PostgREST schema-cache miss (tables just created above).
  if (targetUrl && target.service_role && firstEd.email) {
    const seed = () => fetch(targetUrl + '/rest/v1/staff', {
      method: 'POST',
      headers: {
        apikey: target.service_role, Authorization: 'Bearer ' + target.service_role,
        'Content-Type': 'application/json', Prefer: 'return=minimal,resolution=merge-duplicates',
      },
      body: JSON.stringify({ email: String(firstEd.email).toLowerCase(), name: firstEd.name || 'Executive Director', role: 'ed', is_active: true }),
    })
    try {
      let r = await seed(); let txt = await r.text()
      if (!r.ok && /PGRST205|schema cache/i.test(txt)) { await sleep(3000); r = await seed(); txt = await r.text() }
      step('seed_first_ed', r.ok, r.ok ? ('Seeded ED ' + firstEd.email) : (r.status + ': ' + txt.slice(0, 200)))
    } catch (e) { step('seed_first_ed', false, 'Error: ' + String(e).slice(0, 200)) }
  } else {
    step('seed_first_ed', false, 'Skipped: needs target.url + target.service_role + first_ed.email.')
  }

  // --- Step 4: create the first ED sign-in (auth user) ------------------------
  let edPassword = ''
  if (targetUrl && target.service_role && firstEd.email) {
    const pw = (firstEd.password && String(firstEd.password)) || genPassword()
    try {
      const r = await fetch(targetUrl + '/auth/v1/admin/users', {
        method: 'POST',
        headers: { apikey: target.service_role, Authorization: 'Bearer ' + target.service_role, 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: String(firstEd.email).toLowerCase(), password: pw, email_confirm: true }),
      })
      const txt = await r.text()
      if (r.ok) { edPassword = pw; step('ed_login', true, 'Sign-in created for ' + firstEd.email + '.') }
      else if (/already|exists|registered/i.test(txt)) { step('ed_login', true, 'Sign-in already existed for ' + firstEd.email + ' (password unchanged).') }
      else { step('ed_login', false, r.status + ': ' + txt.slice(0, 200)) }
    } catch (e) { step('ed_login', false, 'Error: ' + String(e).slice(0, 200)) }
  } else {
    step('ed_login', false, 'Skipped: needs target.url + target.service_role + first_ed.email.')
  }

  // --- Step 4b: configure Auth (URLs + sign-in policy) ------------------------
  // (1) Site URL + redirect allowlist so magic links (password reset, admin
  //     sign-in links, support-login "Enter") redirect back to the NATION app
  //     instead of the Supabase default (http://localhost:3000).
  // (2) Sign-in policy so the in-app Add-Staff flow works out of the box:
  //     - mailer_autoconfirm=true  -> new signups are auto-confirmed, so a new
  //       staff account is usable immediately (Supabase's built-in confirmation
  //       email is rate-limited and often never delivers -> staff couldn't log
  //       in). Nations that configure real SMTP can turn this back on.
  //     - disable_signup=false     -> Add-Staff creates logins via /auth/signup.
  // Needs ref + MGMT_TOKEN.
  if (ref && MGMT_TOKEN) {
    const siteUrl = 'https://' + sub + '.fnhub.app'
    const allow = siteUrl + ',' + siteUrl + '/**'
    try {
      const r = await fetch(MGMT_BASE + '/v1/projects/' + encodeURIComponent(ref) + '/config/auth', {
        method: 'PATCH',
        headers: { Authorization: 'Bearer ' + MGMT_TOKEN, 'Content-Type': 'application/json' },
        body: JSON.stringify({ site_url: siteUrl, uri_allow_list: allow, mailer_autoconfirm: true, disable_signup: false }),
      })
      const txt = await r.text()
      step('auth_config', r.ok, r.ok ? ('Site URL/redirect set to ' + siteUrl + '; email auto-confirm ON; signups allowed.')
        : ('Management API ' + r.status + ': ' + txt.slice(0, 200)))
    } catch (e) { step('auth_config', false, 'Error: ' + String(e).slice(0, 200)) }
  } else {
    const miss: string[] = []
    if (!MGMT_TOKEN) miss.push('SB_MGMT_TOKEN secret')
    if (!ref)        miss.push('project ref or URL')
    step('auth_config', false, 'Skipped: needs ' + miss.join(' + ') + '.')
  }

  // --- Step 5: upsert the control-plane registry row (platform) ---------------
  let registryOk = false
  try {
    const row: Record<string, unknown> = {
      subdomain: sub,
      display_name: nation.display_name,
      short: nation.short,
      supabase_url: targetUrl || null,
      supabase_anon: target.anon || null,
      primary_color: nation.primary_color || null,
      email_domain: nation.email_domain || null,
      housing_email: nation.housing_email || null,
      modules_licensed: (nation.modules_licensed && typeof nation.modules_licensed === 'object') ? nation.modules_licensed : {},
      status: (targetUrl && target.anon) ? 'active' : 'provisioning',
      provisioned_by: actor,
      updated_at: new Date().toISOString(),
    }
    const { error } = await admin.from('nations').upsert(row, { onConflict: 'subdomain' })
    registryOk = !error
    step('registry_row', registryOk, registryOk ? 'Registry upserted (status ' + row.status + ').' : ('DB error: ' + (error && error.message)))
  } catch (e) { step('registry_row', false, 'Error: ' + String(e).slice(0, 200)) }

  // --- Step 6: nation Edge Functions + secrets (manual in assisted mode) ------
  step('edge_functions', false, 'Manual/optional: deploy the nation functions via the "Deploy Supabase Edge Functions" workflow (one project ref). It deploys ALL of them, including send-sms (text notifications) and contractor-claim (portal login). Then set per-module secrets only as needed: email (Email tab), AI (ANTHROPIC_API_KEY), SMS (Twilio, SMS & Portal tab). Contractor Portal login also needs Auth > Providers > Phone > Twilio Verify set in this project\'s dashboard (not automated).')

  // Audit (best-effort).
  try {
    await admin.from('platform_audit').insert({
      actor, action: 'nation_provisioned', target: sub,
      detail: JSON.stringify({ steps: steps.map((s) => ({ name: s.name, ok: s.ok })), display_name: nation.display_name }),
    })
  } catch (_e) { /* never block on audit */ }

  const allCore = registryOk
  const out: Record<string, unknown> = { ok: allCore, subdomain: sub, steps }
  if (edPassword) out.ed_password = edPassword
  if (firstEd.email) out.ed_email = String(firstEd.email).toLowerCase()
  return json(out)
})
