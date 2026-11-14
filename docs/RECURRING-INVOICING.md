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

1. generates the next `HLH-YYYY-NN` invoice number (collision-safe),
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
