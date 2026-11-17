-- ============================================================================
-- FN Hub CONTROL PLANE -- development request queue (Dashboard -> Requests).
-- Runs on the "fnhub-platform" project. Super-admins only. Run in the platform
-- SQL Editor.
--
-- A plain-language intake (feature / update / fix requests for the housing app)
-- that the admin panel turns into an optimized build prompt and saves here, so
-- the queue persists across devices and every super-admin sees it. The browser
-- reads/writes directly as a verified super-admin (no service-role / Edge
-- Function involved), so the single `for all` policy below also covers inserts.
-- ============================================================================
create table if not exists public.platform_build_tickets (
  id          uuid primary key default gen_random_uuid(),
  number      text,                            -- REQ-001, REQ-002, ...
  title       text,
  req_type    text,                            -- New feature | Change | Fix | ...
  area        text,                            -- which part of the app
  roles       jsonb not null default '[]',     -- who uses it / should see it
  blocks      jsonb not null default '[]',     -- reusable building blocks (Document Library, Contract generation, ...)
  is_custom   boolean not null default false,  -- per-nation licensed custom module?
  custom_nation text,                          -- which nation (when is_custom)
  what        text,                            -- the main ask
  why         text,
  example     text,
  notify      text,                            -- No alert | Email | Text | Email + Text
  notify_who  text,
  rules       text,
  avoid       text,
  priority    text not null default 'Normal',  -- Urgent | High | Normal | Low
  due_date    date,
  status      text not null default 'new',     -- new | building | done
  prompt      text,                            -- the generated, ready-to-paste prompt
  created_by  text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- Upgrade an already-created table (re-running this file is idempotent).
alter table public.platform_build_tickets add column if not exists blocks jsonb not null default '[]';
alter table public.platform_build_tickets add column if not exists is_custom boolean not null default false;
alter table public.platform_build_tickets add column if not exists custom_nation text;

create index if not exists platform_build_tickets_idx
  on public.platform_build_tickets (status, created_at desc);

alter table public.platform_build_tickets enable row level security;

drop policy if exists platform_build_tickets_all on public.platform_build_tickets;
create policy platform_build_tickets_all on public.platform_build_tickets for all
  using (public.is_super_admin()) with check (public.is_super_admin());
