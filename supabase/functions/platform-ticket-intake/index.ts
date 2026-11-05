// platform-ticket-intake - FN Hub control plane (aggregated support inbox).
//
// Deploy on the fnhub-platform project, WITHOUT JWT verification (the caller is
// a NATION Edge Function - `support-forward` - signed by that nation's project,
// whose token the platform gateway cannot validate). It authenticates itself
// with a shared secret header instead:
//   supabase functions deploy platform-ticket-intake \
//     --project-ref <platform-ref> --no-verify-jwt
//
// Flow: a nation's `support-forward` function POSTs a LIGHT copy of a just-filed
// support ticket (no base64 attachments / chat transcript) with header
//   x-inbox-secret: <SUPPORT_INBOX_SECRET>
// This function verifies that secret, then upserts the row into
// `platform_support_tickets` (service role) deduped on (subdomain,
// nation_ticket_id). Platform-side triage columns (platform_status /
// assigned_to / resolved_*) are intentionally NOT written here, so a re-forward
// updates the mirrored content without resetting the triage state.
//
// Secrets required on the platform project:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY   (auto-injected)
//   SUPPORT_INBOX_SECRET                      (shared with every nation's
//                                              support-forward function)
// Source ASCII-only.

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || ''
const SERVICE_KEY  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || ''
const INBOX_SECRET = Deno.env.get('SUPPORT_INBOX_SECRET') || ''

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-inbox-secret',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
function json(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } })
}
function clip(v: unknown, n: number): string {
  const s = (v == null) ? '' : String(v)
  return s.length > n ? s.slice(0, n) : s
}

const SUB_RE = /^[a-z0-9](?:[a-z0-9-]{0,40}[a-z0-9])?$/

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  if (req.method !== 'POST')    return json({ error: 'method_not_allowed' }, 405)
  if (!SUPABASE_URL || !SERVICE_KEY) return json({ error: 'not_configured' }, 500)
  if (!INBOX_SECRET) return json({ error: 'not_configured' }, 500)

  // Constant-work secret check (length-independent compare is overkill here;
  // the secret is server-to-server and high-entropy).
  const given = req.headers.get('x-inbox-secret') || ''
  if (!given || given !== INBOX_SECRET) return json({ error: 'forbidden' }, 403)

  let body: any = {}
  try { body = await req.json() } catch (_e) { return json({ error: 'bad_json' }, 400) }

  const sub = String(body.subdomain || '').trim().toLowerCase()
  const nid = String(body.nation_ticket_id || '').trim()
  if (!SUB_RE.test(sub)) return json({ error: 'bad_subdomain' }, 400)
  if (!nid) return json({ error: 'missing_ticket_id' }, 400)

  // Only the mirrored content + nation status; triage columns are omitted on
  // purpose so an upsert never clobbers platform-side state.
  const row: Record<string, unknown> = {
    subdomain: sub,
    nation_name: clip(body.nation_name, 200) || null,
    nation_ticket_id: nid,
    source: clip(body.source, 40) || null,
    category: clip(body.category, 80) || null,
    subject: clip(body.subject, 500) || null,
    body: clip(body.body, 20000) || null,
    reporter_name: clip(body.reporter_name, 200) || null,
    reporter_email: clip(body.reporter_email, 200) || null,
    reporter_phone: clip(body.reporter_phone, 60) || null,
    reporter_role: clip(body.reporter_role, 60) || null,
    context: (body.context && typeof body.context === 'object') ? body.context : null,
    attachment_count: Math.max(0, Math.min(99, Number(body.attachment_count) || 0)),
    nation_status: clip(body.nation_status, 40) || null,
    nation_created_at: body.nation_created_at ? new Date(String(body.nation_created_at)).toISOString() : null,
    updated_at: new Date().toISOString(),
  }

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } })
  const { error } = await admin
    .from('platform_support_tickets')
    .upsert(row, { onConflict: 'subdomain,nation_ticket_id' })
  if (error) return json({ error: 'write_failed', detail: String(error.message || error) }, 500)

  return json({ ok: true })
})
