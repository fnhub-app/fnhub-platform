-- ============================================================================
-- Contractor Portal -- submissions review queue (invoices approved, photos/
-- notes flagged)
--
-- Everything a contractor submits lands here so staff see it on the landing
-- page. By kind:
--   invoice -> status 'pending'  : staff APPROVE (creates the payment draw +
--                                  files the invoice) or REJECT.
--   photo   -> status 'new'      : no approval; auto-filed to the unit's
--                                  Documents, but FLAGGED here so staff know to
--                                  look; staff mark it 'read'.
--   note    -> status 'new'      : no approval; FLAGGED here with its text;
--                                  staff mark it 'read'.
--
-- Rows are INSERTED only by the contractor-upload Edge Function (service role);
-- there is no insert policy for the anon/contractor client. Staff read+update;
-- a contractor may read their own rows (status reflect-back in the portal).
-- Run fleet-wide via the admin migration page / SQL editor. Idempotent.
-- ============================================================================

create table if not exists public.contractor_submissions (
  id                 uuid primary key default gen_random_uuid(),
  contractor_id      text not null,
  unit_id            text not null,
  sow_project_number text not null,
  address            text,
  kind               text not null,                 -- photo | invoice | note
  status             text not null default 'new',   -- new | read | pending | approved | rejected
  text               text,                          -- note body (kind=note)
  amount             numeric,                        -- invoice amount (kind=invoice)
  file_path          text,                          -- storage path (photo/invoice)
  file_name          text,
  file_type          text,
  created_at         timestamptz not null default now(),
  created_by         text,                          -- contractor phone/id
  reviewed_by        text,
  reviewed_at        timestamptz,
  review_notes       text
);

create index if not exists contractor_submissions_status_idx
  on public.contractor_submissions (status, created_at desc);
create index if not exists contractor_submissions_wo_idx
  on public.contractor_submissions (unit_id, sow_project_number);

alter table public.contractor_submissions enable row level security;

-- Staff: full read + update (approve / reject / mark read). Email-on-staff gate,
-- same shape as the contractor_work_orders policies.
drop policy if exists cs_staff_read on public.contractor_submissions;
create policy cs_staff_read on public.contractor_submissions for select using (
  exists (select 1 from public.staff s
          where lower(s.email) = lower(auth.jwt() ->> 'email') and s.is_active)
  or contractor_id = public.current_contractor_id()
);
drop policy if exists cs_staff_update on public.contractor_submissions;
create policy cs_staff_update on public.contractor_submissions for update using (
  exists (select 1 from public.staff s
          where lower(s.email) = lower(auth.jwt() ->> 'email') and s.is_active)
) with check (
  exists (select 1 from public.staff s
          where lower(s.email) = lower(auth.jwt() ->> 'email') and s.is_active)
);
-- No INSERT / DELETE policy: inserts happen only via the Edge Function's
-- service role (which bypasses RLS).
