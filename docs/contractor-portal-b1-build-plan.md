# Contractor Portal — B1 Build Plan

Status: **PLAN / not built.** The implementation-ready plan for B1 (security
foundation). Builds on `docs/contractor-portal-b1-scope.md`.

**Decisions locked (2026-10-31):** OTP via **Twilio Verify**; **per-contact
logins** (one `contractor_users` row per person); B1 surface = **path on the
current host** (`/contractor-portal.html`), subdomain deferred to B2.

---

## 1. Draft migration SQL (review this first — runs fleet-wide)

New, RLS-from-birth tables only. **Touches no existing staff table.** The staff
predicate reuses the pattern already used by `email_intake`/`sms_log`.

```sql
-- === Contractor Portal B1: security foundation ===

-- 1) Login identity: auth.uid() -> contractor (one row per person who can log in)
create table if not exists public.contractor_users (
  auth_user_id  uuid primary key references auth.users(id) on delete cascade,
  contractor_id text not null,                 -- housing_contractors.id (text slug)
  display_name  text,
  phone         text,                          -- E.164
  role          text not null default 'contact', -- 'owner' | 'contact'
  is_active     boolean not null default true,
  invited_by    text,
  created_at    timestamptz not null default now()
);
create index if not exists contractor_users_contractor_idx
  on public.contractor_users (contractor_id);

-- 2) Invites: staff pre-authorize a KNOWN key-contact phone to claim a contractor
create table if not exists public.contractor_invites (
  id            uuid primary key default gen_random_uuid(),
  phone         text not null,                 -- E.164; must already be on the contractor's people[]
  contractor_id text not null,
  role          text not null default 'contact',
  invited_by    text,
  expires_at    timestamptz,
  used_at       timestamptz,
  created_at    timestamptz not null default now()
);
create index if not exists contractor_invites_phone_open_idx
  on public.contractor_invites (phone) where used_at is null;

-- 3) Projection the contractor reads (RLS-natural; see scope doc §2)
create table if not exists public.contractor_work_orders (
  id                 uuid primary key default gen_random_uuid(),
  contractor_id      text not null,
  sow_unit_id        text not null,
  sow_project_number text not null,
  address            text,
  status             text not null default 'active',  -- active | in_process | closed
  updated_at         timestamptz not null default now(),
  unique (sow_unit_id, sow_project_number)            -- one row per work order
);
create index if not exists contractor_wo_contractor_idx
  on public.contractor_work_orders (contractor_id, status);

-- 4) RLS helper: the contractor id for the current auth user (null for staff/none)
create or replace function public.current_contractor_id()
returns text language sql stable security definer set search_path = public as $$
  select cu.contractor_id from public.contractor_users cu
  where cu.auth_user_id = auth.uid() and cu.is_active limit 1
$$;

-- 5) Enable RLS + policies (staff predicate inline; contractor via the helper)
alter table public.contractor_users       enable row level security;
alter table public.contractor_invites     enable row level security;
alter table public.contractor_work_orders enable row level security;

-- contractor_users: self-read; staff read/write. (Rows are CREATED by the
-- invite-claim Edge Function with the service role, which bypasses RLS.)
drop policy if exists cu_self_or_staff_read on public.contractor_users;
create policy cu_self_or_staff_read on public.contractor_users for select using (
  auth_user_id = auth.uid()
  or exists (select 1 from public.staff s
             where lower(s.email) = lower(auth.jwt() ->> 'email') and s.is_active)
);
drop policy if exists cu_staff_write on public.contractor_users;
create policy cu_staff_write on public.contractor_users for all
  using (exists (select 1 from public.staff s
                 where lower(s.email) = lower(auth.jwt() ->> 'email') and s.is_active))
  with check (exists (select 1 from public.staff s
                 where lower(s.email) = lower(auth.jwt() ->> 'email') and s.is_active));

-- contractor_invites: staff only (contractors never read invites; the Edge
-- Function consumes them via service role).
drop policy if exists ci_staff_all on public.contractor_invites;
create policy ci_staff_all on public.contractor_invites for all
  using (exists (select 1 from public.staff s
                 where lower(s.email) = lower(auth.jwt() ->> 'email') and s.is_active))
  with check (exists (select 1 from public.staff s
                 where lower(s.email) = lower(auth.jwt() ->> 'email') and s.is_active));

-- contractor_work_orders: contractor sees ONLY their own; staff full.
drop policy if exists cwo_contractor_or_staff_read on public.contractor_work_orders;
create policy cwo_contractor_or_staff_read on public.contractor_work_orders for select using (
  contractor_id = public.current_contractor_id()
  or exists (select 1 from public.staff s
             where lower(s.email) = lower(auth.jwt() ->> 'email') and s.is_active)
);
drop policy if exists cwo_staff_write on public.contractor_work_orders;
create policy cwo_staff_write on public.contractor_work_orders for all
  using (exists (select 1 from public.staff s
                 where lower(s.email) = lower(auth.jwt() ->> 'email') and s.is_active))
  with check (exists (select 1 from public.staff s
                 where lower(s.email) = lower(auth.jwt() ->> 'email') and s.is_active));
```

Why this is safe for staff: a **contractor** phone session has no `email` claim,
so the staff `exists(...)` is false — a contractor only matches via
`current_contractor_id()`. A **staff** session matches the staff predicate and
keeps full access. These are new tables, so nothing staff relied on changes.

## 2. Auth flow — Supabase phone OTP backed by Twilio Verify

**User (dashboard) step:** Supabase → Authentication → Providers → **Phone** →
enable, SMS provider **Twilio Verify**, enter the Twilio Account SID + Auth Token
+ **Verify Service SID**. (Keeps login OTP separate from the transactional
`send-sms` notifications.)

**Portal login (raw fetch — no `@supabase/supabase-js`):**
1. `POST {SUPABASE_URL}/auth/v1/otp` `{ phone }` (+ `apikey: anon`) → Twilio Verify texts a code.
2. `POST {SUPABASE_URL}/auth/v1/verify` `{ phone, token, type:'sms' }` → returns `{ access_token, refresh_token }`.
3. Portal calls the **`contractor-claim`** Edge Function once with that JWT:
   - verifies the JWT → `auth.uid()` + phone;
   - if a `contractor_users` row exists → return it;
   - else find an **unused `contractor_invites`** for that phone **whose
     `contractor_id` also lists that phone in `housing_contractors.people`**
     (double anti-impersonation check) → create the `contractor_users` row
     (service role), mark the invite `used_at`;
   - else return `not_linked` (portal shows an "ask housing to invite you" state).
4. Thereafter every data request carries the contractor JWT; **RLS enforces**.

## 3. Projection sync — keeping `contractor_work_orders` current

Staff-side (staff hold the `cwo_staff_write` policy, so the staff client upserts):
- In `saveSOW` (shared SOW save) and `awardRfq` (RFQ award approves the SOW):
  when a SOW has/gets a `contractorId`, **upsert** a `contractor_work_orders`
  row `{ contractor_id, sow_unit_id, sow_project_number, address, status }` on
  the `(sow_unit_id, sow_project_number)` unique key.
- **Status** derived: `active` (assigned, no progress), `in_process`
  (0 < progress < 100), `closed` (completed or cancelled). Reassign updates
  `contractor_id`; completion/cancel sets `closed`.
- **Backfill** one-time script: scan existing `_sowCache` for SOWs with a
  contractor assigned and upsert their projection rows.

## 4. Staff-side: invite a contractor to the portal (minimal, B1)
- A **"Invite to portal"** action on the contractor card: pick a key contact
  that has a phone → writes a `contractor_invites` row (phone normalized to
  E.164, `contractor_id`, `role`, `invited_by`, `expires_at`). Audited.
- No bulk/magic-link email in B1 — the contractor just logs in at
  `/contractor-portal.html` with that phone; the invite authorizes the claim.

## 5. Proof surface (`/contractor-portal.html`)
- Module-gated (`contractor_portal`, default off). Minimal: phone → code login,
  then a read-only **"My Work Orders"** list from `contractor_work_orders`
  (RLS-scoped). No staff bundle loaded.

## 6. Negative-test runbook (the B1 deliverable — must all pass)
1. Sign in as contractor A → see only A's work orders.
2. As A, direct REST `GET /rest/v1/contractor_work_orders?id=eq.<B's row>` →
   **empty**.
3. As A, `GET /rest/v1/contractor_users?auth_user_id=eq.<B's uid>` → **empty**.
4. Sign out → both tables return empty.
5. A **staff** session still reads/writes everything (spot-check an existing
   staff screen + the new tables).
6. A phone that authenticates but has no invite/mapping → `not_linked`, sees
   nothing.

Capture this as a checklist in the PR.

## 7. Task order (what's code vs. user-run)
| # | Task | Who |
|---|------|-----|
| 1 | Run the B1 migration (SQL Editor, fleet-wide) | **User** |
| 2 | Configure Supabase Auth → Phone → Twilio **Verify** | **User** |
| 3 | Register `contractor_portal` module (default off) | Code → deploy |
| 4 | `contractor-claim` Edge Function | Code → **User deploys** |
| 5 | `contractor-portal.html` + login + "My Work Orders" proof | Code → deploy |
| 6 | Projection sync in `saveSOW`/`awardRfq` + backfill script | Code → deploy |
| 7 | "Invite to portal" action on the contractor card | Code → deploy |
| 8 | Run the §6 negative-test runbook; record results | **User + me** |

## 8. Out of scope for B1
Dashboard polish, photos/notes, invoices, completion-% writes, insurance
uploads, the subdomain, and any RLS on existing staff tables (that's B1.5).
B1 proves the boundary and nothing more.
