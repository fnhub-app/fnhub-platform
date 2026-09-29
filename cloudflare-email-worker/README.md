# Housing Email Intake — Cloudflare Email Worker

Forward an email to a routed address (e.g. `files@clfn.on.ca`); this Worker
parses it and hands it to the Supabase `email-intake` Edge Function, which
stores the body + attachments and creates one **triage** row in `email_intake`.
Staff then assign it to a unit / tenant in the app. **Nothing is auto-filed** —
triage-first by design.

```
Forwarded email
   → Cloudflare Email Routing (files@clfn.on.ca)
      → this Email Worker (parses MIME, base64s attachments)
         → POST https://<project>.supabase.co/functions/v1/email-intake  (x-intake-secret)
            → stores body + attachments in Storage, inserts an email_intake row
               → staff triage + assign in the app → filed to the unit's documents
```

## One-time setup

**1. Create the table** — run `supabase/migrations/20260929_email_intake.sql`
in the Supabase SQL Editor.

**2. Deploy the Edge Function** — `supabase/functions/email-intake/`. Paste it
into the Supabase Dashboard (Edge Functions) or `supabase functions deploy
email-intake`. Then set its secrets (Project Settings → Edge Functions →
Secrets):
- `EMAIL_INTAKE_SECRET` — a long random string you generate (shared with the Worker).
- `STORAGE_BUCKET` — optional; defaults to `housing-files`.
- (`SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` are provided automatically.)

**3. Deploy this Worker** — from this folder:
```bash
npm install
# set the shared secret to the SAME value as step 2:
npx wrangler secret put EMAIL_INTAKE_SECRET
npx wrangler deploy
```
Confirm `EMAIL_INTAKE_URL` in `wrangler.toml` points at this nation's Supabase
project.

**4. Route the address** — in the Cloudflare dashboard for the domain:
Email → **Email Routing** → enable it (Cloudflare walks you through the MX/DNS
records) → **Routing rules** → add the intake address (e.g. `files@clfn.on.ca`)
→ action **Send to a Worker** → pick **housing-email-intake**.

Optionally set `FORWARD_ON_FAIL` (a real mailbox) in `wrangler.toml` so a failed
intake POST re-forwards the original email instead of dropping it.

## Test

Forward any email (with an attachment) to the routed address. Within a few
seconds a row should appear in `email_intake` (status `new`) with the body and
attachments in Storage under `email-intake/<id>/`, plus any suggested unit/tenant
matches. It then shows up in the app's triage queue for filing.

## Notes

- The Worker is a **separate** Cloudflare Worker from the nation site and the
  admin panel. It is excluded from the nation site's public assets via
  `.assetsignore`.
- Attachments are capped (default 8 MB each, 15 max). Oversized or odd parts are
  skipped, never the whole email.
- Dedupe is on the email `Message-ID` (a unique index on `email_intake`), so a
  double-delivery won't create two rows.
