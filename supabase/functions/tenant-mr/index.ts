// Tenant maintenance request intake - scan-to-report QR flow.
// Deploy: supabase functions deploy tenant-mr
//
// PUBLIC function. The tenant report form sends the project ANON key as the
// bearer, so the gateway accepts the call; this function then does its OWN
// validation (per-unit secret token + rate limit) and writes to
// tenant_mr_submissions with the SERVICE ROLE. Tenants have NO direct table
// access - this function is the only write path, and it never touches
// housing_sow. Source must stay ASCII-only.

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import {
  emailConfigured, isValidEmail, escapeHtml, renderBrandedEmail, emailBrand,
  sendEmail, sendEmailSerially, setBrandOverrides,
} from '../_shared/email.ts'
import { uploadMrPhotos, mrSubject, resolveStaffRecipients } from '../_shared/mr.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')
const SERVICE_KEY  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}
function json(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } })
}

const MAX_DESC       = 2000
const RL_WINDOW_MIN  = 10      // rate-limit window
const RL_UNIT_MAX    = 5       // max submissions per unit per window
const RL_IP_MAX      = 12      // max submissions per source IP per window
const URGENCY        = ['routine', 'urgent', 'emergency']

const STORAGE_BUCKET = Deno.env.get('STORAGE_BUCKET') || 'housing-files'
const APP_URL        = (Deno.env.get('APP_URL') || '').replace(/\/$/, '')  // e.g. https://housing.clfn.on.ca (optional)
// Who gets the "new maintenance request" email. Defaults to housing managers +
// ED resolved from the staff table; a nation can override with either secret.
const MR_NOTIFY_ROLES = (Deno.env.get('HOUSING_MR_NOTIFY_ROLES') || 'housing_manager,ed,hm,manager')
  .split(',').map((r) => r.trim().toLowerCase()).filter(Boolean)
const MR_NOTIFY_TO    = (Deno.env.get('HOUSING_MR_NOTIFY_TO') || '')
  .split(',').map((s) => s.trim()).filter((s) => isValidEmail(s))
// Photo decode/upload lives in _shared/mr.ts (shared with the member portal
// path in applicant-intake -- same caps, mime map, storage path convention).

type MrInfo = {
  address: string; category: string; urgency: string; description: string;
  contactName: string; contactPhone: string; contactEmail: string;
  photoCount: number; reference: string;
}

// Resolve the housing recipients (shared resolver: explicit secret list,
// else active staff in the configured roles).
function resolveHousingRecipients(admin: any): Promise<Array<{ to: string; to_name?: string }>> {
  return resolveStaffRecipients(admin, MR_NOTIFY_ROLES, MR_NOTIFY_TO, isValidEmail)
}

function mrDetailsBlock(info: MrInfo): string {
  const row = (label: string, val: string) =>
    '<tr><td style="padding:4px 12px 4px 0;color:#666;font-size:13px;white-space:nowrap;vertical-align:top;">'
      + escapeHtml(label) + '</td><td style="padding:4px 0;font-size:13px;color:#111;">' + escapeHtml(val) + '</td></tr>'
  let html = '<table style="border-collapse:collapse;margin:8px 0 4px;">'
  html += row('Unit', info.address || '-')
  html += row('Category', info.category || 'Uncategorized')
  html += row('Urgency', (info.urgency || 'routine').toUpperCase())
  const contact = [info.contactName, info.contactPhone, info.contactEmail].filter(Boolean).join(' | ')
  if (contact) html += row('Contact', contact)
  if (info.photoCount) html += row('Photos', String(info.photoCount) + ' attached')
  html += '</table>'
  html += '<div style="margin-top:10px;font-size:13px;color:#666;">Reported problem</div>'
  html += '<div style="background:#f6f5f1;border:1px solid #e5e3db;border-radius:8px;padding:10px 12px;font-size:14px;color:#111;white-space:pre-wrap;margin-top:4px;">'
    + escapeHtml(info.description || '') + '</div>'
  return html
}

// Best-effort: email housing (+ the tenant if they left an address). Never throws.
async function notifyMaintenanceRequest(admin: any, info: MrInfo): Promise<void> {
  if (!emailConfigured()) return
  const brand = emailBrand()

  // 1) Housing team.
  const recipients = await resolveHousingRecipients(admin)
  if (recipients.length) {
    const subject = mrSubject(info.urgency, info.address)
    const link = APP_URL
      ? '<p style="font-size:13px;margin:14px 0 0;"><a href="' + APP_URL + '/housing.html" style="color:#111827;font-weight:700;text-decoration:underline;">Open the Housing app</a> and review it under <b>Tenant Requests</b>.</p>'
      : '<p style="font-size:13px;margin:14px 0 0;color:#666;">Review it in the Housing app under <b>Tenant Requests</b>.</p>'
    const inner = '<p style="font-size:14px;color:#333;margin:0 0 6px;">A tenant submitted a maintenance request via the unit QR code.</p>'
      + mrDetailsBlock(info) + link
    const html = renderBrandedEmail(subject, inner)
    await sendEmailSerially(recipients, () => ({ subject, html }))
  }

  // 2) Tenant confirmation (only if a valid email was provided).
  if (isValidEmail(info.contactEmail)) {
    const subject = 'We received your maintenance request'
    const inner = '<p style="font-size:14px;color:#333;margin:0 0 6px;">Thank you'
      + (info.contactName ? ', ' + escapeHtml(info.contactName) : '')
      + '. The ' + escapeHtml(brand) + ' office has received your maintenance request and will review it.</p>'
      + mrDetailsBlock({ ...info, contactEmail: '', contactPhone: '', contactName: '' })
      + (info.reference ? '<p style="font-size:12px;color:#888;margin:14px 0 0;">Reference: ' + escapeHtml(info.reference) + '</p>' : '')
      + '<p style="font-size:13px;color:#666;margin:10px 0 0;">For emergencies (no heat, flooding, gas smell) please call the Housing office directly - do not rely on this form.</p>'
    const html = renderBrandedEmail(subject, inner)
    try { await sendEmail({ to: info.contactEmail, to_name: info.contactName || undefined, subject, html }) }
    catch (e) { console.warn('[tenant-mr] tenant confirm email failed: ' + (e as Error).message) }
  }
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  try {
    if (!SUPABASE_URL || !SERVICE_KEY) return json({ error: 'Server not configured.' }, 500)
    const admin = createClient(SUPABASE_URL, SERVICE_KEY)

    const body   = await req.json().catch(() => ({}))
    const action = String(body.action || '')
    // Brand emails with the nation identity the client (NATION_CONFIG) passes.
    setBrandOverrides({ brand: body.brand, brandColor: body.brand_color, logoUrl: body.logo_url, contactLine: body.contact_line })

    // --- resolve_slug: map a short /u/<slug> code to its unit + token so the
    // report form can proceed. The slug is enumerable, so the token returned
    // here is a link-validity marker, not a secret (the redirect issues it).
    // Minted on first resolve if the unit has none yet.
    if (action === 'resolve_slug') {
      const slug = parseInt(String(body.slug || ''), 10)
      if (!slug || slug < 1) return json({ error: 'Invalid code.' }, 400)
      const { data: sRows, error: sErr } = await admin
        .from('housing_units').select('id, num, street, data').eq('label_slug', slug).limit(1)
      if (sErr) return json({ error: 'Lookup failed.' }, 500)
      const su = sRows && sRows[0]
      if (!su) return json({ error: 'This code is not linked to a unit.' }, 404)
      let tok = su.data && (su.data.qr_token || su.data.qrToken)
      if (!tok) {
        tok = crypto.randomUUID()
        const newData = Object.assign({}, su.data || {}, { qrToken: tok })
        await admin.from('housing_units').update({ data: newData }).eq('id', su.id)
      }
      return json({ ok: true, unit_id: su.id, token: tok, address: ((su.num || '') + ' ' + (su.street || '')).trim() })
    }

    const unitId = String(body.unit_id || '').trim()
    const token  = String(body.token || '').trim()
    if (!unitId || !token) return json({ error: 'Missing unit or code.' }, 400)

    // Validate the per-unit secret token (stored in housing_units.data.qr_token).
    const { data: unitRows, error: uErr } = await admin
      .from('housing_units').select('id, num, street, data').eq('id', unitId).limit(1)
    if (uErr) return json({ error: 'Lookup failed.' }, 500)
    const unit = unitRows && unitRows[0]
    if (!unit) return json({ error: 'This code is not linked to a unit.' }, 404)
    const realToken = unit.data && (unit.data.qr_token || unit.data.qrToken)
    if (!realToken || realToken !== token) return json({ error: 'This code is invalid or has been replaced.' }, 403)
    const address = ((unit.num || '') + ' ' + (unit.street || '')).trim()

    // --- validate: confirm the code + return the unit address for the form ---
    if (action === 'validate') {
      return json({ ok: true, unit_id: unitId, address })
    }

    // --- submit: record the request in the staging table ---
    if (action === 'submit') {
      const description = String(body.description || '').trim().slice(0, MAX_DESC)
      if (!description) return json({ error: 'Please describe the problem.' }, 400)
      const category     = String(body.category || '').trim().slice(0, 80)
      const urgency      = URGENCY.indexOf(String(body.urgency || '')) !== -1 ? String(body.urgency) : 'routine'
      const contactName  = String(body.contact_name || '').trim().slice(0, 120)
      const contactPhone = String(body.contact_phone || '').trim().slice(0, 40)
      const contactEmailRaw = String(body.contact_email || '').trim().slice(0, 160)
      const contactEmail = isValidEmail(contactEmailRaw) ? contactEmailRaw : ''
      // cf-connecting-ip first -- the leftmost x-forwarded-for hop is
      // client-suppliable, which let the per-IP budget be walked with a
      // spoofed header (same fix as applicant-intake / request-password-reset).
      const ip = (req.headers.get('cf-connecting-ip') || req.headers.get('x-forwarded-for') || '').split(',')[0].trim()
      const sinceIso = new Date(Date.now() - RL_WINDOW_MIN * 60000).toISOString()

      // Rate limit: per unit and per source IP.
      const { count: unitCount } = await admin.from('tenant_mr_submissions')
        .select('id', { count: 'exact', head: true }).eq('unit_id', unitId).gte('created_at', sinceIso)
      if ((unitCount || 0) >= RL_UNIT_MAX) {
        return json({ error: 'A few requests were just submitted for this unit. Please try again in a little while.' }, 429)
      }
      if (ip) {
        const { count: ipCount } = await admin.from('tenant_mr_submissions')
          .select('id', { count: 'exact', head: true }).eq('source_ip', ip).gte('created_at', sinceIso)
        if ((ipCount || 0) >= RL_IP_MAX) return json({ error: 'Too many requests. Please try again later.' }, 429)
      }

      const { data: ins, error: iErr } = await admin.from('tenant_mr_submissions').insert({
        unit_id: unitId, unit_address: address, category, description, urgency,
        contact_name: contactName, contact_phone: contactPhone, status: 'new', source_ip: ip,
      }).select('id').limit(1)
      if (iErr) return json({ error: 'Could not save your request. Please try again.' }, 500)
      const subId = (ins && ins[0] && ins[0].id) || ''

      // Optional photos: upload with the service role, store the paths on the row.
      // A photo failure is non-fatal - the text request is already saved.
      let photoCount = 0
      if (subId && body.photos) {
        const paths = await uploadMrPhotos(admin, STORAGE_BUCKET, unitId, subId, body.photos)
        photoCount = paths.length
        if (paths.length) {
          await admin.from('tenant_mr_submissions')
            .update({ photo_path: JSON.stringify(paths) }).eq('id', subId)
        }
      }

      // Store the tenant email as its OWN best-effort update so the request
      // still saves + notifies even if the contact_email column migration has
      // not been run yet (no insert-time ordering dependency).
      if (subId && contactEmail) {
        try { await admin.from('tenant_mr_submissions').update({ contact_email: contactEmail }).eq('id', subId) }
        catch (_e) { /* column may not exist yet; email still used for the confirmation below */ }
      }

      // Notify housing (+ the tenant if they left an email). Best-effort: a mail
      // failure must never fail the tenant's submission.
      try {
        await notifyMaintenanceRequest(admin, {
          address, category, urgency, description,
          contactName, contactPhone, contactEmail,
          photoCount, reference: subId,
        })
      } catch (e) { console.warn('[tenant-mr] notify failed: ' + (e as Error).message) }

      // Audit the external submission (service role; append-only). Never throws.
      try {
        await admin.from('housing_audit_log').insert({
          entity_type: 'unit', entity_id: unitId, action: 'tenant_mr_submitted',
          detail: 'Tenant reported via QR - ' + (category || 'Maintenance') + ': ' + description.slice(0, 120)
            + (photoCount ? ' (' + photoCount + ' photo' + (photoCount > 1 ? 's' : '') + ')' : ''),
          actor: contactName || 'Tenant (QR form)', created_at: new Date().toISOString(),
        })
      } catch (_e) { /* audit is best-effort */ }

      return json({ ok: true, reference: subId, address })
    }

    return json({ error: 'Unknown action.' }, 400)
  } catch (e) {
    return json({ error: (e as Error).message }, 500)
  }
})
