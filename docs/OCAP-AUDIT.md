# OCAP Data-Sovereignty Audit — Nation Pathways

_Audit date: 2026-11-24. Scope: the housing SPA (root `*.js` / `*.html`), the
Supabase Edge Functions (`supabase/functions/**`), the row-level-security
migrations, and the control-plane (admin) project. Method: static review of
data flows, external hosts, the CSP, RLS tiers, and every cross-nation path._

OCAP® (Ownership, Control, Access, Possession) is the First Nations Information
Governance Centre's framework for community data sovereignty. This audit maps
the platform against each principle. OCAP® is a registered trademark of the
FNIGC; this document is a self-assessment, not a certification.

---

## Summary

**The OCAP posture is strong by design.** Each nation runs in its **own Supabase
project** (database-per-nation) on its **own subdomain**, behind **RLS**, with
**no third-party analytics or telemetry** anywhere in the codebase, and with
geocoding deliberately routed through **OpenStreetMap/Nominatim instead of
Google**. Those are the hard parts, and they are done.

The findings are **governance and transparency gaps, not architectural breaks**:
third-party *sub-processors* (AI, email, SMS) that handle community data are not
disclosed to nations as a register; two small **vendor-held copies** of nation
data exist in the control plane (usage metrics and a light support-ticket
mirror); and the site loads **Google Fonts**, which leaks viewer IPs to Google.
All are fixable without re-architecting.

| Principle | Posture | Headline gap |
|-----------|---------|--------------|
| **Ownership**   | Strong | Vendor holds usage metrics + mirrored support tickets |
| **Control**     | Good   | Sub-processors (AI/email/SMS) not disclosed/consented as a register |
| **Access**      | Good   | No single "download all my data" export for a community member |
| **Possession**  | Strong | Verify each nation's Supabase **region = Canada**; vendor-held copies above |

---

## Third-party sub-processors (data-flow register)

Every external destination community data can reach. **The community's browser
only ever talks to Supabase, the CDNs, Google Fonts, and the OSM map frame** —
the AI, email, and SMS providers are called **server-side from Edge Functions**,
never from the browser (confirmed against the CSP `connect-src` in `_headers`).

| Processor | Community data sent | Called from | Gate | Note |
|-----------|---------------------|-------------|------|------|
| **Anthropic** (AI) | applications, units, maintenance requests, notes, policy, FAQ — incl. names/household | `ai-chat`, `support-chat` (server) | `ai_assistant` module; role-gated; audit-logged; no write tools | Community PII processed by a US AI vendor. Disclose + minimize + confirm retention. |
| **Microsoft Graph / Resend / SendGrid** (email) | email bodies + the **applicant PDF** (a full application, lots of PII) | `send-notification` (server) | per-nation `EMAIL_PROVIDER` | Graph sends from the nation's own mailbox; Resend/SendGrid use a shared sender. |
| **Twilio / Telnyx** (SMS) | phone number + message text (names, addresses, statuses) | `send-sms` (server) | `sms_notifications` module **+ explicit opt-in** | Consent-based — the strongest flow. |
| **OSM Nominatim** (geocoding) | unit addresses | `geocode-units.ps1` (user-run, not CI) | `mapping` | OCAP-friendly: no Google, no API key, rate-limited. Deliberate choice. |
| **OpenStreetMap** (map tiles + embed) | unit latitude/longitude | TIC map (browser `frame-src`) | `mapping` module | Reveals unit locations to OSM. |
| **Google Fonts** | viewer IP (no PII) | every page (browser) | none | IP leak to Google. Self-host to remove. |
| **cdnjs / jsDelivr** | viewer IP; serves library code | jsPDF / Chart.js / Leaflet / exifr (browser) | none | Dependency + IP exposure. |
| **GitHub (raw)** | none (pulls the platform's own SQL) | `provision-nation`, `run-nation-migration` (server) | — | Supply-chain, not data egress: pin/verify. |

No Google Analytics, Tag Manager, Sentry, Mixpanel, Segment, PostHog, Hotjar,
FullStory, Amplitude, or Datadog appears anywhere — **the app does no
third-party user tracking.**

---

## Ownership — _the data belongs to the Nation_

**Strengths**
- **Database-per-nation + subdomain-per-nation** (`shared-config.js` `NATIONS_DIRECTORY` / `resolveNation`; `PLAN.md` Phase N). A nation's records live in that nation's own Supabase project — not a shared multi-tenant table.
- Supabase **anon keys are publishable**; access is enforced by RLS, not by key secrecy.
- The marketing posture ("your database, your subdomain, your branding") matches the implementation.

**Concerns**
- The **control-plane (vendor) project holds copies** of some nation data:
  - `nation_usage` — metrics only (bytes, AI tokens, unit count, SMS count) **plus `reported_by` = a staff email** (`report-nation-usage`). No resident PII.
  - `platform_support_tickets` — a **light mirror of each support ticket**: subject, body, and **reporter name / email / phone** (`support-forward` → `platform-ticket-intake`). Attachments and the chat transcript are deliberately **excluded**.
- These are intentional product features (fleet billing; a cross-nation support inbox), but they are vendor-held community data and should be disclosed.

---

## Control — _the Nation decides how data is collected, used, and shared_

**Strengths**
- **Module system** lets a nation switch off whole data flows: `ai_assistant` (no data to Anthropic), `sms_notifications`, `mapping` (no OSM), `email_intake`, etc. (`CLFN_MODULES`, Settings → Nation → Modules).
- **Tight CSP** (`_headers`): `default-src 'self'`; `connect-src` limited to `*.supabase.co`, Microsoft login/Graph, and the two CDNs; `frame-src` only `openstreetmap.org`; `frame-ancestors 'none'`.
- **Consent-based SMS** — texts only go to staff/tenants/contractors/members who explicitly opted in with a mobile on file, and every message carries "reply STOP."
- The AI tools are **read-only and role-gated** (`ai-chat` `TABLES` allowlist; stuffed-context gating), and every AI call writes an append-only audit row.

**Concerns / gaps**
- **No sub-processor register / data-flow disclosure** is surfaced to a nation. A nation cannot see, in-product, that Anthropic, Microsoft/Resend/SendGrid, and Twilio/Telnyx process its data — which is squarely an OCAP *Control* expectation.
- **Email carries the most PII** (the applicant-confirmation PDF is a whole application) and email is effectively core (not module-gated the way AI is).
- **AI minimization**: the chat context is trimmed and role-gated, but still ships resident names/household to a US vendor. There is no per-nation "exclude PII from AI" switch and no in-repo statement of Anthropic's retention terms.

---

## Access — _the community can reach its own information_

**Strengths**
- **RLS tiers** (`20260703_rls_lockdown.sql`): active staff SELECT their nation's data; members and contractors see **only their own** rows (applicant/contractor portal RLS).
- Community-facing **portals**: members apply, track status, report maintenance, and now opt into texts; contractors see their own work orders.
- **Exports** exist (CSV/Excel via `_doExport`, PDF generators, CMHC/ISC/Council reports) — the nation can get its data out.
- **Append-only audit log** (`housing_audit_log`, trigger + RLS enforced) gives the community an access/accountability trail.

**Concerns / gaps**
- No single **"download all my data"** (portability) action for an individual community member — access is via staff exports and the portal's own views, not a one-click personal data export.
- Worth confirming a nation can obtain a **full database export** on request (Supabase supports it at the project level; make it a documented right).

---

## Possession — _data is held in an isolated workspace that is the Nation's_

**Strengths**
- Each nation's data sits in its **own, isolated Supabase project** — not a shared schema.
- **Region is chosen per nation at onboarding** for data residency (`docs/NATION-ONBOARDING.md`, `supabase/README.md` both call this out) — e.g. a Canadian region.
- **Audit immutability**: `finance_audit_log` / `housing_audit_log` block UPDATE/DELETE at the DB level (triggers + RLS).

**Concerns / gaps**
- **Region is a manual onboarding step, not an enforced gate** — a mis-provisioned project could land outside Canada. Make "region = Canada (or nation's choice)" a provisioning checklist item that is verified.
- The vendor-held copies under *Ownership* (usage, support mirror) live in the control-plane project, i.e. **outside the nation's isolated workspace**.
- AI processing is **transient at Anthropic** — verify a zero-/low-retention arrangement so no durable community-data copy sits with the AI vendor.

---

## Recommendations (prioritized)

1. **Publish a sub-processor register + per-nation data-flow disclosure** (Control). One page, in Settings or onboarding, naming Anthropic, the email provider, the SMS provider, OSM, Cloudflare, and Google Fonts, and what each receives.
2. **Self-host the fonts** (or use a system-font stack) to remove the Google-Fonts IP leak — quick, no behaviour change.
3. **Support-ticket mirror**: disclose it, add a **per-nation opt-out**, and/or **strip reporter name/email/phone** from the mirrored copy (it currently forwards all three). The platform inbox can work from subject/body + nation + a ticket id.
4. **AI governance**: document Anthropic's retention in-repo; consider a per-nation **"keep resident PII out of AI"** toggle and/or a zero-retention agreement; keep the existing role-gating + audit.
5. **Enforce region at provisioning** — make "Supabase region = Canada/nation's choice" a verified checklist gate, not just advice.
6. **Add a member "download my data" export** (portability) to the portal.
7. **Pin/verify the SQL** that `provision-nation` and `run-nation-migration` fetch from public GitHub at runtime (supply-chain hardening).
8. **Minor minimization**: drop or hash `reported_by` (staff email) in `nation_usage`.

**Nothing here is an OCAP break** — the hard sovereignty guarantees (isolation,
RLS, no tracking, OCAP-friendly geocoding, consent-based SMS) hold. The work is
disclosure, minimization, and two governance switches.
