// set-nation-module - FN Hub control plane.
//
// Lets a super-admin ENABLE or DISABLE an optional module for a nation from the
// admin portal, by writing the nation project's
// housing_settings.module_enablement._enabled.<module> via the Supabase
// Management API (the same mechanism provision-nation / set-nation-secret use).
// Also supports a read (action 'get') so the panel can show current state.
//
// The in-app Modules list is read-only (scoring.js), so this is the ONE place a
// module's enabled state is changed. Licensing (nations.modules_licensed) stays
// on the control-plane registry and is edited separately in the panel.
//
// Deploy on the fnhub-platform project (verifies the caller against
// super_admins itself, so --no-verify-jwt is fine):
//   supabase functions deploy set-nation-module --project-ref <platform-ref>
//
// Secrets (auto-injected + one manual):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY  (auto)
//   SB_MGMT_TOKEN  - Supabase Management API token (same one provision-nation uses)
// Source ASCII-only.

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || ''
const SERVICE_KEY  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || ''
const ANON_KEY     = Deno.env.get('SUPABASE_ANON_KEY') || ''
const MGMT_TOKEN   = Deno.env.get('SB_MGMT_TOKEN') || Deno.env.get('SUPABASE_MGMT_TOKEN') || ''
const MGMT_BASE    = 'https://api.supabase.com'

// Only these optional module keys may be toggled (matches CLFN_MODULES optional
// set in shared-config.js). CORE modules are never toggleable.
const OPTIONAL = new Set([
  'finance', 'match', 'contractors', 'renovations', 'rfq', 'mapping',
  'inspections', 'ai_assistant', 'projects', 'email_intake',
  'sms_notifications', 'contractor_portal',
])

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
function json(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } })
}
const SUB_RE = /^[a-z0-9](?:[a-z0-9-]{0,40}[a-z0-9])?$/
function refFromUrl(url: string): string {
  const m = /^https?:\/\/([a-z0-9-]+)\.supabase\.co/i.exec(String(url || '').trim())
  return m ? m[1] : ''
}
async function authorizeSuperAdmin(admin: any, token: string): Promise<string | null> {
  if (!token) return null
  let email = ''
  try {
    const r = await fetch(SUPABASE_URL + '/auth/v1/user', { headers: { apikey: ANON_KEY, Authorization: 'Bearer ' + token } })
    if (!r.ok) return null
    const u = await r.json()
    email = String((u && u.email) || '').toLowerCase()
  } catch (_e) { return null }
  if (!email) return null
  const { data } = await admin.from('super_admins').select('email').ilike('email', email).limit(1)
  return (data && data.length) ? email : null
}

// Run SQL on the nation project via the Management API; return the result rows.
async function runSql(ref: string, query: string): Promise<{ ok: boolean; rows: any[]; detail: string }> {
  try {
    const r = await fetch(MGMT_BASE + '/v1/projects/' + ref + '/database/query', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + MGMT_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query }),
    })
    const txt = await r.text()
    if (!r.ok) return { ok: false, rows: [], detail: 'Management API ' + r.status + ': ' + txt.slice(0, 300) }
    let rows: any[] = []
    try { const parsed = JSON.parse(txt); rows = Array.isArray(parsed) ? parsed : (parsed && parsed.result) || [] } catch (_e) { rows = [] }
    return { ok: true, rows, detail: '' }
  } catch (e) { return { ok: false, rows: [], detail: 'Error: ' + String(e).slice(0, 200) } }
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  if (req.method !== 'POST')    return json({ error: 'method_not_allowed' }, 405)
  if (!SUPABASE_URL || !SERVICE_KEY) return json({ error: 'not_configured' }, 500)
  if (!MGMT_TOKEN) return json({ error: 'SB_MGMT_TOKEN not set on the platform project' }, 500)

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } })
  const token = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '')
  const caller = await authorizeSuperAdmin(admin, token)
  if (!caller) return json({ error: 'forbidden' }, 403)

  let body: any = {}
  try { body = await req.json() } catch (_e) { return json({ error: 'bad_json' }, 400) }
  const sub = String(body.subdomain || '').trim().toLowerCase()
  if (!SUB_RE.test(sub)) return json({ error: 'bad_subdomain' }, 400)
  const action = String(body.action || 'get')

  // Resolve the nation's project ref from the registry.
  const { data: rows } = await admin.from('nations').select('subdomain, supabase_url').eq('subdomain', sub).limit(1)
  const nation = rows && rows[0]
  if (!nation) return json({ error: 'nation_not_found' }, 404)
  const ref = refFromUrl(nation.supabase_url || '')
  if (!ref) return json({ error: 'nation_has_no_project' }, 400)

  if (action === 'get') {
    const res = await runSql(ref,
      "select coalesce((select value->'_enabled' from public.housing_settings where key='module_enablement'), '{}'::jsonb) as enabled")
    if (!res.ok) return json({ error: 'mgmt_query_failed', detail: res.detail }, 502)
    const enabled = (res.rows[0] && res.rows[0].enabled) || {}
    return json({ ok: true, subdomain: sub, enabled })
  }

  if (action === 'set') {
    const mod = String(body.module || '').trim()
    if (!OPTIONAL.has(mod)) return json({ error: 'module_not_allowed', module: mod }, 400)
    const enabled = body.enabled === true || body.enabled === 'true'
    const boolLit = enabled ? 'true' : 'false'
    // mod is validated against the OPTIONAL allowlist (safe to interpolate);
    // boolLit is a literal. Preserve other modules; create the row/key if absent.
    const sql =
      "insert into public.housing_settings (key, value) values " +
      "('module_enablement', jsonb_build_object('_enabled', jsonb_build_object('" + mod + "', " + boolLit + "))) " +
      "on conflict (key) do update set value = jsonb_set(" +
      "coalesce(public.housing_settings.value, '{}'::jsonb), '{_enabled}', " +
      "coalesce(public.housing_settings.value->'_enabled', '{}'::jsonb) || jsonb_build_object('" + mod + "', " + boolLit + "), true) " +
      "returning coalesce(value->'_enabled', '{}'::jsonb) as enabled"
    const res = await runSql(ref, sql)
    if (!res.ok) return json({ error: 'mgmt_set_failed', detail: res.detail }, 502)
    const newEnabled = (res.rows[0] && res.rows[0].enabled) || {}
    try {
      await admin.from('platform_audit').insert({
        action: enabled ? 'nation_module_enabled' : 'nation_module_disabled',
        subdomain: sub,
        detail: mod + (enabled ? ' enabled' : ' disabled') + ' by ' + caller,
      })
    } catch (_e) { /* audit best-effort */ }
    return json({ ok: true, subdomain: sub, module: mod, enabled: newEnabled })
  }

  return json({ error: 'bad_action', detail: "action must be 'get' or 'set'" }, 400)
})
