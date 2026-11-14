// recurring-invoices - FN Hub control plane (automated subscription billing).
//
// Deploy on the fnhub-platform project, WITHOUT JWT verification (it is called
// by pg_cron via pg_net, not by a signed-in user):
//   supabase functions deploy recurring-invoices \
//     --project-ref <platform-ref> --no-verify-jwt
//
// Auth: the caller must send header  x-cron-secret: <CRON_SECRET>  matching the
// CRON_SECRET Edge Function secret. There is no JWT; the shared secret is the
// only gate, so keep it private (it lives in the pg_cron job body and the
// function secrets, never in client code).
//
// Flow (idempotent per day): find nation_billing rows that are active and due
// (next_run_date <= today), and for each one:
//   1. generate the next HLH-YYYY-NN invoice number (collision-safe insert),
//   2. insert a nation_invoices row from the schedule (status 'sent'),
//   3. advance next_run_date by the cadence and stamp last_run_date/last_invoice,
//   4. write a platform_audit row, and
//   5. when auto_send is on and email is configured, email the invoice to the
//      nation's billing contact via Resend.
//
// Secrets required on the platform project:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY  (auto-injected)
//   CRON_SECRET                              (shared secret; required)
//   RESEND_API_KEY, EMAIL_FROM               (optional; needed only for auto_send)
// Source ASCII-only.

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const SUPABASE_URL   = Deno.env.get('SUPABASE_URL') || ''
const SERVICE_KEY    = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || ''
const CRON_SECRET    = Deno.env.get('CRON_SECRET') || ''
const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY') || ''
const EMAIL_FROM     = Deno.env.get('EMAIL_FROM') || 'Nation Pathways <hello@nationpathways.com>'

const PROVIDER = {
  name:  'Nation Pathways',
  addr1: '916 Piper Street, Box 2251',
  addr2: 'Hearst, Ontario  P0L 1N0',
  phone: '705-960-5076',
  email: 'hello@nationpathways.com',
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-cron-secret',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
function json(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } })
}
function money(n: number): string { return '$' + (Number(n) || 0).toFixed(2) }
function esc(s: string): string {
  return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' } as Record<string, string>)[c])
}
function isoDay(d: Date): string { return d.toISOString().slice(0, 10) }
function addDays(day: string, n: number): string {
  const d = new Date(day + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return isoDay(d)
}
// Advance a YYYY-MM-DD by the cadence, holding the anchor day-of-month (clamped
// to the target month's length; anchor null keeps the source day).
function advance(day: string, cadence: string, anchor: number | null): string {
  const d = new Date(day + 'T00:00:00Z')
  const wantDay = anchor && anchor >= 1 && anchor <= 31 ? anchor : d.getUTCDate()
  if (cadence === 'annual') d.setUTCFullYear(d.getUTCFullYear() + 1)
  else d.setUTCMonth(d.getUTCMonth() + 1)
  // Clamp to the last day of the resulting month.
  const y = d.getUTCFullYear(), m = d.getUTCMonth()
  const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate()
  d.setUTCDate(Math.min(wantDay, lastDay))
  return isoDay(d)
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  if (req.method !== 'POST')    return json({ error: 'method_not_allowed' }, 405)
  if (!SUPABASE_URL || !SERVICE_KEY) return json({ error: 'not_configured' }, 500)
  if (!CRON_SECRET) return json({ error: 'cron_secret_not_set' }, 500)
  if ((req.headers.get('x-cron-secret') || '') !== CRON_SECRET) return json({ error: 'forbidden' }, 403)

  // Optional body: { subdomain } to run a single nation now (manual trigger),
  // { dryRun: true } to report what WOULD be billed without writing.
  let body: any = {}
  try { body = await req.json() } catch (_e) { body = {} }
  const onlySub = body && body.subdomain ? String(body.subdomain).trim().toLowerCase() : ''
  const dryRun = !!(body && body.dryRun)

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } })
  const today = isoDay(new Date())

  let q = admin.from('nation_billing').select('*').eq('active', true).lte('next_run_date', today)
  if (onlySub) q = q.eq('subdomain', onlySub)
  const { data: due, error: dueErr } = await q
  if (dueErr) return json({ error: 'query_failed', detail: dueErr.message }, 500)

  const results: any[] = []

  for (const sch of (due || [])) {
    const sub = sch.subdomain
    try {
      // Nation display details for the invoice + email.
      const { data: nrows } = await admin.from('nations').select('display_name, office_address').eq('subdomain', sub).limit(1)
      const nation = (nrows && nrows[0]) || { display_name: sub }

      const feeSubtotal = Math.round((Number(sch.unit_amount) || 0) * 100) / 100
      const taxRate     = Number(sch.tax_rate) || 0
      // Standing per-nation discount: percent-of-fee or fixed dollars, clamped
      // to the fee, taken off BEFORE tax. Never applied to carried-forward
      // balances -- those are already tax-inclusive prior totals.
      const discType    = (sch.discount_type === 'percent' || sch.discount_type === 'fixed') ? sch.discount_type : null
      const discValue   = Number(sch.discount_value) || 0
      let discount = 0
      if (discType && discValue > 0) {
        discount = discType === 'percent' ? feeSubtotal * discValue / 100 : discValue
        discount = Math.round(Math.min(discount, feeSubtotal) * 100) / 100
      }
      const feeTaxable  = Math.round((feeSubtotal - discount) * 100) / 100
      const feeTax      = Math.round(feeTaxable * taxRate) / 100
      const dueDate     = addDays(today, Number(sch.due_days) || 30)
      const lineItems: any[] = [{ description: sch.description, qty: 1, unit_price: feeSubtotal }]

      // Optional carry-forward: roll every still-owing invoice's balance onto this
      // one as a single line, then mark the sources 'carried' (below) so a balance
      // is billed once. The carried amount is already tax-inclusive, so tax is
      // charged only on the current period's fee -- never re-taxed.
      let carried = 0
      const carriedIds: string[] = []
      const carriedRefs: string[] = []
      if (sch.carry_forward) {
        const { data: prior } = await admin.from('nation_invoices')
          .select('id, number, total, amount_paid, status')
          .eq('subdomain', sub)
          .in('status', ['draft', 'sent', 'partial'])
        for (const p of (prior || [])) {
          const bal = Math.round(((Number(p.total) || 0) - (Number(p.amount_paid) || 0)) * 100) / 100
          if (bal > 0.005) { carried += bal; carriedIds.push(p.id); carriedRefs.push(p.number) }
        }
        carried = Math.round(carried * 100) / 100
        if (carried > 0) {
          lineItems.unshift({ description: 'Balance carried forward (' + carriedRefs.join(', ') + ')', qty: 1, unit_price: carried })
        }
      }

      const subtotal = Math.round((feeSubtotal + carried) * 100) / 100
      const tax      = feeTax
      const total    = Math.round((subtotal - discount + tax) * 100) / 100

      if (dryRun) {
        results.push({ subdomain: sub, would_bill: total, would_carry: carried, carried_from: carriedRefs, next_run_date: sch.next_run_date, dryRun: true })
        continue
      }

      // Collision-safe invoice number: scan for the year's max, insert, retry on
      // a unique-violation by bumping the sequence (up to 6 attempts).
      const year = today.slice(0, 4)
      const { data: numRows } = await admin.from('nation_invoices').select('number').like('number', 'HLH-' + year + '-%')
      let seq = 0
      for (const r of (numRows || [])) {
        const m = /^HLH-\d{4}-(\d+)$/.exec(String(r.number || ''))
        if (m) { const nn = parseInt(m[1], 10); if (nn > seq) seq = nn }
      }
      let inserted: any = null, number = ''
      for (let attempt = 0; attempt < 6 && !inserted; attempt++) {
        seq += 1
        number = 'HLH-' + year + '-' + String(seq).padStart(2, '0')
        const row: any = {
          subdomain: sub, number, issue_date: today, due_date: dueDate, currency: 'CAD',
          line_items: lineItems, subtotal, tax_rate: taxRate, tax, total, amount_paid: 0,
          status: 'sent', notes: 'Auto-generated recurring invoice.', created_by: 'recurring',
        }
        // Sent only when a discount applies -- keeps inserts working on a DB
        // that predates nation_invoice_discounts.sql.
        if (discount > 0) {
          row.discount_type = discType; row.discount_value = discValue
          row.discount = discount; row.discount_label = sch.discount_label || null
        }
        const { data: ins, error: insErr } = await admin.from('nation_invoices').insert(row).select('id, number').limit(1)
        if (!insErr && ins && ins[0]) { inserted = ins[0]; break }
        if (insErr && !/duplicate|unique/i.test(insErr.message)) throw new Error(insErr.message)
      }
      if (!inserted) throw new Error('could not allocate invoice number')

      // Mark carried-forward sources so their balance is not billed again.
      for (const cid of carriedIds) {
        try {
          await admin.from('nation_invoices').update({
            status: 'carried', notes: 'Carried forward into ' + number, updated_at: new Date().toISOString(),
          }).eq('id', cid)
        } catch (_e) { /* best-effort; the new invoice already carries the balance */ }
      }

      // Advance the schedule.
      const nextRun = advance(sch.next_run_date, sch.cadence, sch.anchor_day)
      await admin.from('nation_billing').update({
        next_run_date: nextRun, last_run_date: today, last_invoice: number, updated_at: new Date().toISOString(),
      }).eq('id', sch.id)

      // Audit.
      try {
        await admin.from('platform_audit').insert({
          action: 'nation_invoice_auto', subdomain: sub,
          detail: number + ': ' + money(total) + ' (' + sch.cadence
            + (carried > 0 ? '; carried ' + money(carried) + ' from ' + carriedRefs.join(', ') : '')
            + '); next ' + nextRun,
        })
      } catch (_e) { /* audit best-effort */ }

      // Email (optional).
      let emailed = false, emailNote = 'auto_send off'
      if (sch.auto_send) {
        if (!RESEND_API_KEY) emailNote = 'skipped: RESEND_API_KEY not set'
        else if (!sch.recipient_email) emailNote = 'skipped: no recipient_email'
        else {
          try {
            const html = invoiceHtml(nation.display_name || sub, sub, {
              number, issue_date: today, due_date: dueDate, line_items: lineItems, subtotal, tax_rate: taxRate, tax, total,
              discount, discount_type: discType, discount_value: discValue, discount_label: sch.discount_label || null,
            })
            const cc = String(sch.cc_emails || '').split(',').map((s: string) => s.trim()).filter(Boolean)
            const send = await fetch('https://api.resend.com/emails', {
              method: 'POST',
              headers: { 'Authorization': 'Bearer ' + RESEND_API_KEY, 'Content-Type': 'application/json' },
              body: JSON.stringify({
                from: EMAIL_FROM, to: [sch.recipient_email], cc: cc.length ? cc : undefined,
                subject: PROVIDER.name + ' invoice ' + number + ' - ' + money(total),
                html,
              }),
            })
            emailed = send.ok
            emailNote = send.ok ? 'sent to ' + sch.recipient_email : ('resend error ' + send.status)
          } catch (e) { emailNote = 'email error: ' + String(e && (e as Error).message || e) }
        }
      }

      results.push({ subdomain: sub, invoice: number, total, carried, carried_from: carriedRefs, next_run_date: nextRun, emailed, emailNote })
    } catch (e) {
      results.push({ subdomain: sub, error: String(e && (e as Error).message || e) })
    }
  }

  return json({ ok: true, date: today, dryRun, processed: results.length, results })
})

// Minimal HTML invoice for the auto-send email (the styled PDF lives in the
// admin portal; click the invoice number there to regenerate it).
function invoiceHtml(nationName: string, sub: string, inv: any): string {
  const rows = (inv.line_items || []).map((l: any) => {
    const amt = (Number(l.qty) || 0) * (Number(l.unit_price) || 0)
    return '<tr><td style="padding:6px 8px;border-bottom:1px solid #eee;">' + esc(l.description) +
      '</td><td style="padding:6px 8px;border-bottom:1px solid #eee;text-align:right;">' + esc(String(l.qty)) +
      '</td><td style="padding:6px 8px;border-bottom:1px solid #eee;text-align:right;">' + money(l.unit_price) +
      '</td><td style="padding:6px 8px;border-bottom:1px solid #eee;text-align:right;">' + money(amt) + '</td></tr>'
  }).join('')
  return '<div style="font-family:Arial,Helvetica,sans-serif;color:#26221C;max-width:640px;">' +
    '<h2 style="margin:0;color:#9A4A1F;">' + esc(PROVIDER.name) + '</h2>' +
    '<div style="color:#57503F;font-size:13px;">Housing Management Platform</div>' +
    '<div style="color:#57503F;font-size:12px;margin-top:2px;">' + esc(PROVIDER.addr1) + ', ' + esc(PROVIDER.addr2) +
      ' &middot; ' + esc(PROVIDER.phone) + ' &middot; ' + esc(PROVIDER.email) + '</div>' +
    '<hr style="border:none;border-top:1px solid #D8CFC0;margin:14px 0;">' +
    '<div style="display:flex;justify-content:space-between;font-size:13px;">' +
      '<div><b>Bill to</b><br>' + esc(nationName) + '<br>' + esc(sub) + '.fnhub.app</div>' +
      '<div style="text-align:right;"><b>Invoice</b> ' + esc(inv.number) + '<br>Issued ' + esc(inv.issue_date) +
        '<br>Due ' + esc(inv.due_date) + '</div>' +
    '</div>' +
    '<table style="width:100%;border-collapse:collapse;margin-top:14px;font-size:13px;">' +
      '<thead><tr style="background:#F3E4D8;"><th style="padding:6px 8px;text-align:left;">Description</th>' +
      '<th style="padding:6px 8px;text-align:right;">Qty</th><th style="padding:6px 8px;text-align:right;">Unit</th>' +
      '<th style="padding:6px 8px;text-align:right;">Amount</th></tr></thead><tbody>' + rows + '</tbody></table>' +
    '<div style="text-align:right;margin-top:10px;font-size:13px;">' +
      'Subtotal ' + money(inv.subtotal) + '<br>' +
      (Number(inv.discount) > 0 ? ('Discount' + (inv.discount_label ? ' - ' + esc(String(inv.discount_label)) : (inv.discount_type === 'percent' ? ' (' + inv.discount_value + '%)' : '')) + ' -' + money(inv.discount) + '<br>') : '') +
      (Number(inv.tax_rate) ? ('Tax (' + inv.tax_rate + '%) ' + money(inv.tax) + '<br>') : '') +
      '<b style="font-size:15px;">Total (CAD) ' + money(inv.total) + '</b></div>' +
    '<p style="color:#57503F;font-size:12px;margin-top:16px;">Payment due within ' +
      '30 days of the invoice date. Amounts more than 30 days overdue may bear interest at 1% per month ' +
      '(12.68% annually). All amounts are in Canadian dollars, plus applicable taxes if any.</p>' +
    '</div>'
}
