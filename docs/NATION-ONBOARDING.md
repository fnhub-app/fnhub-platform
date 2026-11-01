# Onboarding runbook — fnhub.app (Cloudflare Pages) + adding nations

This is the operational guide for the **FN Hub** housing platform. It has two
parts:

- **Part A — one-time platform setup** (Cloudflare Pages + the fnhub.app domain).
  You do this once.
- **Part B — add a new nation** (the repeatable checklist). One subdomain, one
  Supabase project, one directory entry.

The architecture is **subdomain-per-nation + database-per-nation**: every nation
lives at `<nation>.fnhub.app` and has its **own Supabase project** (its own data,
never shared). The single static site is served to all subdomains; at boot
`resolveNation()` (`shared-config.js`) reads the subdomain and loads that
nation's Supabase URL/key + branding from `NATIONS_DIRECTORY`.

---

## Part A — one-time platform setup

### A1. Cloudflare Pages project
1. Cloudflare dashboard → **Workers & Pages → Create → Pages → Connect to Git**.
2. Repository: `clfn92/clfn-housing-app`, production branch **main**.
3. Build settings:
   - Framework preset: **None**
   - Build command: **(leave empty)** — this is a static app, no build step
   - Build output directory: **`/`**
4. Save & Deploy. You get a `*.pages.dev` URL — test the app there first.

Response headers come from the repo's `_headers`, and `.assetsignore` keeps
internal files (`.git`, `supabase/`, docs, schema SQL) from being served. This
is a multi-page static app, so no SPA redirect/fallback is needed. No other
config is required.

### A2. Domain + wildcard (fnhub.app is already in this Cloudflare account)
On the Pages project → **Custom domains → Set up a custom domain**, add:
- `clfn.fnhub.app`   — CLFN's live URL
- `*.fnhub.app`      — **wildcard**: every future nation subdomain works with no
  further DNS/cert work
- (optional) `fnhub.app` and `www.fnhub.app` for a future landing page

Because fnhub.app is already on Cloudflare, each entry auto-creates its DNS
record and TLS certificate. `.app` is HTTPS-only by design; Cloudflare handles it.

### A3. Supabase Auth (applicant portal magic links)
In **each nation's** Supabase project (for CLFN, the existing project):
**Authentication → URL Configuration**
- **Site URL:** `https://<nation>.fnhub.app` (e.g. `https://clfn.fnhub.app`)
- **Redirect URLs:** add `https://*.fnhub.app/**` (covers every nation) plus the
  `*.pages.dev` URL while testing.

### A3b. Route Supabase Auth system emails through Resend (Custom SMTP)
App notifications, maintenance, applications, and the applicant magic link all
send through the Edge Functions (EMAIL_PROVIDER=resend). Supabase's OWN auth
emails (staff password reset, email confirmations) are separate and use
Supabase's default sender unless you also set Custom SMTP. To make 100% of
outbound mail come from fnhub.app:

Supabase -> **Authentication -> Emails -> SMTP Settings** -> Enable Custom SMTP:
- Sender email: `noreply@fnhub.app`   Sender name: `<Nation> Housing`
- Host: `smtp.resend.com`   Port: `465` (or `587`)
- Username: `resend`   Password: a Resend API key (`re_...`)

Optional: raise the auth email rate limit (Authentication -> Rate Limits) and
brand the templates (Authentication -> Email Templates). The sending domain must
be Verified in Resend (same domain as EMAIL_FROM).

### A4. Azure — decommissioned
Azure Static Web Apps has been fully retired. The static host is now **Cloudflare
Workers** (`.github/workflows/deploy-cloudflare.yml` + `wrangler.jsonc`); response
headers/CSP live in `_headers`. The Azure deploy workflow and `staticwebapp.config.json`
have been deleted from the repo. Remaining Azure teardown is on the Azure side only:
delete the Static Web App resource in the Azure Portal and remove the
`AZURE_STATIC_WEB_APPS_API_TOKEN_*` GitHub Actions secret.

- The Supabase Edge Function CI (`.github/workflows/deploy-supabase-functions.yml`)
  is independent of the static host — leave it.

---

## Part B — add a new nation

> Prerequisite: **the fresh-DB bootstrap script must exist** (see "Make it easy",
> item 1). Without it, "create the DB" below is a manual, error-prone schema
> rebuild. With it, the whole nation stands up in ~30 minutes.

### B1. Create the nation's Supabase project
1. Supabase → **New project** (name it for the nation). Choose a region close to
   the nation. Save the project ref (e.g. `abcd1234...`) and the **anon** key
   (Settings → API → `anon`/`publishable` — safe to ship client-side).
2. **Run the bootstrap schema** in the SQL editor (one paste — see item 1 below):
   all tables, RLS, triggers, functions, sequences.
   > **Note (2026-10):** the committed `supabase/bootstrap/schema.sql` predates two
   > migrations that have since landed — `20261031_sms_notifications.sql` (SMS consent
   > columns + `sms_optouts`/`sms_log`) and `20261101_contractor_portal_b1.sql`
   > (`contractor_users`/`contractor_invites`/`contractor_work_orders` +
   > `current_contractor_id()`). Until the bootstrap dump is re-captured (see item 1),
   > also run those two migration files after the bootstrap paste so a new nation is at
   > schema parity. They are additive and safe to run in order.
3. **Storage:** create the `housing-files` bucket (private).

### B2. Deploy the Edge Functions to the new project
Each Supabase project has its own functions. Either:
- **Manually (once):** `supabase functions deploy <fn> --project-ref <newref>`
  for `ai-chat`, `send-notification`, `tenant-mr`, `applicant-intake`,
  `send-sms` (if the SMS module is licensed), and `contractor-claim` (if the
  Contractor Portal module is licensed), **or**
- **Via CI:** add the new project ref to the deploy matrix (see item 2 below).

> Both new functions verify their own JWT, so **do not** pass `--no-verify-jwt`
> (unlike `email-intake`): `contractor-claim` verifies the caller's phone-auth
> JWT, and `send-sms` verifies an active-staff JWT.

Then set that project's **Edge Function secrets** (Project Settings → Edge
Functions → Secrets):
- Email provider: `EMAIL_PROVIDER` (`graph` | `resend` | `sendgrid`) + its keys.
  A nation without M365 can use Resend/SendGrid (`RESEND_API_KEY`/`SENDGRID_API_KEY`
  + `EMAIL_FROM`).
- `EMAIL_BRAND`, `EMAIL_REPLY_TO` — that nation's brand + reply-to.
- `APP_URL` = `https://<nation>.fnhub.app` (so email links point to their site).
- `ANTHROPIC_API_KEY` if the AI assistant module is licensed for them.
- Optional: `HOUSING_MR_NOTIFY_TO`, `HOUSING_APP_NOTIFY_TO` to route the
  maintenance/application notifications to a shared mailbox.
- **SMS (only if the `sms_notifications` or `contractor_portal` module is
  licensed)** — the `send-sms` function needs:
  - `SMS_PROVIDER` = `twilio` (the only provider wired today; `telnyx` is stubbed).
  - `TWILIO_ACCOUNT_SID` + `TWILIO_AUTH_TOKEN` — **per nation.** Give each nation
    its own Twilio **subaccount** (STOP/opt-out state and sender reputation stay
    isolated; billing rolls up to the parent account). The auth token goes **only**
    into this secret — never into the repo, chat, or the directory entry.
  - `SMS_FROM` — the nation's Twilio number in E.164 (e.g. `+17059605076`), **or**
    `TWILIO_MESSAGING_SERVICE_SID` if they use a Messaging Service (recommended once
    there's more than one number). Set one or the other.
  > The **Contractor Portal login** (SMS one-time code) does **not** go through
  > `send-sms` — it uses Supabase's own phone auth (next step, B2b). `send-sms`
  > powers the staff/field/contractor **notification** texts only.

### B2b. Phone auth for the Contractor Portal (only if `contractor_portal` is licensed)
The portal's one-time-code login uses **Supabase phone auth backed by Twilio
Verify** (separate from the `send-sms` notification path). In the new project:
**Authentication → Providers → Phone → enable**, then set the SMS provider to
**Twilio Verify** and fill:
- Twilio **Account SID** + **Auth Token** (the nation's subaccount, same as B2).
- The **Verify Service SID** — create one in Twilio: **Verify → Services → Create**
  (friendly name e.g. `<Nation> Contractor Portal`), copy its `VA…` SID.

Leave email/password auth as-is; this only adds the phone channel. No `SMS_FROM`
is used here — Twilio Verify owns the sender. Test: open
`https://<nation>.fnhub.app/contractor-portal.html`, request a code to a number on
a contractor's record, and confirm the text arrives. (A number with no matching
`contractor_invites` row will verify but land on "Not set up yet" — that's the
intended triage-first behaviour.)

### B3. Auth URL config for the new project
Repeat **A3** in the new project (Site URL = their subdomain; Redirect URLs
include `https://*.fnhub.app/**`).

### B4. Add the directory entry (the only code change)
In `shared-config.js`, add one entry to `NATIONS_DIRECTORY` keyed by the
subdomain label:

```js
'listuguj': {                                  // -> listuguj.fnhub.app
  id:            'listuguj',
  display_name:  'Listuguj Mi\'gmaq Government',
  short:         'LMG',
  supabase_url:  'https://<newref>.supabase.co',
  supabase_anon: '<their anon key>',
  portal_base:   'https://listuguj.fnhub.app',   // canonical URL for QR codes / public links
  email_domain:  'listuguj.ca',
  housing_email: 'housing@listuguj.ca',
  landlord_committee: 'Housing Committee',
  mailing_po_box: 'P.O. Box ...', mailing_postal: '...', province: 'Quebec',
  role_labels:   {},
  // null / omitted = all licensed. Name a module to license/unlicense it.
  modules_licensed: { finance:false, match:true, rfq:true,
                      sms_notifications:true, contractor_portal:true },
  // Optional SMS display config (NO secrets here — the auth token lives in the
  // send-sms Edge Function secret). Injected into sendSms() at boot.
  sms_config:    { from: '+1xxxxxxxxxx' }   // display/sender hint only
}
```

Commit + push → CI redeploys the site. `*.fnhub.app` already routes the
subdomain, so `listuguj.fnhub.app` is now live.

> **Licensed vs enabled.** Listing a module in `modules_licensed` makes it
> *available* to the nation; it is still **off** until a super-user flips it on in
> **Settings → Nation → Modules** (persists to `housing_settings`). After B1–B4,
> turn on `sms_notifications` and/or `contractor_portal` there. Per-event SMS
> defaults (which notifications also text) are set in **Settings → Notifications**.
> **Never hardcode the nation into any of this** — it all flows from the directory
> entry + settings (OCAP rule).

### B5. Seed + verify
1. Add the nation's first **staff** rows (their `staff` table): at least one ED,
   with `is_active = true`. Staff sign in with those emails.
2. Confirm branding (name/short/colors) shows correctly on their subdomain.
3. Load a unit + an application to sanity-check the flow.
4. If they use the tenant QR / applicant portal, confirm a magic link returns to
   `https://<nation>.fnhub.app/...`.
5. **If SMS is on:** turn on `sms_notifications` in Settings → Nation → Modules,
   opt a test staff member in (their Users-row **📱 Text alerts** button), and
   send a test (`await window.sendSms({to:'+1…', body:'test'})` from the console,
   or trigger a work-order assignment). A `{ok:true, sid:'SM…'}` result confirms
   the provider + secrets are wired.
6. **If the Contractor Portal is on:** confirm `contractor-portal.html` loads,
   requests a code, and (with a matching invite) shows the work-order list.

**Per-nation checklist:** ☐ Supabase project ☐ bootstrap schema ☐ **+ SMS &
portal migrations** ☐ storage bucket ☐ functions deployed (**incl. send-sms /
contractor-claim if licensed**) ☐ function secrets (**incl. Twilio if licensed**)
☐ **phone auth / Twilio Verify (if portal)** ☐ auth URLs ☐ directory entry
(**+ module flags / sms_config**) ☐ staff seeded ☐ **modules enabled in Settings**
☐ verified.

---

## Make it easy (recommended enablers)

These turn Part B from "careful manual work" into a short checklist:

1. **Fresh-DB bootstrap script (highest priority).** Today the repo has only
   *incremental* migrations, not a full schema. Capture the complete schema once
   from the CLFN project and commit it as `supabase/bootstrap/schema.sql`, so
   step B1.2 is a single paste. Produce it with:
   ```
   supabase db dump --project-ref fkhzrbalumzeripzolph --schema public -f supabase/bootstrap/schema.sql
   ```
   (or `pg_dump --schema-only --no-owner --no-privileges` against the project's
   connection string). Review it, strip any CLFN-specific seed data, commit.

2. **Multi-project function deploy.** Extend
   `.github/workflows/deploy-supabase-functions.yml` to loop over a list of
   `{project_ref, access_token}` pairs (GitHub secret or a JSON matrix) so a push
   deploys every nation's functions at once, instead of deploying each new
   project by hand.

3. **Nation config as data (later).** `NATIONS_DIRECTORY` can be swapped for a
   fetched `nations.json` (same shape) so adding a nation needs no code deploy at
   all — just a config update. The resolver already supports this shape.
