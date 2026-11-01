// set-nation-secret - FN Hub control plane.
//
// Lets a super-admin set a nation's Anthropic API key (and other allowed Edge
// Function secrets) on that nation's OWN Supabase project via the Management
// API, from the admin portal. The key is written straight into the nation
// project's function secrets and is NEVER stored in full on the control plane
// or returned to the browser -- only a masked last-4 + timestamp is recorded on
// the nations row so the admin UI can show "key set".
//
// Deploy on the fnhub-platform project (JWT verification can stay ON or OFF;
// this function verifies the caller's token itself against super_admins):
//   supabase functions deploy set-nation-secret --project-ref <platform-ref>
//
// Secrets required on the platform project (auto-injected + one manual):
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

// Only these secret names may be set through this endpoint.
// - ANTHROPIC_API_KEY: the AI Assistant key card.
// - EMAIL_*/RESEND/SENDGRID: the Email tab's "Apply to project" button, so
//   email onboarding for a nation is one screen instead of a dashboard visit.
//   GRAPH_* is deliberately NOT settable here: those are a nation's own Entra
//   tenant credentials, provisioned by that tenant's admin in their dashboard.
// - SMS_*/TWILIO_*: the SMS & Portal tab's "Apply to project" button, so the
//   send-sms notification sender is set from the panel. These are the
//   NOTIFICATION sender only; the Contractor Portal LOGIN uses Supabase phone
//   auth (Twilio Verify), configured in the nation's dashboard, not here.
const ALLOWED = new Set([
  'ANTHROPIC_API_KEY',
  'EMAIL_PROVIDER', 'EMAIL_FROM', 'EMAIL_FROM_NAME', 'EMAIL_REPLY_TO', 'EMAIL_BRAND',
  'RESEND_API_KEY', 'SENDGRID_API_KEY',
  'SMS_PROVIDER', 'TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'SMS_FROM', 'TWILIO_MESSAGING_SERVICE_SID',
])
// Secrets that are credentials (enforce a minimum length); the rest are plain
// config values ('resend', 'twilio', an email address, a phone number) that
// just need to be non-empty.
const KEY_LIKE = new Set(['ANTHROPIC_API_KEY', 'RESEND_API_KEY', 'SENDGRID_API_KEY', 'TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN'])

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

  // Accept a single { name, value } (the AI-key card) or a batch
  // { secrets: [{ name, value }, ...] } (the Email tab's Apply button).
  let entries: Array<{ name: string; value: string }>
  if (Array.isArray(body.secrets)) {
    entries = body.secrets.map((s: any) => ({ name: String((s && s.name) || '').trim(), value: String((s && s.value) || '') }))
  } else {
    entries = [{ name: String(body.name || 'ANTHROPIC_API_KEY').trim(), value: String(body.value || '') }]
  }
  if (!entries.length || entries.length > 10) return json({ error: 'bad_secret_count' }, 400)
  for (const e of entries) {
    if (!ALLOWED.has(e.name)) return json({ error: 'secret_not_allowed', name: e.name }, 400)
    if (!e.value) return json({ error: 'missing_value', name: e.name }, 400)
    if (KEY_LIKE.has(e.name) && e.value.length < 8) return json({ error: 'missing_or_short_value', name: e.name }, 400)
  }

  // Resolve the nation's project ref from the registry.
  const { data: rows } = await admin.from('nations').select('subdomain, supabase_url').eq('subdomain', sub).limit(1)
  const nation = rows && rows[0]
  if (!nation) return json({ error: 'nation_not_found' }, 404)
  const ref = refFromUrl(nation.supabase_url || '')
  if (!ref) return json({ error: 'nation_has_no_project' }, 400)

  // Set the secret(s) on the nation's project via the Management API.
  const setRes = await fetch(MGMT_BASE + '/v1/projects/' + ref + '/secrets', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + MGMT_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify(entries),
  })
  if (!setRes.ok) {
    const t = await setRes.text().catch(() => '')
    return json({ error: 'mgmt_set_secret_failed', status: setRes.status, detail: t.slice(0, 300) }, 502)
  }

  // Record a masked marker on the nations row (never the full key) - AI key only.
  const aiEntry = entries.find((e) => e.name === 'ANTHROPIC_API_KEY')
  const last4 = aiEntry ? aiEntry.value.slice(-4) : ''
  if (aiEntry) {
    try {
      await admin.from('nations').update({ ai_key_last4: last4, ai_key_updated_at: new Date().toISOString() }).eq('subdomain', sub)
    } catch (_e) { /* marker is best-effort */ }
  }

  // Audit (best-effort). Never the values - only which names were set.
  const names = entries.map((e) => e.name).join(', ')
  const isSms = entries.some((e) => e.name === 'SMS_PROVIDER' || e.name.indexOf('TWILIO_') === 0)
  const auditAction = aiEntry ? 'nation_ai_key_set' : (isSms ? 'nation_sms_secrets_set' : 'nation_email_secrets_set')
  try {
    await admin.from('platform_audit').insert({
      action: auditAction,
      subdomain: sub,
      detail: names + ' set by ' + caller + (last4 ? ' (...' + last4 + ')' : ''),
    })
  } catch (_e) { /* ignore */ }

  return json({ ok: true, subdomain: sub, ref, applied: entries.map((e) => e.name), last4 })
})
