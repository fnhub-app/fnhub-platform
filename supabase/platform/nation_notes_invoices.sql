-- ============================================================================
-- FN Hub CONTROL PLANE -- Nation Information Card: notes + invoices.
-- Runs on the "fnhub-platform" project. Super-admins only.
-- Run in the platform SQL Editor.
-- ============================================================================

-- ── Notes (free-text log against a nation) ──────────────────────────────────
create table if not exists public.nation_notes (
  id         uuid primary key default gen_random_uuid(),
  subdomain  text not null references public.nations(subdomain) on delete cascade,
  body       text not null,
  author     text,
  created_at timestamptz not null default now()
);
create index if not exists nation_notes_sub_idx on public.nation_notes (subdomain, created_at desc);

alter table public.nation_notes enable row level security;
drop policy if exists nation_notes_all on public.nation_notes;
create policy nation_notes_all on public.nation_notes for all
  using (public.is_super_admin()) with check (public.is_super_admin());

-- ── Invoices (subscription / setup / add-on billing) ────────────────────────
create table if not exists public.nation_invoices (
  id          uuid primary key default gen_random_uuid(),
  subdomain   text not null references public.nations(subdomain) on delete cascade,
  number      text not null,                         -- NP-YYYY-NN
  issue_date  date not null default current_date,
  due_date    date,
  currency    text not null default 'CAD',
  line_items  jsonb not null default '[]'::jsonb,    -- [{description, qty, unit_price}]
  subtotal    numeric(12,2) not null default 0,
  tax_rate    numeric(5,2)  not null default 0,      -- percent
  tax         numeric(12,2) not null default 0,
  total       numeric(12,2) not null default 0,
  status      text not null default 'draft',         -- draft | sent | paid | void
  notes       text,
  created_by  text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create unique index if not exists nation_invoices_number_idx on public.nation_invoices (number);
create index if not exists nation_invoices_sub_idx on public.nation_invoices (subdomain, issue_date desc);

alter table public.nation_invoices enable row level security;
drop policy if exists nation_invoices_all on public.nation_invoices;
create policy nation_invoices_all on public.nation_invoices for all
  using (public.is_super_admin()) with check (public.is_super_admin());
