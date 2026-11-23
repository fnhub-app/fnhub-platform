-- ============================================================================
-- FN Hub CONTROL PLANE -- per-nation projects + daily time/activity log.
-- Runs on the "fnhub-platform" project. Super-admins only. Run in the platform
-- SQL Editor (NOT the Fleet Migrations tool -- these are platform tables).
--
-- nation_projects     : each nation's project list (Project # and/or PO #, name,
--                       status) used to tag time entries.
-- nation_time_entries : a daily timesheet per nation -- dated activities with a
--                       branching category, hours (or an at-cost/fixed amount)
--                       and the rate applied. Entries accumulate (billed=false)
--                       and are stamped billed + invoice_number when billed into
--                       a nation invoice, so they can't double-bill.
--
-- The admin browser reads/writes directly as a verified super-admin (no
-- service-role / Edge Function), so the single `for all` policy also covers
-- inserts -- same pattern as platform_build_tickets. Re-running is idempotent.
-- ============================================================================

create table if not exists public.nation_projects (
  id          uuid primary key default gen_random_uuid(),
  subdomain   text not null,
  number      text,                            -- Project # (e.g. NP-2026-01)
  po_number   text,                            -- PO # (the project number may be a PO)
  name        text,
  status      text not null default 'active',  -- active | closed
  created_by  text,
  created_at  timestamptz not null default now()
);
alter table public.nation_projects add column if not exists po_number text;
create index if not exists nation_projects_sub_idx on public.nation_projects (subdomain, status);

create table if not exists public.nation_time_entries (
  id             uuid primary key default gen_random_uuid(),
  subdomain      text not null,
  project_id     uuid references public.nation_projects (id) on delete set null,
  entry_date     date not null default current_date,
  category_path  jsonb not null default '[]',  -- branching labels, e.g. ["Consulting & advisory","Economic development","Grant writing"]
  category_key   text,                         -- resolved leaf key (maps to the rate)
  kind           text,                         -- hourly | travel_time | atcost | fixed
  hours          numeric,                      -- for hourly / travel_time
  amount         numeric,                      -- for atcost / fixed
  rate           numeric,                      -- snapshot of the hourly rate applied
  description    text,
  billed         boolean not null default false,
  invoice_number text,                         -- set when billed into an invoice
  billed_at      timestamptz,
  created_by     text,
  created_at     timestamptz not null default now()
);
create index if not exists nation_time_entries_sub_idx on public.nation_time_entries (subdomain, billed, entry_date);

-- RLS: super-admins only (both tables), one `for all` policy = read + write
-- (same pattern as platform_build_tickets; is_super_admin() is SECURITY DEFINER).
alter table public.nation_projects      enable row level security;
alter table public.nation_time_entries  enable row level security;

drop policy if exists nation_projects_all on public.nation_projects;
create policy nation_projects_all on public.nation_projects for all
  using (public.is_super_admin()) with check (public.is_super_admin());

drop policy if exists nation_time_entries_all on public.nation_time_entries;
create policy nation_time_entries_all on public.nation_time_entries for all
  using (public.is_super_admin()) with check (public.is_super_admin());
