# Contractor Portal — Design (for approval)

Status: **DESIGN / not built.** Decisions locked with the ED (2026-10-31):
**full portal design before any code**, and the contractor data boundary is
enforced by **real Supabase Row-Level Security (RLS)**, not client-side gating.

This document is the plan to approve. Nothing here is implemented yet.

---

## 1. What it is

A separate, **module-gated** surface where a contractor (and their key contacts)
log in to see **only their own** work, submit updates, and upload documents.
Everything they do is audited and routed to housing for verification/approval.

The nine requested features:

1. Login with **text (SMS one-time-code) authentication**
2. Work-order **dashboard** — Active / In-process / Closed
3. Add **photos + notes** to a work order
4. Upload **invoices** → sent to housing for payment
5. On assignment, **text the contractor**; when a contractor is selected, **all
   key people** are shown so each can receive the text; **multiple contractors**
   may receive it
6. Update **project completion %**
7. **Fully auditable**; housing is **notified** and items land on the staff
   landing page for **verification + final approval**
8. Delivered as a **module that can be turned on/off**
9. Upload **new WSIB + liability insurance**

## 2. The crux: a real security boundary (why this is Phase B, not a quick add)

Today the app trusts the client — the browser holds the anon key and all access
control is JavaScript. That is safe for **vetted staff** and unsafe for **outside
logins**. A contractor must be **unable** to see any nation data except their own
awarded work, and that guarantee cannot live in client JS they could bypass.

**The fix (locked): Supabase RLS.** Every table a contractor can read gets a
policy that scopes rows to the authenticated contractor via `auth.uid()`. The
portal uses the same Supabase project as staff, but the database itself refuses
to return another contractor's (or the nation's) rows to a contractor session.

This also **unblocks the parked tenant/member portal** later — same foundation.

### 2.1 Identity model

- **Supabase Auth (phone) is the identity.** Contractor logs in with their
  mobile; Supabase issues an OTP by SMS; a successful code mints a real
  `auth.users` row with a stable `auth.uid()`.
- **`contractor_users` (new table)** maps an auth user to a contractor:
  `{ auth_user_id uuid PK, contractor_id, display_name, phone E.164, role
  ('owner'|'contact'), is_active, invited_by, created_at }`.
  A contractor can have **several** portal users (the company + each key
  contact), which is why this is its own table rather than a single column on
  `housing_contractors`.
- **Onboarding is invite/claim, never self-assert.** Staff pick a contractor +
  one of its key-contact phones and send an invite; only a phone **already on
  that contractor's record** can be linked (prevents a stranger from claiming a
  contractor by typing its name). First successful OTP on an invited phone
  creates the `contractor_users` row.

### 2.2 Authentication: SMS one-time code (Supabase phone auth via Twilio)

- Use **Supabase Auth's native phone provider**, configured with **Twilio** (we
  already have the account + Canadian number). Supabase handles OTP generation,
  delivery, expiry, and rate-limiting — we do **not** roll our own OTP.
- The portal never sees the anon key as an authority; after OTP the contractor
  holds a normal Supabase JWT and **RLS does the enforcement**.
- Reuse / separate from the staff `send-sms` path: OTP delivery is Supabase's
  own Twilio integration (Auth → Phone), independent of our transactional
  `send-sms` function. (One Twilio account can serve both; consider a Twilio
  **Verify** service for OTP to keep auth traffic separate from notifications.)

### 2.3 RLS policy shape (per table)

Core predicate for contractor reads/writes:

```
exists (
  select 1 from public.contractor_users cu
  where cu.auth_user_id = auth.uid()
    and cu.is_active
    and cu.contractor_id = <row's contractor_id>
)
```

Staff keep their existing email-based policies; contractor policies are **added
alongside**, never replacing. A row is visible to a contractor only through the
`contractor_users` link. **Storage** gets matching policies so a contractor can
only read/write objects under their own contractor path.

## 3. Separate portal surface (not the staff SPA)

- A distinct, minimal front-end — a new top-level page set (e.g.
  `contractor-portal.html` + `contractor-portal-*.js`), ideally on its own
  **subdomain** (`contractors.<nation>.fnhub.app`) via the existing per-nation
  hostname routing. Contractors **never load the staff bundle**.
- It loads only the shared config/auth layer + portal JS. All data access is the
  contractor's own authenticated Supabase session (RLS-scoped).
- Gated by the **`contractor_portal` module** (see §6).

## 4. Data model / migrations (new)

- **`contractor_users`** — §2.1 (auth linkage; the heart of RLS).
- **`housing_contractors`** — reuse existing (name, people[] with phones,
  WSIB #/expiry, insurance provider/expiry). Add nothing structural beyond the
  link via `contractor_users`.
- **`contractor_invoices` (new)** — `{ id, contractor_id, sow_unit_id,
  sow_project_number, amount, file_path, status
  ('submitted'|'under_review'|'approved'|'rejected'|'paid'), note,
  submitted_at, reviewed_by, reviewed_at, decision_note }`. Append-style; status
  transitions are staff-driven and audited.
- **Work-order progress** — reuse `housing_reno_progress` (the existing
  completion %, timeline, photos); contractor writes are RLS-scoped + audited.
- **Photos / notes / insurance docs** — reuse **DocLibrary** (Supabase Storage +
  `file_uploaded` meta). Contractor uploads land under the unit/contractor path
  and surface on the staff side exactly like today's files.
- **Audit** — reuse `housing_audit_log`; `actor` = the contractor's portal
  identity (phone/email), `entity_type` = `contractor`/`sow`/`invoice`.

Every table above is append-only/audited and RLS-scoped. Migrations run by the
user in the Supabase SQL Editor, fleet-wide, as usual.

## 5. Feature-by-feature

| # | Design |
|---|--------|
| 1 | **SMS-OTP login** — Supabase phone auth (Twilio). Invite/claim links a phone to a contractor via `contractor_users`. |
| 2 | **Dashboard** — reads the contractor's **awarded RFQs / assigned SOWs** (RLS-scoped), bucketed **Active** (awarded, not started) / **In-process** (progress started, < 100%) / **Closed** (completed/approved). |
| 3 | **Photos + notes** — DocLibrary upload + a note field on each work order; writes audited; fires a housing notification; appears in the staff verification queue. |
| 4 | **Invoice upload** — writes a `contractor_invoices` row + the file; surfaces in a housing **payment-verification** worklist section for approve/reject; on approve it can hand to the finance module later. Notifies housing. |
| 5 | **Assign → text (staff-side)** — when staff assign/award, show **every key contact** of the selected contractor(s) with a phone + SMS consent as **individually selectable** recipients (reuses today's SMS + the two-checkbox recipient pattern); **supports multiple contractors** on one send. This piece does **not** need the portal and could ship first if you change the sequencing. |
| 6 | **Completion %** — contractor updates progress → writes `housing_reno_progress` (RLS-scoped) → audited → notifies housing → shows on the reno-approvals/Progress columns staff already use. |
| 7 | **Auditable + verify** — every portal action writes `housing_audit_log`; a `notify<ContractorEvent>()` fires to housing (notifications registry, email + optional SMS); a **"Contractor submissions to verify"** worklist section on the landing page gives staff final approval. |
| 8 | **Module toggle** — register `contractor_portal` in `CLFN_MODULES` (auto-surfaces a Settings → Nation → Modules toggle; per-nation licensable). Gates the portal surface + the staff-side entry points. |
| 9 | **WSIB / liability upload** — contractor uploads new certificates + expiry dates; staff are notified; verification updates the compliance flags the **RFQ eligibility** check already reads (`_rfqContractorEligibility`). |

## 6. Module & gating

`contractor_portal` in `CLFN_MODULES._enabled`/`_licensed` + a `MODULE_LABELS`
entry ("Contractor Portal"). `moduleOn('contractor_portal')` gates the portal
redirect and every staff-side entry point. Per-nation licensable like every
other module.

## 7. OCAP / privacy

Data stays in the nation's own Supabase project. A contractor sees only their
own awarded work and documents (RLS-enforced, not client-trusted). Every action
is audited. No contractor-facing data leaves the nation's control.

## 8. Proposed build phases (within Phase B)

- **B1 — Security foundation (the big one).** `contractor_users` + RLS policies
  on every contractor-readable table + Storage policies; Supabase phone auth via
  Twilio; staff invite/claim flow; **one read-only screen** that proves a
  contractor sees only their own rows. Nothing ships to real contractors until
  this is proven.
- **B2 — Dashboard** (#2) on the proven boundary.
- **B3 — Uploads** (#3 photos/notes, #4 invoices, #9 insurance) + the housing
  verification worklist section (#7).
- **B4 — Completion % (#6)** + notifications polish (#7).
- **B5 — Staff-side assignment texting (#5)** — independent of the portal;
  can move earlier if you want value sooner.
- Module toggle (#8) lands in B1 so the whole thing is gated from day one.

## 9. Open decisions / risks (flag before B1)

1. **OTP cost + provider** — Supabase phone auth sends an SMS per login attempt
   (~1–2¢ each) via Twilio; confirm a **Twilio Verify** service vs. raw
   messaging for OTP, and expected login volume.
2. **Subdomain** — stand up `contractors.<nation>.fnhub.app` (Cloudflare route),
   or run the portal as a path on the existing host for v1.
3. **Multiple logins per contractor** — confirm each key contact gets their own
   phone login (the `contractor_users` model assumes yes).
4. **Invoice → payment** — does an approved invoice feed the **finance module**
   now, or just a verification/export for v1?
5. **RLS rollout risk** — adding RLS touches shared tables; staff policies must
   be re-verified so nothing staff-facing breaks. This is the main engineering
   risk and why B1 includes a proof screen.
6. **Existing `_sb = null` dead code / raw-fetch model** — the portal must use a
   genuine authenticated Supabase session (not the staff anon-key pattern), so
   the portal's data layer is written against the contractor JWT from the start.

## 10. Effort / honest take

Multi-week. **B1 (RLS + auth) is 60–70% of the effort and risk**; the screens
are comparatively quick once the boundary is proven. The value is real — a
secure contractor portal — but the cost is almost entirely the security
foundation, which also pays forward to the tenant portal. Do **not** build
portal screens before B1 is approved and proven.
