-- ════════════════════════════════════════════════════════════════════════════
-- Contractor Portal — B1 security foundation.
--
-- NEW, RLS-from-birth tables only. Does NOT enable/alter RLS on any existing
-- staff table (that is a separate, carefully-staged B1.5). The contractor data
-- boundary is proven entirely on these new tables.
--
-- Identity: contractor_users maps a Supabase auth user (phone login) to a
-- contractor. contractor_invites lets staff pre-authorize a KNOWN key-contact
-- phone to claim a contractor (anti-impersonation). contractor_work_orders is a
-- normalized projection the contractor reads directly (housing_sow stores one
-- jsonb row per unit, which RLS can't scope per contractor — see the design doc).
--
-- Safety for staff: a contractor's phone session has no `email` JWT claim, so
-- the staff predicate below is false for them; they only match via
-- current_contractor_id(). Staff sessions keep full access.
--
-- Run by the user in the Supabase SQL Editor, fleet-wide.
-- ════════════════════════════════════════════════════════════════════════════

-- 1) Login identity: auth.uid() -> contractor (one row per person who can log in)
create table if not exists public.contractor_users (
  auth_user_id  uuid primary key references auth.users(id) on delete cascade,
  contractor_id text not null,                    -- housing_contractors.id (text slug)
  display_name  text,
  phone         text,                             -- E.164
  role          text not null default 'contact',  -- 'owner' | 'contact'
  is_active     boolean not null default true,
  invited_by    text,
  created_at    timestamptz not null default now()
);
create index if not exists contractor_users_contractor_idx
  on public.contractor_users (contractor_id);

-- 2) Invites: staff pre-authorize a KNOWN key-contact phone to claim a contractor
create table if not exists public.contractor_invites (
  id            uuid primary key default gen_random_uuid(),
  phone         text not null,                    -- E.164; must already be on the contractor's people[]
  contractor_id text not null,
  role          text not null default 'contact',
  invited_by    text,
  expires_at    timestamptz,
  used_at       timestamptz,
  created_at    timestamptz not null default now()
);
create index if not exists contractor_invites_phone_open_idx
  on public.contractor_invites (phone) where used_at is null;

-- 3) Projection the contractor reads (RLS-natural; kept in sync staff-side)
create table if not exists public.contractor_work_orders (
  id                 uuid primary key default gen_random_uuid(),
  contractor_id      text not null,
  sow_unit_id        text not null,
  sow_project_number text not null,
  address            text,
  status             text not null default 'active',  -- active | in_process | closed
  updated_at         timestamptz not null default now(),
  unique (sow_unit_id, sow_project_number)             -- one projection row per work order
);
create index if not exists contractor_wo_contractor_idx
  on public.contractor_work_orders (contractor_id, status);

-- 4) RLS helper: the contractor id for the current auth user (null for staff/none)
create or replace function public.current_contractor_id()
returns text language sql stable security definer set search_path = public as $$
  select cu.contractor_id from public.contractor_users cu
  where cu.auth_user_id = auth.uid() and cu.is_active limit 1
$$;

-- 5) Enable RLS + policies
alter table public.contractor_users       enable row level security;
alter table public.contractor_invites     enable row level security;
alter table public.contractor_work_orders enable row level security;

-- contractor_users: self-read; staff read/write. Rows are CREATED by the
-- contractor-claim Edge Function with the service role (which bypasses RLS).
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
