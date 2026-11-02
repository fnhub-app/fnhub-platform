// MFA admin reset - Supabase Edge Function (per nation).
// An Executive Director / super user removes ANOTHER staff member's two-factor
// factors (authenticator app or phone), so a lost or replaced device cannot
// permanently lock that person out once 2FA is enforced.
//
// Security: requires a valid caller JWT (the browser sends the signed-in user's
// access token). The caller must be ACTIVE ed/super_user staff; the target must
// be a known staff email of this nation. Removing another user's factor needs
// admin rights, so this runs with the service-role key -- which exists only
// inside the function, never in the browser.
//
// Deploy: auto-deploys via deploy-supabase-functions.yml (watches
// supabase/functions/**). Source must stay ASCII-only.

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const SUPABASE_URL         = Deno.env.get('SUPABASE_URL')
const SUPABASE_ANON_KEY    = Deno.env.get('SUPABASE_ANON_KEY')
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

function json(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } })
}

function normRole(r: string): string {
  const v = (r || '').toLowerCase().trim()
  if (v === 'hm' || v === 'manager') return 'housing_manager'
  return v
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  try {
    if (!SUPABASE_URL || !SUPABASE_ANON_KEY) return json({ error: 'Supabase env not configured' }, 500)
    if (!SUPABASE_SERVICE_KEY) return json({ error: 'Service role key not configured on this function' }, 500)

    // --- Auth: require a valid Supabase user JWT (not the anon key) ---
    const authHeader = req.headers.get('Authorization') || ''
    if (!authHeader.startsWith('Bearer ')) return json({ error: 'Missing or malformed Authorization header' }, 401)
    const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { global: { headers: { Authorization: authHeader } } })
    const { data: { user }, error: authErr } = await userClient.auth.getUser()
    if (authErr || !user) return json({ error: 'Unauthorized' }, 401)

    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)

    // --- Caller must be active ed / super_user ---
    const callerEmail = (user.email || '').toLowerCase()
    const { data: callerRows } = await admin.from('staff').select('role').eq('email', callerEmail).eq('is_active', true).limit(1)
    const callerRole = (callerRows && callerRows.length) ? normRole((callerRows[0] as { role?: string }).role || '') : ''
    if (callerRole !== 'ed' && callerRole !== 'super_user') {
      return json({ error: 'Only the Executive Director can reset two-factor.' }, 403)
    }

    const body = await req.json().catch(() => ({})) as { email?: string }
    const targetEmail = (body.email || '').toLowerCase().trim()
    if (!targetEmail) return json({ error: 'Missing target email' }, 400)

    // --- Target must be a known staff member of this nation ---
    const { data: tgtRows } = await admin.from('staff').select('email').ilike('email', targetEmail).limit(1)
    if (!tgtRows || !tgtRows.length) return json({ error: 'No staff member found for that email' }, 404)

    // --- Find the target auth user by email (paginate; staff lists are small) ---
    let targetId = ''
    for (let page = 1; page <= 25 && !targetId; page++) {
      const { data: list, error: lErr } = await admin.auth.admin.listUsers({ page, perPage: 1000 })
      if (lErr) return json({ error: 'Could not list users', detail: lErr.message }, 500)
      const users = (list && list.users) || []
      const hit = users.find((u: { email?: string }) => (u.email || '').toLowerCase() === targetEmail)
      if (hit) targetId = (hit as { id: string }).id
      if (users.length < 1000) break
    }
    if (!targetId) return json({ error: 'No sign-in account found for that email yet' }, 404)

    // --- Read the user's factors, then delete each (raw GoTrue admin REST) ---
    const ur = await fetch(SUPABASE_URL + '/auth/v1/admin/users/' + encodeURIComponent(targetId), {
      headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: 'Bearer ' + SUPABASE_SERVICE_KEY },
    })
    const ud = await ur.json().catch(() => ({})) as { factors?: { id: string }[] }
    const factors = (ud && ud.factors) || []
    let removed = 0
    for (const f of factors) {
      const dr = await fetch(SUPABASE_URL + '/auth/v1/admin/users/' + encodeURIComponent(targetId) + '/factors/' + encodeURIComponent(f.id), {
        method: 'DELETE',
        headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: 'Bearer ' + SUPABASE_SERVICE_KEY },
      })
      if (dr.ok) removed++
    }

    // --- Append-only audit row (mirrors the client auditEntry shape) ---
    try {
      await admin.from('housing_audit_log').insert({
        entity_type: 'STAFF',
        entity_id: targetEmail,
        action: 'mfa_admin_reset',
        detail: JSON.stringify({ detail: 'Two-factor reset by ' + callerEmail + ' (' + removed + ' factor(s) removed)', by: callerEmail, removed }),
        actor: callerEmail,
      })
    } catch (_e) { /* audit is best-effort, never block the reset */ }

    return json({ ok: true, removed })
  } catch (e) {
    return json({ error: 'Reset failed', detail: (e as Error) && (e as Error).message }, 500)
  }
})
