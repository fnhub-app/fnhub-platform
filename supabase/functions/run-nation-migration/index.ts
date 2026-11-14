// run-nation-migration - FN Hub control plane (fleet schema updates).
//
// Deploy on the fnhub-platform project WITH JWT verification:
//   supabase functions deploy run-nation-migration --project-ref <platform-ref>
//
// SUPER-ADMIN ONLY. Applies ONE SQL migration to many nation projects at once
// via the Supabase Management API (the same mechanism provision-nation uses),
// so a schema update doesn't have to be pasted into 100 SQL editors by hand.
//
// Input JSON:
//   { migration?: string,   // repo filename under supabase/migrations/ (fetched from GitHub raw)
//     sql?: string,         // OR raw SQL to run (migration is then just a ledger label)
//     targets?: string[],   // subdomains to run against; omit/empty = all ACTIVE nations w/ a project
//     dryRun?: boolean,     // report what WOULD run (and who already has it) without executing
//     force?: boolean }     // re-run even where the ledger says 'applied'
//
// Safety: super_admins-gated, never targets the control-plane project itself,
// records every run in nation_migrations + platform_audit. Idempotent migrations
// (CREATE ... IF NOT EXISTS, add-column-if-not-exists) are safe to re-run.
//
// Secrets: SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY (auto) +
//   SB_MGMT_TOKEN (Management API; already set for provision-nation).
// Source ASCII-only.

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || ''
const ANON_KEY     = Deno.env.get('SUPABASE_ANON_KEY') || ''
const SERVICE_KEY  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || ''
const MGMT_TOKEN   = Deno.env.get('SB_MGMT_TOKEN') || Deno.env.get('SUPABASE_MGMT_TOKEN') || ''
const MGMT_BASE    = 'https://api.supabase.com'
const REPO_RAW     = Deno.env.get('MIGRATIONS_RAW_BASE') ||
  'https://raw.githubusercontent.com/fnhub-app/fnhub-platform/main/supabase/migrations/'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
function json(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } })
}
const MIG_RE = /^[A-Za-z0-9._-]+$/                       // safe migration filename
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
    const u = await r.json(); email = String((u && u.email) || '').toLowerCase()
  } catch (_e) { return null }
  if (!email) return null
  const { data } = await admin.from('super_admins').select('email').ilike('email', email).limit(1)
  return (data && data.length) ? email : null
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  if (req.method !== 'POST')    return json({ error: 'method_not_allowed' }, 405)
  if (!SUPABASE_URL || !SERVICE_KEY) return json({ error: 'not_configured' }, 500)
  if (!MGMT_TOKEN) return json({ error: 'mgmt_token_not_set',
    message: 'SB_MGMT_TOKEN is not set on the platform project. It is required to run SQL on nation projects.' }, 500)

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } })
  const actor = await authorizeSuperAdmin(admin, (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, ''))
  if (!actor) return json({ error: 'forbidden' }, 403)

  let body: any = {}
  try { body = await req.json() } catch (_e) { return json({ error: 'bad_json' }, 400) }
  const migration = String(body.migration || '').trim()
  let sql = typeof body.sql === 'string' ? body.sql : ''
  const dryRun = !!body.dryRun
  const force  = !!body.force
  const wantTargets: string[] = Array.isArray(body.targets) ? body.targets.map((s: any) => String(s).toLowerCase()) : []

  if (!migration && !sql) return json({ error: 'nothing_to_run', message: 'Provide a migration filename or raw sql.' }, 400)
  if (migration && !MIG_RE.test(migration)) return json({ error: 'bad_migration_name' }, 400)
  // A ledger label is required so coverage is trackable.
  const ledgerName = migration || ('adhoc:' + (String(body.label || '').trim() || new Date().toISOString().slice(0, 19)))

  // Resolve the SQL: explicit sql wins; else fetch the repo file.
  if (!sql && migration) {
    try {
      const gr = await fetch(REPO_RAW + migration)
      if (!gr.ok) return json({ error: 'migration_fetch_failed', message: 'Could not fetch ' + migration + ' (HTTP ' + gr.status + ').' }, 400)
      sql = await gr.text()
    } catch (e) { return json({ error: 'migration_fetch_failed', detail: String(e && (e as Error).message || e) }, 400) }
  }
  if (!sql.trim()) return json({ error: 'empty_sql' }, 400)

  const PLATFORM_REF = refFromUrl(SUPABASE_URL)

  // Explicit opt-in: run the pasted SQL on the CONTROL-PLANE project itself
  // (the supabase/platform/*.sql family: nations, nation_usage, billing,
  // reseller tables). Raw SQL only -- supabase/migrations/ holds NATION
  // schema, so a migration filename makes no sense here. Ledgered under the
  // pseudo-subdomain '_platform'; audited as platform_migration.
  if (body.platform === true) {
    if (migration) return json({ error: 'platform_takes_raw_sql',
      message: 'Platform mode runs pasted SQL only. supabase/migrations/ files are nation schema; paste the platform SQL instead.' }, 400)
    if (!PLATFORM_REF) return json({ error: 'platform_ref_unresolved' }, 500)
    if (dryRun) return json({ ok: true, migration: ledgerName, dryRun: true, count: 1,
      results: [{ subdomain: '_platform', status: 'would_run', detail: 'control-plane project' }] })
    let pOk = false, pDetail = ''
    try {
      const pr = await fetch(MGMT_BASE + '/v1/projects/' + encodeURIComponent(PLATFORM_REF) + '/database/query', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + MGMT_TOKEN, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: sql + "\n;\nnotify pgrst, 'reload schema';" }),
      })
      pOk = pr.ok
      pDetail = pOk ? 'applied' : ('Management API ' + pr.status + ': ' + (await pr.text()).slice(0, 300))
    } catch (e) { pDetail = String(e && (e as Error).message || e) }
    try {
      await admin.from('nation_migrations').upsert(
        { subdomain: '_platform', migration: ledgerName, status: pOk ? 'applied' : 'failed', detail: pOk ? null : pDetail, applied_by: actor, applied_at: new Date().toISOString() },
        { onConflict: 'subdomain,migration' })
    } catch (_e) { /* ledger best-effort */ }
    try {
      await admin.from('platform_audit').insert({
        action: 'platform_migration', subdomain: null,
        detail: actor + ' ran ' + ledgerName + ' on the control-plane project: ' + (pOk ? 'applied' : 'failed'),
      })
    } catch (_e) { /* audit best-effort */ }
    return json({ ok: true, migration: ledgerName, dryRun: false, count: 1,
      results: [{ subdomain: '_platform', status: pOk ? 'applied' : 'failed', detail: pDetail }] })
  }

  // Enumerate targets: active nations with a project, minus the control plane.
  const { data: nations, error: nErr } = await admin
    .from('nations').select('subdomain, display_name, supabase_url, status')
  if (nErr) return json({ error: 'lookup_failed', detail: nErr.message }, 500)
  let list = (nations || []).filter((n: any) => refFromUrl(n.supabase_url || ''))
  if (wantTargets.length) list = list.filter((n: any) => wantTargets.indexOf(String(n.subdomain).toLowerCase()) !== -1)
  else list = list.filter((n: any) => n.status === 'active')

  // Already-applied set for this ledger name.
  const appliedSet: Record<string, boolean> = {}
  try {
    const { data: rows } = await admin.from('nation_migrations').select('subdomain, status').eq('migration', ledgerName)
    for (const r of (rows || [])) if (r.status === 'applied') appliedSet[String(r.subdomain).toLowerCase()] = true
  } catch (_e) { /* ledger may not exist yet -> treat as none applied */ }

  const results: any[] = []
  for (const n of list) {
    const sub = String(n.subdomain).toLowerCase()
    const ref = refFromUrl(n.supabase_url || '')
    if (ref && PLATFORM_REF && ref === PLATFORM_REF) { results.push({ subdomain: sub, status: 'skipped', detail: 'control-plane project' }); continue }
    const already = !!appliedSet[sub]
    if (already && !force) { results.push({ subdomain: sub, status: 'skipped', detail: 'already applied' }); continue }
    if (dryRun) { results.push({ subdomain: sub, status: 'would_run', detail: already ? 're-run (force)' : 'pending' }); continue }

    try {
      const r = await fetch(MGMT_BASE + '/v1/projects/' + encodeURIComponent(ref) + '/database/query', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + MGMT_TOKEN, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: sql + "\n;\nnotify pgrst, 'reload schema';" }),
      })
      const ok = r.ok
      const detail = ok ? 'applied' : ('Management API ' + r.status + ': ' + (await r.text()).slice(0, 300))
      // Record in the ledger (upsert on subdomain+migration).
      try {
        await admin.from('nation_migrations').upsert(
          { subdomain: sub, migration: ledgerName, status: ok ? 'applied' : 'failed', detail: ok ? null : detail, applied_by: actor, applied_at: new Date().toISOString() },
          { onConflict: 'subdomain,migration' })
      } catch (_e) { /* ledger best-effort */ }
      results.push({ subdomain: sub, status: ok ? 'applied' : 'failed', detail })
    } catch (e) {
      results.push({ subdomain: sub, status: 'failed', detail: String(e && (e as Error).message || e) })
    }
  }

  if (!dryRun) {
    const ok = results.filter((r) => r.status === 'applied').length
    const failed = results.filter((r) => r.status === 'failed').length
    try {
      await admin.from('platform_audit').insert({
        action: 'fleet_migration', subdomain: null,
        detail: actor + ' ran ' + ledgerName + ' on ' + results.length + ' nation(s): ' + ok + ' applied, ' + failed + ' failed',
      })
    } catch (_e) { /* audit best-effort */ }
  }

  return json({ ok: true, migration: ledgerName, dryRun, count: results.length, results })
})
