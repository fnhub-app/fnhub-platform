// support-forward - FN Hub nation project (mirror a support ticket to the
// control-plane aggregated inbox).
//
// Deploy on EACH nation project with JWT verification ON (the default): the
// caller is a signed-in nation user (staff, member, or contractor) whose token
// the nation gateway validates before this code runs. The Help & Support widget
// calls this right after it files a ticket into `support_tickets`.
//
// Flow:
//   1. Gateway verifies the caller's nation JWT (any audience).
//   2. We read the just-filed ticket by id with the service role (authoritative
//      content; we never trust the client's copy of subject/body), deliberately
//      NOT selecting the heavy base64 `attachments` / `transcript` blobs.
//   3. We POST a LIGHT copy to the platform `platform-ticket-intake` function
//      with the shared `x-inbox-secret`, so it lands in the admin panel's
//      aggregated Support inbox.
// Best-effort end to end: the ticket is already stored on the nation, so a
// mirror failure never costs data and is reported as { ok:false } (the widget
// ignores it).
//
// Secrets required on the NATION project:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY   (auto-injected)
//   SUPPORT_INBOX_URL      - the platform platform-ticket-intake function URL,
//                            e.g. https://<platform-ref>.functions.supabase.co/platform-ticket-intake
//   SUPPORT_INBOX_SECRET   - shared with the platform intake function
// Source ASCII-only.

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || ''
const SERVICE_KEY  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || ''
const INBOX_URL    = Deno.env.get('SUPPORT_INBOX_URL') || ''
const INBOX_SECRET = Deno.env.get('SUPPORT_INBOX_SECRET') || ''

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
function json(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } })
}

const SUB_RE = /^[a-z0-9](?:[a-z0-9-]{0,40}[a-z0-9])?$/

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  if (req.method !== 'POST')    return json({ ok: false, error: 'method_not_allowed' }, 405)
  // Not configured for mirroring yet -> succeed quietly (the ticket is stored).
  if (!SUPABASE_URL || !SERVICE_KEY || !INBOX_URL || !INBOX_SECRET) return json({ ok: false, error: 'not_configured' }, 200)

  let body: any = {}
  try { body = await req.json() } catch (_e) { return json({ ok: false, error: 'bad_json' }, 400) }
  const ticketId = String(body.ticketId || '').trim()
  if (!ticketId) return json({ ok: false, error: 'missing_ticket_id' }, 400)

  let sub = String(body.subdomain || '').trim().toLowerCase()
  if (!SUB_RE.test(sub)) sub = ''   // fall through; a bad label just stays blank

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } })

  // Authoritative read of the just-filed ticket (no heavy blobs).
  const { data: rows, error } = await admin
    .from('support_tickets')
    .select('id, source, category, subject, body, reporter_name, reporter_email, reporter_phone, reporter_role, context, status, created_at')
    .eq('id', ticketId)
    .limit(1)
  if (error) return json({ ok: false, error: 'read_failed' }, 200)
  const t = rows && rows[0]
  if (!t) return json({ ok: false, error: 'ticket_not_found' }, 200)

  const payload = {
    subdomain: sub,
    nation_name: String(body.nationName || '').slice(0, 200),
    nation_ticket_id: String(t.id),
    source: t.source || '',
    category: t.category || '',
    subject: t.subject || '',
    body: t.body || '',
    reporter_name: t.reporter_name || '',
    reporter_email: t.reporter_email || '',
    reporter_phone: t.reporter_phone || '',
    reporter_role: t.reporter_role || '',
    context: (t.context && typeof t.context === 'object') ? t.context : null,
    attachment_count: Math.max(0, Math.min(99, Number(body.attachmentCount) || 0)),
    nation_status: t.status || '',
    nation_created_at: t.created_at || null,
  }

  try {
    const r = await fetch(INBOX_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-inbox-secret': INBOX_SECRET },
      body: JSON.stringify(payload),
    })
    if (!r.ok) return json({ ok: false, error: 'intake_rejected', status: r.status }, 200)
  } catch (_e) {
    return json({ ok: false, error: 'intake_unreachable' }, 200)
  }

  return json({ ok: true })
})
