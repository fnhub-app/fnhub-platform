// support-login - NATION-side support impersonation (SUPER-ADMIN-PLAN 12.3).
//
// Deploy on EACH nation's own Supabase project, WITHOUT JWT verification (it is
// called server-to-server by the control-plane `enter-nation` function):
//   supabase functions deploy support-login --project-ref <nation-ref> --no-verify-jwt
//
// Trust model: ASYMMETRIC. The only thing that grants entry is a valid ES256
// token signed by the control plane with THIS nation's private key; this function
// verifies it with SUPPORT_LOGIN_PUBKEY (this nation's PUBLIC key -- safe to hold,
// useless if stolen). No shared secret. The operator email + redirect target are
// carried in the SIGNED claims, so they cannot be tampered.
//
// On a valid token it:
//   1. Refuses if the nation opted OUT (housing_settings.support_login_enabled=false).
//   2. Ensures a "Platform Support" auth user + ACTIVE, magic-link, super_user
//      staff row (access_expires_at = today).
//   3. Mints a short-lived magic link back to the nation app.
//   4. Writes an append-only housing_audit_log row.
//   5. Best-effort: emails the nation's ED(s) that a support session started,
//      using THIS nation's own email provider (skipped silently if email is not
//      configured on this project).
//   6. Returns { action_link }.
//
// Secrets required on the nation project:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY   (auto-injected)
//   SUPPORT_LOGIN_PUBKEY                       (this nation's PUBLIC JWK, JSON)
//   (email provider secrets, optional -- used for the ED notification only)
// Source ASCII-only.

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { verifyEs256 } from '../_shared/jose.ts'
import { emailConfigured, sendEmailSerially, renderBrandedEmail, escapeHtml, isValidEmail } from '../_shared/email.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || ''
const SERVICE_KEY  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || ''
const PUBKEY_RAW   = Deno.env.get('SUPPORT_LOGIN_PUBKEY') || ''

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-support-token',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
function json(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } })
}
function todayIso(): string { return new Date().toISOString().slice(0, 10) }
const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
// 'YYYY-MM-DD' -> 'Aug 19, 2026'
function prettyDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || '')
  if (!m) return iso
  return MONTHS[(+m[2]) - 1] + ' ' + (+m[3]) + ', ' + m[1]
}
function safeRedirect(u: string): string {
  try {
    const url = new URL(String(u || ''))
    if (url.protocol !== 'https:') return ''
    if (url.hostname !== 'fnhub.app' && !url.hostname.endsWith('.fnhub.app')) return ''
    return url.toString()
  } catch (_e) { return '' }
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  if (req.method !== 'POST')    return json({ error: 'method_not_allowed' }, 405)
  if (!SUPABASE_URL || !SERVICE_KEY) return json({ error: 'not_configured' }, 500)
  if (!PUBKEY_RAW) return json({ error: 'pubkey_not_set',
    message: 'SUPPORT_LOGIN_PUBKEY is not set on this project. Generate a key in the admin panel and paste the public JWK here.' }, 500)

  let pubJwk: any = null
  try { pubJwk = JSON.parse(PUBKEY_RAW) } catch (_e) { return json({ error: 'pubkey_invalid' }, 500) }

  // Verify the signed entry token (only the control plane holds the private key).
  const claims = await verifyEs256(req.headers.get('x-support-token') || '', pubJwk)
  if (!claims) return json({ error: 'forbidden' }, 403)

  const operator = String(claims.op || '').trim().toLowerCase()
  if (!isValidEmail(operator)) return json({ error: 'bad_operator' }, 400)
  const redirectTo = safeRedirect(claims.rt)
  if (!redirectTo) return json({ error: 'bad_redirect' }, 400)

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } })

  // 1. Nation opt-out (OCAP consent). Default ENABLED unless explicitly false.
  try {
    const { data: st } = await admin.from('housing_settings').select('value').eq('key', 'support_login_enabled').limit(1)
    if (st && st.length) {
      const v: any = st[0].value
      const enabled = (v && typeof v === 'object') ? v.enabled !== false : v !== false
      if (!enabled) return json({ error: 'support_disabled',
        message: 'This nation has turned off platform support login. Ask the nation to re-enable it in Settings.' }, 403)
    }
  } catch (_e) { /* settings unreadable -> do not block; a broken project still needs support */ }

  // 2. Ensure the auth user + ACTIVE magic-link super_user staff row.
  try {
    const { error: cuErr } = await admin.auth.admin.createUser({ email: operator, email_confirm: true })
    if (cuErr && !/registered|exists|duplicate/i.test(cuErr.message || '')) {
      return json({ error: 'create_user_failed', detail: cuErr.message }, 500)
    }
  } catch (e) { return json({ error: 'create_user_failed', detail: String(e && (e as Error).message || e) }, 500) }

  const staffRow = {
    name: 'Platform Support', email: operator, role: 'super_user',
    department: 'Platform Support', is_active: true, magic_link: true, access_expires_at: todayIso(),
  }
  try {
    const { data: ex } = await admin.from('staff').select('id').eq('email', operator).limit(1)
    if (ex && ex.length) await admin.from('staff').update(staffRow).eq('email', operator)
    else                 await admin.from('staff').insert(staffRow)
  } catch (e) { return json({ error: 'staff_upsert_failed', detail: String(e && (e as Error).message || e) }, 500) }

  // 3. Mint the magic link back to the nation app.
  let actionLink = ''
  try {
    const { data, error } = await admin.auth.admin.generateLink({ type: 'magiclink', email: operator, options: { redirectTo } })
    actionLink = (data && (data as any).properties && (data as any).properties.action_link) || ''
    if (error || !actionLink) return json({ error: 'link_failed', detail: (error && error.message) || 'no action_link' }, 500)
  } catch (e) { return json({ error: 'link_failed', detail: String(e && (e as Error).message || e) }, 500) }

  // 4. Audit (append-only; awaited so it lands before we return).
  try {
    const sentence = 'Platform support session opened by ' + operator
      + ' - full super-user access through ' + prettyDate(staffRow.access_expires_at) + ' (end of day).'
    await admin.from('housing_audit_log').insert({
      action: 'support_session_started', actor: operator, entity_type: 'support', entity_id: 'SUPPORT',
      // `detail` is the clean line the audit UI shows; the rest is kept for forensics.
      detail: JSON.stringify({ detail: sentence, summary: sentence, role: 'super_user',
        access_expires_at: staffRow.access_expires_at, redirect_to: redirectTo, jti: claims.jti || null }),
    })
  } catch (_e) { /* never block the login on an audit hiccup */ }

  // 5. Notify the nation's ED(s) -- best-effort, using THIS nation's own email
  //    provider. Silently skipped if the nation has not configured email yet.
  let edNotified = 0
  try {
    if (emailConfigured()) {
      const { data: eds } = await admin.from('staff').select('email, name').eq('role', 'ed').eq('is_active', true)
      const recips = (eds || []).filter((r: any) => isValidEmail(r.email)).map((r: any) => ({ to: r.email, to_name: r.name || '' }))
      if (recips.length) {
        const when = new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC'
        const inner = '<p>A <b>Nation Pathways platform support</b> session was just opened on your housing app.</p>'
          + '<ul style="font-size:14px;color:#333;line-height:1.6;">'
          + '<li><b>By:</b> ' + escapeHtml(operator) + '</li>'
          + '<li><b>When:</b> ' + escapeHtml(when) + '</li>'
          + '<li><b>Access:</b> full (super user), ending ' + escapeHtml(staffRow.access_expires_at) + '</li>'
          + '</ul>'
          + '<p style="font-size:13px;color:#555;">This is expected when you have asked for support. If you did not, or want to stop platform support access, turn off <b>Settings -> Admin -> Config -> Platform Support Access</b>. Every session also appears in your Audit Log.</p>'
        edNotified = await sendEmailSerially(recips, function(){
          return { subject: 'Platform support session opened on your housing app',
            html: renderBrandedEmail('Platform support session opened', inner) }
        })
      }
    }
  } catch (_e) { /* notification is best-effort; never block the login */ }

  return json({ ok: true, action_link: actionLink, operator: operator,
    access_expires_at: staffRow.access_expires_at, ed_notified: edNotified })
})
