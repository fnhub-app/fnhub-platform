# Contractor Portal — B1 (Security Foundation) — Scope

Status: **SCOPE / not built.** Detailed spec for B1, the first phase of the
Contractor Portal (see `docs/contractor-portal-design.md` for the overall
design). B1 builds and **proves** the data boundary; it ships no contractor
features beyond a throwaway proof screen.

---

## 1. Goal / definition of done

A contractor signs in by **SMS one-time code** and, querying with **their own
Supabase JWT**, can read **only their own rows** from contractor-owned tables.
Specifically, B1 is done when all of these hold against the live nation DB:

1. **Positive:** contractor A logs in → a minimal "My Work Orders" screen shows
   only A's assigned work orders.
2. **Negative (cross-tenant):** A cannot read B's rows — a direct query for B's
   row returns **nothing** (denied at the database, not hidden in JS).
3. **Negative (unauth):** without a valid contractor session, the contractor
   tables return nothing.
4. **Staff unaffected:** every existing staff screen/flow still works exactly as
   before (this is the main risk — see §6).

If any of these fail, B1 is not done. No real contractor is onboarded until all
four pass.

## 2. Key finding — "full RLS" vs how SOWs are stored today

The locked choice is **real RLS on tables the contractor queries directly**. But
`housing_sow` stores **one row per unit** with all that unit's work orders inside
a `data` jsonb array, and the contractor assignment lives *inside* that array.
Row-level security is **row**-level — it can't scope "this contractor sees these
array elements." So we cannot simply flip RLS on `housing_sow`.

**Resolution (still genuine RLS, not an edge-function facade):** serve the
contractor a **normalized projection table** — `contractor_work_orders` — with
one row per assigned work order and `contractor_id` as a real column. The
contractor queries *that* table directly with their JWT; RLS on it is natural
and strict. The projection is kept in sync from the existing SOW save path
(staff-side writes), so it's a read model for contractors, not a second source
of truth. This reconciles the thorough-RLS decision with the jsonb shape.

The same applies to other contractor reads (invoices, insurance, progress):
contractor-facing tables are **new, normalized, and RLS-from-birth**, so B1
never has to retrofit RLS onto the big jsonb staff tables to prove the boundary.

## 3. Workstreams

### 3.1 Identity — `contractor_users` + invite/claim
- **`contractor_users`** `{ auth_user_id uuid PK (FK auth.users), contractor_id,
  display_name, phone E.164, role ('owner'|'contact'), is_active, invited_by,
  created_at }`. One row per person who can log in for a contractor.
- **Invite/claim (anti-impersonation):** a staff action picks a contractor + one
  of its key-contact phones (already on `housing_contractors.people`) and marks
  it invite-eligible (`contractor_invites` `{ phone, contractor_id, role,
  invited_by, expires_at, used_at }`). **Only an invited phone that already
  exists on that contractor's record** can become a `contractor_users` row.
  First successful OTP on an invited phone activates the mapping (an Edge
  Function with service role creates the `contractor_users` row after verifying
  the invite — the client can't self-link).
- RLS on `contractor_users`: a row is self-readable (`auth_user_id = auth.uid()`);
  staff can read/manage via their existing staff policy.

### 3.2 Auth — Supabase phone OTP (Twilio)
- Configure **Supabase Auth → Phone** with **Twilio** (recommend a **Twilio
  Verify** service so login OTP traffic is separate from the transactional
  `send-sms` notifications). Supabase owns OTP generation/expiry/rate-limiting.
- **Portal login flow** (no `@supabase/supabase-js`, per house rule — raw fetch):
  1. `POST /auth/v1/otp` `{ phone }` → Supabase texts a code.
  2. `POST /auth/v1/verify` `{ phone, token, type:'sms' }` → returns a session
     (access + refresh JWT).
  3. The invite-claim Edge Function runs once on first login to create the
     `contractor_users` mapping (if an unused invite matches the phone).
  4. The portal stores the session and sends the JWT on every data request;
     **RLS does the enforcement.**
- Non-invited / unmapped phones can authenticate to Supabase but map to **no
  contractor**, so RLS returns nothing — they see an empty "not linked" state.

### 3.3 RLS pattern — one helper, one template
- **`current_contractor_id()`** — a `SECURITY DEFINER`, `STABLE` SQL function
  returning the `contractor_id` for the current `auth.uid()` via
  `contractor_users` (active only), else null. Keeps every policy short and
  consistent.
- **Policy template** on each contractor-owned table:
  ```
  using ( contractor_id = current_contractor_id() )
  ```
  plus the existing staff policy alongside (staff keep full access). Writes get
  a matching `with check`.

### 3.4 Contractor-facing data model (B1 subset)
- **`contractor_work_orders`** (the projection, §2) — minimal columns to prove
  the read: `{ id, contractor_id, sow_unit_id, sow_project_number, address,
  status ('active'|'in_process'|'closed'), updated_at }`. Populated/kept in sync
  from the SOW save path (staff side) — B1 wires the sync for assigned work only.
- **Storage** — set up one contractor bucket/path convention + Storage RLS
  scoped to `current_contractor_id()` so B2/B3 uploads are already safe. (No
  uploads in B1; just the policy foundation.)

### 3.5 Proof surface + negative tests
- A throwaway minimal page (`contractor-portal.html` behind the
  `contractor_portal` module) with login + a read-only "My Work Orders" list
  from `contractor_work_orders`.
- **Automated-ish negative tests** (documented runbook): sign in as A, attempt a
  direct REST query for B's row id → expect empty; sign out → expect empty;
  confirm a staff session still reads everything. Captured as a checklist in the
  PR so the boundary proof is repeatable.

## 4. Migrations (B1)

One migration file: `contractor_users`, `contractor_invites`,
`contractor_work_orders`, the `current_contractor_id()` function, RLS enabled +
policies on all three new tables (staff + contractor), and the Storage policy.
**All new tables are RLS-from-birth** — no existing table's RLS is touched in B1.
Run by the user in the SQL Editor, fleet-wide.

## 5. Module + surface
- Register `contractor_portal` in `CLFN_MODULES` (default **off**; label
  "Contractor Portal"). The portal page redirects out when the module is off.
- B1 surface decision: run the proof as a **path on the current host**
  (`/contractor-portal.html`) to keep B1 moving; stand up the
  `contractors.<nation>.fnhub.app` subdomain in B2 when it becomes contractor-
  facing for real. (Recommendation — confirm.)

## 6. The real risk — retrofitting RLS onto existing staff tables (B1.5, NOT in B1)

The big shared tables (`housing_sow`, `housing_rfq`, `housing_contractors`,
`housing_applications`, …) **have no RLS today** — the staff app reads them
freely with an authenticated JWT under the client-trust model. **Enabling RLS on
any of them denies ALL access until policies are added**, so a careless flip
breaks staff. B1 deliberately **does not touch them** — the contractor boundary
is proven entirely on the new contractor-owned tables.

Retrofitting RLS onto the core tables (needed for the broader platform hardening
and the tenant portal) is its own carefully-staged sub-phase **B1.5**:
1. Inventory every table + every staff read/write path.
2. Add **permissive staff policies first**, enable RLS, verify staff unbroken.
3. Only then add any contractor/tenant policies.
Done table-by-table, reversible, behind the module-off default. This is the
slow, high-care work; it is **not** required to ship the contractor portal if
contractors only ever read the new projection tables — which is the B1 design.

## 7. Open decisions that gate B1
1. **OTP provider** — Twilio **Verify** service (recommended) vs raw Twilio
   messaging for login codes. (Affects §3.2 setup.)
2. **Per-contact logins** — confirm each key contact gets their own phone login
   (`contractor_users`-per-person). (Assumed yes.)
3. **B1 surface** — path on current host for the proof (recommended) vs stand up
   the subdomain now.

(Decisions that do **not** gate B1: invoice→finance (B3+), full core-table RLS
retrofit (B1.5).)

## 8. Effort / sequencing inside B1
- **Identity + auth** (3.1–3.2): moderate, clean.
- **RLS pattern + projection + sync** (3.3–3.4): the careful part; the SOW→
  projection sync needs to cover assign/reassign/complete.
- **Proof + negative tests** (3.5): small but non-negotiable — this is the
  deliverable that lets us trust everything after it.
B1 is the bulk of the portal's *risk*; the later phases are mostly UI on a
proven boundary.
