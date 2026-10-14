-- ============================================================================
-- FN Hub CONTROL PLANE -- Reseller program v2: exclusivity, extensions,
-- approved marketing expenses. Run AFTER reseller.sql, in the platform SQL
-- Editor. Idempotent -- safe to re-run.
--
--   reseller_agreements  + exclusivity (s.3.5) and the link from an extension
--                          agreement to the one it replaces. Extending
--                          exclusivity always means a NEW signed agreement.
--   reseller_expenses    -- marketing expenses (trade shows, travel, admin)
--                          the Owner pre-approved in writing (s.9.7-9.8).
--                          Claimed expenses are reimbursed on the monthly
--                          statement.
--   reseller_statements  + the expense reimbursements paid with a statement.
-- ============================================================================

alter table public.reseller_agreements add column if not exists exclusive             boolean not null default true;
alter table public.reseller_agreements add column if not exists exclusivity_months    int     not null default 12;
alter table public.reseller_agreements add column if not exists exclusivity_territory text    not null default 'Canada';
alter table public.reseller_agreements add column if not exists expense_claim_days    int     not null default 60;
alter table public.reseller_agreements add column if not exists extends_agreement_id  uuid references public.reseller_agreements(id) on delete set null;

create table if not exists public.reseller_expenses (
  id               uuid primary key default gen_random_uuid(),
  agreement_id     uuid not null references public.reseller_agreements(id) on delete cascade,
  category         text not null default 'trade_show',   -- trade_show | travel | admin | promo | other
  description      text not null,
  approved_date    date not null,                         -- date of the Owner's written approval (before the expense)
  approved_by      text,
  approval_ref     text,                                  -- e.g. "email 2026-10-02 to Jane"
  approved_max     numeric(12,2) not null default 0,      -- the approved maximum
  incurred_date    date,
  amount           numeric(12,2),                         -- amount claimed (receipted)
  reimbursable     numeric(12,2),                         -- min(amount, approved_max)
  receipts         boolean not null default false,
  status           text not null default 'approved',      -- approved | claimed | reimbursed | rejected
  statement_month  date,                                  -- set when an issued statement includes it
  notes            text,
  created_by       text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index if not exists reseller_expenses_agreement_idx on public.reseller_expenses (agreement_id);

alter table public.reseller_statements add column if not exists expenses       jsonb not null default '[]'::jsonb;
alter table public.reseller_statements add column if not exists expenses_total numeric(12,2) not null default 0;

alter table public.reseller_expenses enable row level security;
drop policy if exists reseller_expenses_all on public.reseller_expenses;
create policy reseller_expenses_all on public.reseller_expenses for all using (public.is_super_admin()) with check (public.is_super_admin());
