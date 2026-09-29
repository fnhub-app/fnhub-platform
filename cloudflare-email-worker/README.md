# Housing Email Intake — Cloudflare Email Worker (generic, multi-nation)

Staff forward an email to `<nation>@fnhub.app` (e.g. `clfn@fnhub.app`); this
Worker parses it, resolves WHICH nation from the recipient's local part, looks
that nation's Supabase project up in the platform registry, and hands the email
to that nation's `email-intake` Edge Function, which stores it and creates one
**triage** row. Staff assign it to a unit / tenant in the app. **Nothing is
auto-filed** — triage-first by design.

**One generic worker serves every nation** — a nation enrolled in the registry
works automatically, no per-nation worker or code change.

```
Forwarded email  ->  Cloudflare Email Routing (<nation>@fnhub.app)
  -> this Email Worker (parses MIME; resolves nation; looks up nations_public)
     -> POST https://<that nation>.supabase.co/functions/v1/email-intake  (x-intake-secret)
        -> stores body + attachments, inserts an email_intake row
           -> staff triage + assign in the app -> filed to the unit's documents
```

## One-time setup

**1. Create the table (fleet-wide)** — run the `email_intake` migration on every
nation (the admin fleet-migration page, or each SQL Editor).

**2. Deploy the Edge Function (fleet-wide)** — `supabase/functions/email-intake/`
deploys to every nation via the `deploy-supabase-functions.yml` workflow (it is
in the `--no-verify-jwt` list, since it authenticates with its own secret).

**3. Set the shared secret on EVERY nation** — Supabase → each project → Project
Settings → Edge Functions → Secrets → `EMAIL_INTAKE_SECRET` = the SAME value on
all nations. (Only nations you turn intake on for strictly need it.)

**4. Deploy this Worker** — from this folder `npm install && npx wrangler deploy`
(or paste `worker.js` into the dashboard Email Worker editor). Set the secret to
the SAME shared value:
```bash
npx wrangler secret put EMAIL_INTAKE_SECRET
```

**5. Route the address(es)** — Cloudflare → **fnhub.app** → Email → **Email
Routing** → enable it (auto-adds the MX/TXT records) → **Routing rules** →
**Create routing rule** → pattern = the nation subdomain (e.g. `clfn`) → action
**Send to a Worker** → `housing-email-intake`. The local part must equal the
nation subdomain. (A catch-all rule to the worker also works and covers every
nation with one rule.)

Do **NOT** enable Email Routing on a nation's own mail domain (e.g. `clfn.on.ca`)
if it uses Microsoft 365 / Google — it would take over the MX and break that
mail. Use `<nation>@fnhub.app`, or have the mail admin auto-forward a friendly
address to it.

## Per-nation config in the app

Each nation's forward-to address is shown to staff on the Email Intake page and
is editable in **Settings → Nation → Email Intake Address** (`intake_email`,
default `<nation>@fnhub.app`). The app only displays/stores it; the matching
Cloudflare routing rule is still set here.

## Test

Forward an email (with an attachment) to `clfn@fnhub.app`. Within a few seconds a
row appears in that nation's `email_intake` (status `new`) and in the app under
**Operations → Email Intake**, showing "Forwarded by <employee>".

## Notes

- Separate Cloudflare Worker from the nation sites + admin panel; excluded from
  the nation site's public assets via `.assetsignore`.
- Attachments are capped (default 8 MB each, 15 max); oversized/odd parts are
  skipped, never the whole email.
- Dedupe is on the email `Message-ID` (a unique index on `email_intake`).
- The registry anon key embedded in `worker.js` is the publishable key (ships to
  every browser) — safe to embed.
