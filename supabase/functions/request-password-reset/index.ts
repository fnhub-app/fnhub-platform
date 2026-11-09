// ============================================================================
// request-password-reset - PUBLIC self-service "Forgot password" sender.
//
// The sign-in page's Forgot Password flow used to call /auth/v1/recover, which
// depends on the Supabase auth mailer this project does not configure - the
// request returned 200 but no email ever arrived. This function replaces it:
// it generates the recovery link server-side (admin.generateLink, which sends
// NO Supabase email) and emails it through the nation's own branded pipeline
// (_shared/email.ts - same per-nation provider as every other app email).
//
// POST { email, redirect_to?, brand_color?, nation_name? }
// Auth: PUBLIC - the sign-in page has no user JWT, so the caller sends the
// project ANON key as the bearer (passes gateway JWT verification), same as
// the tenant-mr intake. Defenses, in order:
//   - anti-enumeration: ALWAYS returns { ok: true } for a well-formed request,
//     whether or not the email maps to a staff account (mirrors /auth/v1/
//     recover semantics; the UI wording is already "if registered...").
//   - only ACTIVE staff emails are ever sent a link (service-role lookup).
//   - throttle: max 2 sends per email per 10 minutes, counted from the
//     password_reset_issued audit rows (shared with the admin Send Reset
//     button in Settings -> Users, so the two paths share one budget).
//     Exceeding it returns ok WITHOUT sending - no mail-bombing, no signal.
//   - redirect_to is format-checked here; GoTrue additionally enforces the
//     dashboard Redirect URLs allowlist when minting the link.
// Every actual send writes a password_reset_issued audit row (service role).
// Source must stay ASCII-only.
// ============================================================================

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { sendEmail, renderBrandedEmail, emailConfigured, isValidEmail, escapeHtml, isSafeRedirect, readableTextColor, setBrandOverrides } from '../_shared/email.ts'

const SUPABASE_URL         = Deno.env.get('SUPABASE_URL')
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')

const THROTTLE_WINDOW_MIN = 10
const THROTTLE_MAX_SENDS  = 2

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
function json(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } })
}
// Generic success - the one answer every non-config outcome returns, so the
// response never reveals whether an account exists.
function okSilent(): Response { return json({ ok: true }) }

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  try {
    if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return json({ error: 'Server not configured' }, 500)
    // Without email secrets we cannot deliver anything - tell the CLIENT so it
    // can fall back to the legacy /auth/v1/recover path (config state is not
    // user data, so this does not leak anything about accounts).
    if (!emailConfigured()) return json({ ok: false, error: 'Email is not configured for this nation.' }, 503)

    const body = await req.json().catch(() => ({}))
    setBrandOverrides({ brand: body.brand || body.nation_name, brandColor: body.brand_color, logoUrl: body.logo_url, contactLine: body.contact_line })
    const email = String(body.email || '').toLowerCase().trim()
    if (!isValidEmail(email)) return json({ error: 'A valid email is required.' }, 400)
    // Host-allowlisted like the sibling functions (shared isSafeRedirect) --
    // the old bare https?:// format check accepted arbitrary hosts.
    const redirectRaw = String(body.redirect_to || '').trim().slice(0, 400)
    const redirectTo = isSafeRedirect(redirectRaw) ? redirectRaw : ''
    const nationName = String(body.nation_name || '').slice(0, 120)
    const brandColorRaw = String(body.brand_color || '').trim()
    const btnColor = /^#[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/.test(brandColorRaw) ? brandColorRaw : '#eab308'

    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)

    // Small per-IP budget on top of the per-email throttle below, so rotating
    // target emails can't be used to probe or mail-bomb from one source.
    // Rides the magic_link_requests table; degrades open if it's absent.
    try {
      const ip = (req.headers.get('cf-connecting-ip') || req.headers.get('x-forwarded-for') || '').split(',')[0].trim()
      if (ip) {
        const ipSince = new Date(Date.now() - THROTTLE_WINDOW_MIN * 60000).toISOString()
        const { count: ipCount } = await admin.from('magic_link_requests')
          .select('id', { count: 'exact', head: true }).eq('ip', ip).gte('created_at', ipSince)
        if ((ipCount || 0) >= 10) return okSilent()
        await admin.from('magic_link_requests').insert({ email, ip })
      }
    } catch (_e) { /* table not created yet -- skip limiting rather than break */ }

    // Only active staff get reset emails. Anything else: silent ok.
    // Case-insensitive with the email treated as a LITERAL (escaped LIKE
    // wildcards) -- a mixed-case staff.email row silently never received
    // resets under the old case-sensitive eq.
    const emailLit = email.replace(/[\\%_]/g, (c: string) => '\\' + c)
    const { data: rows } = await admin.from('staff')
      .select('name, is_active').ilike('email', emailLit).limit(1)
    if (!rows || !rows.length || !rows[0].is_active) return okSilent()
    const staffName = String(rows[0].name || '')

    // Throttle on the audit trail the sends themselves write. Counts the admin
    // Send Reset button's rows too (send-magic-link uses the same action), so
    // a person cannot be mail-bombed through either path.
    const sinceIso = new Date(Date.now() - THROTTLE_WINDOW_MIN * 60000).toISOString()
    const { count } = await admin.from('housing_audit_log')
      .select('id', { count: 'exact', head: true })
      .eq('action', 'password_reset_issued').eq('entity_id', email)
      .gte('created_at', sinceIso)
    if ((count || 0) >= THROTTLE_MAX_SENDS) return okSilent()

    // Mint the recovery link (sends NO Supabase email). Fails when the staff
    // row has no auth account yet - silent ok (nothing to reset; the admin
    // path in Settings -> Users surfaces that case honestly instead).
    const gen = await admin.auth.admin.generateLink({
      type: 'recovery',
      email,
      options: redirectTo ? { redirectTo } : {},
    })
    const actionLink = (gen && gen.data && (gen.data as any).properties && (gen.data as any).properties.action_link) || ''
    if (gen.error || !actionLink) return okSilent()

    const subject = 'Reset your password - ' + (nationName || 'Housing')
    const inner =
      '<p style="font-size:14px;line-height:1.65;color:#374151;margin:0 0 20px;">' +
      (staffName ? 'Hi ' + escapeHtml(staffName) + ',<br/>' : '') +
      'A password reset was requested for your ' + escapeHtml(nationName || 'Housing') +
      ' Housing account. Click below to choose a new password. This link is single-use and expires shortly.</p>' +
      '<table role="presentation" cellpadding="0" cellspacing="0"><tr><td style="border-radius:8px;background:' + btnColor + ';">' +
      '<a href="' + escapeHtml(actionLink) + '" style="display:inline-block;padding:12px 28px;font-size:14px;font-weight:700;color:' + readableTextColor(btnColor) + ';text-decoration:none;border-radius:8px;">Reset password</a>' +
      '</td></tr></table>' +
      '<p style="font-size:12px;line-height:1.6;color:#6b7280;margin:18px 0 0;">If you did not request this, you can ignore this email - your password is unchanged and no one can use the link without access to this inbox.</p>'

    await sendEmail({ to: email, to_name: staffName, subject, html: renderBrandedEmail(subject, inner) })

    // Audited AFTER the send succeeds - the row doubles as the throttle
    // record, so a failed provider call must not consume the budget.
    try {
      await admin.from('housing_audit_log').insert({
        entity_type: 'auth', entity_id: email,
        action: 'password_reset_issued',
        detail: 'Password reset link issued for ' + email + ' (self-service Forgot Password)',
        actor: 'self-service',
      })
    } catch (_e) { /* audit is best-effort, never blocks the response */ }

    return okSilent()
  } catch (err) {
    console.warn('[request-password-reset] ' + (err as Error).message)
    // A provider failure still answers generically - the client falls back to
    // the legacy recover endpoint only on explicit not-ok/config responses.
    return json({ error: 'Could not process the request.' }, 500)
  }
})
