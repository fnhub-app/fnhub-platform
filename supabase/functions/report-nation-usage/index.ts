// report-nation-usage - FN Hub control plane (per-nation usage, push model).
//
// Deploy on the fnhub-platform project, WITHOUT JWT verification (the caller
// holds a NATION user token, signed by the nation's project, which the platform
// gateway cannot validate):
//   supabase functions deploy report-nation-usage \
//     --project-ref <platform-ref> --no-verify-jwt
//
// Flow: a nation manager's browser POSTs { subdomain } with their nation access
// token in Authorization. This function:
//   1. looks up the nation's Supabase URL + anon key from the control-plane
//      `nations` registry (service_role read), then
//   2. calls that nation's OWN management-gated hs_data_usage() RPC with the
//      caller's token. If the nation's gate accepts it, the caller is proven to
//      be a management user of that nation AND we get authoritative byte counts
//      straight from the nation's database (never client-supplied), then
//   3. upserts the numbers into control-plane `nation_usage` (service_role).
// Any failure is reported back plainly; nothing is written unless step 2 passed.
//
// Secrets required on the platform project (auto-injected):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
// Source ASCII-only.

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || ''
const SERVICE_KEY  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || ''

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
function json(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } })
}
function trimSlash(s: string): string { return String(s || '').replace(/\/+$/, '') }

const SUB_RE = /^[a-z0-9](?:[a-z0-9-]{0,40}[a-z0-9])?$/

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  if (req.method !== 'POST')    return json({ error: 'method_not_allowed' }, 405)
  if (!SUPABASE_URL || !SERVICE_KEY) return json({ error: 'not_configured' }, 500)

  const token = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '')
  if (!token) return json({ error: 'missing_token' }, 401)

  let body: any = {}
  try { body = await req.json() } catch (_e) { return json({ error: 'bad_json' }, 400) }
  const sub = String(body.subdomain || '').trim().toLowerCase()
  if (!SUB_RE.test(sub)) return json({ error: 'bad_subdomain' }, 400)

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } })

  // 1) Resolve the nation's project from the registry.
  const { data: rows } = await admin
    .from('nations')
    .select('subdomain, supabase_url, supabase_anon')
    .eq('subdomain', sub)
    .limit(1)
  const nation = rows && rows[0]
  if (!nation || !nation.supabase_url || !nation.supabase_anon) {
    return json({ error: 'unknown_nation' }, 404)
  }

  // 2) Verify the caller AND fetch authoritative numbers via the nation's own
  //    management-gated function, using the caller's token. Nation RLS is the
  //    gate: a non-management (or non-staff) caller is rejected there.
  const nurl = trimSlash(nation.supabase_url)
  let usage: any = null
  let callerEmail = ''
  try {
    const r = await fetch(nurl + '/rest/v1/rpc/hs_data_usage', {
      method: 'POST',
      headers: {
        apikey: nation.supabase_anon,
        Authorization: 'Bearer ' + token,
        'Content-Type': 'application/json',
      },
      body: '{}',
    })
    if (r.status === 401 || r.status === 403) return json({ error: 'forbidden' }, 403)
    if (!r.ok) return json({ error: 'nation_usage_unavailable', status: r.status }, 502)
    usage = await r.json()
  } catch (_e) {
    return json({ error: 'nation_unreachable' }, 502)
  }
  if (!usage || typeof usage.database_bytes === 'undefined') {
    return json({ error: 'nation_usage_unavailable' }, 502)
  }

  // Best-effort: who reported (for display). Never blocks the write.
  try {
    const u = await fetch(nurl + '/auth/v1/user', {
      headers: { apikey: nation.supabase_anon, Authorization: 'Bearer ' + token },
    })
    if (u.ok) { const j = await u.json(); callerEmail = String((j && j.email) || '').toLowerCase() }
  } catch (_e) { /* ignore */ }

  // 3) Upsert into the control plane. AI token totals (this calendar month) ride
  //    along from hs_data_usage so the admin panel can price per-nation AI cost.
  const row = {
    subdomain: sub,
    database_bytes: usage.database_bytes == null ? null : Number(usage.database_bytes),
    storage_bytes:  usage.storage_bytes  == null ? null : Number(usage.storage_bytes),
    ai_input_tokens:  usage.ai_input_tokens  == null ? null : Number(usage.ai_input_tokens),
    ai_output_tokens: usage.ai_output_tokens == null ? null : Number(usage.ai_output_tokens),
    reported_by: callerEmail || null,
    reported_at: new Date().toISOString(),
  }
  const { error } = await admin.from('nation_usage').upsert(row, { onConflict: 'subdomain' })
  if (error) return json({ error: 'write_failed', detail: String(error.message || error) }, 500)

  return json({ ok: true, subdomain: sub, database_bytes: row.database_bytes, storage_bytes: row.storage_bytes, ai_input_tokens: row.ai_input_tokens, ai_output_tokens: row.ai_output_tokens })
})
