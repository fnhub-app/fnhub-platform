// Email intake receiver - Phase EI.
// Deploy: supabase functions deploy email-intake
//
// Receives a parsed inbound email from the Cloudflare Email Worker (see
// cloudflare-email-worker/), stores the body + attachments in Storage, computes
// suggested unit/tenant matches, and inserts ONE triage row into email_intake
// with the SERVICE ROLE (bypassing RLS). Triage-first: nothing is auto-filed;
// staff assign the row to a unit/tenant in the app.
//
// Auth: the caller must present x-intake-secret === EMAIL_INTAKE_SECRET (the
// shared secret only the Cloudflare worker holds). This function is NOT for
// browsers and never trusts the anon key. Source must stay ASCII-only.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const SUPABASE_URL   = Deno.env.get('SUPABASE_URL')
const SERVICE_KEY    = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
const INTAKE_SECRET  = Deno.env.get('EMAIL_INTAKE_SECRET') || ''
const STORAGE_BUCKET = Deno.env.get('STORAGE_BUCKET') || 'housing-files'

const MAX_ATTACHMENTS   = 15
const MAX_ATT_BYTES     = 12 * 1024 * 1024   // per attachment
const MAX_BODY_CHARS    = 200000             // stored body cap
const MAX_SUGGESTIONS   = 5

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type, x-intake-secret',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
function json(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } })
}

// Normalize a name/text for loose matching: lowercase, strip punctuation,
// collapse whitespace.
function norm(s: string): string {
  return String(s || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim()
}

// Decode a base64 string to bytes, size-checked BEFORE atob.
function b64ToBytes(b64: string): Uint8Array | null {
  if (typeof b64 !== 'string' || !b64) return null
  if (b64.length > MAX_ATT_BYTES * 4 / 3 + 8) return null
  let bin: string
  try { bin = atob(b64) } catch { return null }
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytes
}

function safeName(name: string): string {
  return String(name || 'file').replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 120) || 'file'
}

// Escape a value for a PostgREST ilike filter: an unescaped % / _ acts as a
// LIKE wildcard, so a sender like "a%@x.com" would match unintended tenants.
function likeLit(s: string): string {
  return String(s || '').replace(/[\\%_]/g, (c: string) => '\\' + c)
}

// Strip HTML to plain text (no DOM in the edge runtime). Used so the stored
// body is always plain text -- staff never open attacker-controlled HTML.
function htmlToText(html: string): string {
  return String(html || '')
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>').replace(/&#39;/g, "'").replace(/&quot;/gi, '"')
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
}

// Build suggested unit/tenant matches from the sender + subject + body.
async function computeSuggestions(admin: any, fromEmail: string, subject: string, text: string): Promise<any[]> {
  const hay = norm(subject + ' ' + text)
  const suggestions: any[] = []
  const seenUnits = new Set<string>()
  function addUnit(unitId: string, label: string, reason: string) {
    if (!unitId || seenUnits.has(unitId)) return
    seenUnits.add(unitId)
    suggestions.push({ type: 'unit', unitId: unitId, label: label, reason: reason })
  }

  try {
    // (1) Sender email -> tenant record -> current unit.
    if (fromEmail) {
      const { data: ts } = await admin.from('tenants')
        .select('full_name,current_unit_id,email').ilike('email', likeLit(fromEmail)).is('merged_into', null).limit(3)
      for (const t of (ts || [])) {
        if (t.current_unit_id) {
          const { data: us } = await admin.from('housing_units').select('id,num,street').eq('id', t.current_unit_id).limit(1)
          const u = us && us[0]
          if (u) addUnit(u.id, ((u.num || '') + ' ' + (u.street || '')).trim(), 'Sender email matches tenant ' + (t.full_name || ''))
        }
      }
    }

    // Load a bounded set of active units for address / assigned-name scanning.
    const { data: units } = await admin.from('housing_units')
      .select('id,num,street,assigned_name').eq('archived', false).limit(2000)
    for (const u of (units || [])) {
      if (suggestions.length >= MAX_SUGGESTIONS) break
      const addr = norm(((u.num || '') + ' ' + (u.street || '')))
      if (addr && addr.length >= 4 && hay.indexOf(addr) >= 0) {
        addUnit(u.id, ((u.num || '') + ' ' + (u.street || '')).trim(), 'Unit address found in the email')
        continue
      }
      const an = norm(u.assigned_name || '')
      if (an && an.split(' ').length >= 2 && hay.indexOf(an) >= 0) {
        addUnit(u.id, ((u.num || '') + ' ' + (u.street || '')).trim(), 'Tenant name (' + (u.assigned_name || '') + ') found in the email')
      }
    }

    // (2) Tenant name match without a unit link (surface the name for triage).
    if (suggestions.length < MAX_SUGGESTIONS) {
      const { data: tns } = await admin.from('tenants')
        .select('full_name,current_unit_id').is('merged_into', null).limit(2000)
      for (const t of (tns || [])) {
        if (suggestions.length >= MAX_SUGGESTIONS) break
        const nm = norm(t.full_name || '')
        if (nm && nm.split(' ').length >= 2 && hay.indexOf(nm) >= 0) {
          if (t.current_unit_id && seenUnits.has(t.current_unit_id)) continue
          suggestions.push({ type: 'tenant', unitId: t.current_unit_id || '', label: t.full_name || '', reason: 'Tenant name found in the email' })
        }
      }
    }
  } catch (_e) { /* suggestions are best-effort; triage still works without them */ }
  return suggestions.slice(0, MAX_SUGGESTIONS)
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  if (req.method !== 'POST')    return json({ error: 'Method not allowed' }, 405)
  try {
    if (!SUPABASE_URL || !SERVICE_KEY) return json({ error: 'Server not configured.' }, 500)
    if (!INTAKE_SECRET)               return json({ error: 'Intake secret not configured.' }, 500)

    const supplied = req.headers.get('x-intake-secret') || ''
    if (supplied !== INTAKE_SECRET) return json({ error: 'Unauthorized.' }, 401)

    const body = await req.json().catch(() => ({}))
    const messageId = String(body.messageId || '').slice(0, 500)
    const fromEmail = String(body.from || '').trim().toLowerCase().slice(0, 320)
    const fromName  = String(body.fromName || '').slice(0, 200)
    const toEmail   = String(body.to || '').trim().toLowerCase().slice(0, 320)
    const subject   = String(body.subject || '').slice(0, 1000)
    const text      = String(body.text || '')
    const html      = String(body.html || '')

    const admin = createClient(SUPABASE_URL, SERVICE_KEY)

    // Sender gate: intake emails are FORWARDED by a registered employee, so the
    // sender must be an active staff member of THIS nation. Drop anything else
    // (the address is public). Note: the From header is spoofable, so this is a
    // strong spam filter, not absolute auth -- the Cloudflare<->function shared
    // secret is the real gate; triage-first means nothing auto-files regardless.
    // Escaped ilike (unescaped % / _ would wildcard-match a staff address).
    if (!fromEmail) return json({ ok: true, dropped: 'no_sender' })
    const { data: staffRows } = await admin.from('staff')
      .select('id').ilike('email', likeLit(fromEmail)).eq('is_active', true).limit(1)
    if (!staffRows || !staffRows.length) {
      console.log('[email-intake] dropped - sender not active staff: ' + fromEmail)
      return json({ ok: true, dropped: 'sender_not_staff' })
    }

    // Dedupe on Message-ID (the unique partial index also guards this).
    if (messageId) {
      const { data: dup } = await admin.from('email_intake').select('id').eq('message_id', messageId).limit(1)
      if (dup && dup.length) return json({ ok: true, deduped: true, id: dup[0].id })
    }

    const id = crypto.randomUUID()

    // Store the body as PLAIN TEXT always. HTML is stripped to text so staff
    // never open attacker-controlled markup (no tracking pixels, links, or
    // scripts rendered on any origin); the file opens as text/plain.
    let bodyPath = ''
    const bodyStr = (text ? text : htmlToText(html)).slice(0, MAX_BODY_CHARS)
    if (bodyStr) {
      const p = 'email-intake/' + id + '/body.txt'
      try {
        const { error } = await admin.storage.from(STORAGE_BUCKET)
          .upload(p, new TextEncoder().encode(bodyStr), { contentType: 'text/plain; charset=utf-8', upsert: true })
        if (!error) bodyPath = p
      } catch (_e) { /* body storage is best-effort */ }
    }

    // Store attachments.
    const rawAtt = Array.isArray(body.attachments) ? body.attachments.slice(0, MAX_ATTACHMENTS) : []
    const attachments: any[] = []
    for (let i = 0; i < rawAtt.length; i++) {
      const a = rawAtt[i] || {}
      const bytes = b64ToBytes(String(a.contentBase64 || ''))
      if (!bytes || !bytes.length) continue
      const name = safeName(a.name || ('attachment-' + (i + 1)))
      const p = 'email-intake/' + id + '/att-' + (i + 1) + '_' + name
      try {
        const { error } = await admin.storage.from(STORAGE_BUCKET)
          .upload(p, bytes, { contentType: String(a.contentType || 'application/octet-stream'), upsert: true })
        if (!error) attachments.push({ path: p, name: a.name || name, contentType: String(a.contentType || 'application/octet-stream'), size: bytes.length })
      } catch (_e) { /* skip this attachment, keep the row */ }
    }

    const suggestions = await computeSuggestions(admin, fromEmail, subject, bodyStr)

    const preview = norm(bodyStr).slice(0, 300)

    const { data: ins, error: iErr } = await admin.from('email_intake').insert({
      id: id,
      message_id: messageId || null,
      from_email: fromEmail || null,
      from_name:  fromName || null,
      to_email:   toEmail || null,
      subject:    subject || null,
      body_preview: preview || null,
      body_path:  bodyPath || null,
      attachments: attachments,
      suggested_match: suggestions,
      status: 'new'
    }).select('id').limit(1)
    if (iErr) {
      console.log('[email-intake] insert failed: ' + iErr.message)
      return json({ error: 'Could not record the email.' }, 500)
    }

    return json({ ok: true, id: (ins && ins[0] && ins[0].id) || id, attachments: attachments.length, suggestions: suggestions.length })
  } catch (e) {
    return json({ error: (e as Error).message }, 500)
  }
})
