# Recurring (automated) invoicing

Automated subscription billing for nations. Each nation can have one **billing
schedule** (in the admin portal → nation → Invoices → **Recurring billing**).
A daily scheduler generates an invoice whenever a schedule is due, advances the
next date, and — when **Auto-send** is on — emails the invoice to the nation.

Everything runs on the **control-plane** project (`fnhub-platform`,
`dnaxulsdetlnpupegoiq`). Nothing here touches a nation's own project.

## Pieces

| Piece | File | What it does |
|---|---|---|
| Schema | `supabase/platform/nation_billing.sql` | `nation_billing` table (one schedule per nation) |
| Function | `supabase/functions/recurring-invoices/index.ts` | Generates due invoices + optional email |
| Admin UI | `admin/admin.js` (Recurring billing card) | Create/edit/pause the schedule, "Generate now" |
| Deploy | `.github/workflows/deploy-platform-functions.yml` | Deploys the function on push to `main` |

## One-time setup

1. **Create the table.** Run `supabase/platform/nation_billing.sql` in the
   platform project's SQL Editor.

2. **Deploy the function.** It deploys automatically on push to `main` (or run
   the "Deploy platform (control-plane) Edge Functions" workflow manually).
   Requires the existing `SUPABASE_ACCESS_TOKEN` repo secret.

3. **Set the function secrets** (Supabase dashboard → platform project →
   Project Settings → Edge Functions → Secrets):
   - `CRON_SECRET` — any long random string. The scheduler must send this as
     the `x-cron-secret` header; it is the only gate on the function.
   - `RESEND_API_KEY` — **only for Auto-send.** A [Resend](https://resend.com)
     API key. The sending domain (e.g. `nationpathways.com`) must be verified in
     Resend.
   - `EMAIL_FROM` — optional; defaults to
     `Nation Pathways <hello@nationpathways.com>`.

   `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are injected automatically.

4. **Schedule the daily run.** Enable the `pg_cron` and `pg_net` extensions,
   then run the `cron.schedule(...)` block at the bottom of
   `nation_billing.sql` (replace `<PLATFORM_REF>` and `<CRON_SECRET>`). It calls
   the function once a day at 13:00 UTC.

## Daily behaviour

For every schedule that is **active** and whose **next invoice date ≤ today**,
the function:

1. generates the next `NP-YYYY-NN` invoice number (collision-safe),
2. inserts a `nation_invoices` row from the schedule (status `sent`, due in
   `due_days`),
3. advances `next_run_date` by the cadence (holding the day-of-month anchor) and
   stamps `last_run_date` / `last_invoice`,
4. writes a `platform_audit` row (`nation_invoice_auto`), and
5. if **Auto-send** is on and a billing email is set, emails an HTML invoice via
   Resend (CCing any addresses in the schedule).

The styled **PDF** is not emailed by the scheduler — it is generated on demand
in the portal (click the invoice number). The emailed HTML invoice carries all
line items, totals and terms.

## Manual controls (admin portal)

- **Save schedule** — create/update the nation's schedule.
- **Pause / Resume** — stop or restart automated billing without deleting it.
- **Generate now** — create this period's invoice immediately (and advance the
  schedule) for testing or off-cycle billing. This one does **not** send email;
  only the automated scheduler emails.

## Testing without waiting for cron

`POST` the function directly (service side) with the secret header:

```
curl -X POST https://<PLATFORM_REF>.functions.supabase.co/recurring-invoices \
  -H "x-cron-secret: <CRON_SECRET>" -H "Content-Type: application/json" \
  -d '{"dryRun": true}'
```

- `{"dryRun": true}` reports what would be billed without writing.
- `{"subdomain": "demo"}` runs a single nation now.
- `{}` runs all due schedules (what the cron job sends).

## Dynamic pricing (per-usage banding)

A schedule row with `dynamic = true` prices each generated invoice from the app
instead of the stored line: the subscription band is chosen by the nation's
**reported home count** (`nation_usage.units_count`, pushed up by
`report-nation-usage` when a manager opens Settings -> Nation; the count comes
from `hs_data_usage()` -- migration `20261115_usage_units_count.sql`), and
add-on lines (AI Staff Assistant, SMS) are added when the module is
**explicitly** `true` in `nations.modules_licensed` (absent keys never bill).
The stored line item + amount remain as the fallback when no home count has
been reported (or above 600 homes = custom quote). The band table in
`recurring-invoices` must be kept in sync with `admin/admin.js` SUB_BANDS.
Platform columns: `nation_usage.units_count`, `nation_billing.dynamic`.
The admin Billing card has the "Dynamic pricing" toggle + a live preview, and
its "Generate now" uses the same logic.

### SMS overage + draft previews

With SMS licensed, monthly dynamic invoices also bill the published overage:
$0.05 per text beyond the included 500/month, from `nation_usage.sms_month_count`
(billable `sms_log` sends this month, reported by `hs_data_usage()` -- migration
`20261116_usage_sms_count.sql`; platform column:
`alter table public.nation_usage add column if not exists sms_month_count integer;`).
Month-to-date at report time, so it can undercount but never overbills. AI has
no overage fee by design -- the fair-use cap pauses the assistant instead; the
panel preview shows tokens used against the included 3,000,000. The Billing
card's "Preview draft invoice" button builds the exact PDF the next run would
produce (dynamic or stored), numbered DRAFT, writing nothing.

### AI overage

The AI add-on includes 3,000,000 tokens/month; the fair-use cap pauses the
assistant there by default. When the platform owner raises a nation's cap
(Config -> AI usage limit), monthly dynamic invoices bill the excess at $15 per
additional 1,000,000 tokens (fractional, 2 dp), from nation_usage's reported
month-to-date token totals. The fee schedule line is "AI tokens beyond the
included 3,000,000 (per additional 1,000,000)" and the subscription agreement's
AI add-on clause states the allotment + overage ({{FEE_AI_OVER}}).
