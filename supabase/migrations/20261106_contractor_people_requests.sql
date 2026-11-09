-- ============================================================================
-- Contractor Portal -- "add a key person" requests
--
-- Lets a signed-in contractor request, from the portal, that the housing office
-- give a colleague access to the Contractor Portal. The request lands in the
-- staff landing-page worklist ("Contractor Team Requests"). When staff APPROVE,
-- the person is added to the contractor's people[] AND a contractor_invites row
-- is created for their phone (the two conditions the claim re-checks), so the
-- person can then sign in; REJECT just closes it.
--
-- Rows are INSERTED only by the contractor-upload Edge Function (service role);
-- there is no insert policy for the anon/contractor client. Staff read+update;
-- a contractor may read their OWN requests (reflect-back in the portal).
-- Run fleet-wide via the admin migration page / SQL editor. Idempotent.
-- ============================================================================

create table if not exists public.contractor_people_requests (
  id            uuid primary key default gen_random_uuid(),
  contractor_id text not null,
  requested_by  text,                              -- caller phone / id
  name          text not null,
  phone         text not null,                     -- the colleague's mobile
  role          text,                              -- trade / position (optional)
  email         text,                              -- optional
  status        text not null default 'pending',   -- pending | approved | rejected
  reviewed_by   text,
  reviewed_at   timestamptz,
  review_notes  text,
  created_at    timestamptz not null default now()
);

create index if not exists contractor_people_requests_status_idx
  on public.contractor_people_requests (status, created_at desc);
create index if not exists contractor_people_requests_contractor_idx
  on public.contractor_people_requests (contractor_id);

alter table public.contractor_people_requests enable row level security;

-- Staff: full read + update (approve / reject). Contractor: read own only.
-- Email-on-staff gate, same shape as the contractor_submissions policies.
drop policy if exists cpr_staff_read on public.contractor_people_requests;
create policy cpr_staff_read on public.contractor_people_requests for select using (
  exists (select 1 from public.staff s
          where lower(s.email) = lower(auth.jwt() ->> 'email') and s.is_active)
  or contractor_id = public.current_contractor_id()
);
drop policy if exists cpr_staff_update on public.contractor_people_requests;
create policy cpr_staff_update on public.contractor_people_requests for update using (
  exists (select 1 from public.staff s
          where lower(s.email) = lower(auth.jwt() ->> 'email') and s.is_active)
) with check (
  exists (select 1 from public.staff s
          where lower(s.email) = lower(auth.jwt() ->> 'email') and s.is_active)
);
-- No INSERT / DELETE policy: inserts happen only via the Edge Function's
-- service role (which bypasses RLS).
