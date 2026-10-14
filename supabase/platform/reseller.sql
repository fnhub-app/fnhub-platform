-- ============================================================================
-- FN Hub CONTROL PLANE -- Reseller program (SaaS Reseller Commission Agreement).
-- Runs on the "fnhub-platform" project. Super-admins only. Run in the platform
-- SQL Editor. Idempotent -- safe to re-run.
--
--   platform_owner        -- the single party that owns the software (the
--                            "Owner" in every reseller agreement). One row.
--                            May start as an individual and later become a
--                            business entity; signed agreements keep their own
--                            snapshot, so editing this never rewrites history.
--   resellers             -- reseller registry (individual or company).
--   reseller_agreements   -- one row per agreement: the contract's bracketed
--                            terms, signatures, term + termination tracking.
--   reseller_customers    -- lead submission + registration (Section 7.4).
--   reseller_statements   -- monthly Net Revenue / Commission statements
--                            (Sections 7-9, Schedule A).
-- ============================================================================

-- ── Owner (single row) ──────────────────────────────────────────────────────
create table if not exists public.platform_owner (
  id               int primary key default 1 check (id = 1),
  legal_name       text not null,
  entity_type      text not null default 'individual',  -- individual | sole_prop | corporation | partnership | first_nation | nonprofit | other
  jurisdiction     text,                                  -- e.g. 'Ontario' / 'Canada (CBCA)' for a corporation
  operating_as     text,                                  -- business / trade name
  product_name     text,                                  -- product / brand licensed (e.g. FN Hub)
  signatory_name   text,
  signatory_title  text,
  street           text,
  city             text,
  province         text,
  postal_code      text,
  country          text default 'Canada',
  email            text,
  phone            text,
  business_number  text,                                  -- CRA BN / corporation number
  gst_hst_number   text,
  notes            text,
  updated_by       text,
  updated_at       timestamptz not null default now()
);

-- Seed the current owner once (edit afterwards in Platform Admin -> Resellers).
insert into public.platform_owner (id, legal_name, entity_type, operating_as, product_name,
  signatory_name, signatory_title, street, city, province, postal_code, country, email, phone)
values (1, 'Kevin Proctor', 'individual', 'Home Land Homes', 'FN Hub',
  'Kevin Proctor', 'Founder', '152 Simon Lake Drive', 'Naughton', 'ON', 'P0M 2M0', 'Canada',
  'hello@homelandhomes.ca', '705-960-5076')
on conflict (id) do nothing;

-- ── Resellers ───────────────────────────────────────────────────────────────
create table if not exists public.resellers (
  id                 uuid primary key default gen_random_uuid(),
  legal_name         text not null,
  entity_type        text not null default 'individual',
  jurisdiction       text,
  operating_as       text,
  contact_name       text,
  contact_title      text,
  street             text,
  city               text,
  province           text,
  postal_code        text,
  country            text default 'Canada',
  email              text,
  phone              text,
  gst_hst_registered boolean not null default false,
  gst_hst_number     text,
  hst_rate           numeric(5,2) not null default 13,
  payment_details    text,                               -- how commission is paid (e-transfer email, EFT, ...)
  status             text not null default 'active',     -- active | inactive
  notes              text,
  created_by         text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

-- ── Agreements ──────────────────────────────────────────────────────────────
create table if not exists public.reseller_agreements (
  id                       uuid primary key default gen_random_uuid(),
  reseller_id              uuid not null references public.resellers(id) on delete cascade,
  agreement_number         text not null,                -- RSA-YYYY-NN
  status                   text not null default 'draft', -- draft | active | terminated
  effective_date           date,
  commission_rate          numeric(5,2) not null default 33,
  initial_term_months      int not null default 12,
  renewal_term_months      int not null default 12,
  nonrenewal_notice_days   int not null default 60,
  termination_notice_days  int not null default 60,
  cure_days                int not null default 30,
  payment_days             int not null default 30,
  nonsolicit_months        int not null default 12,
  confidentiality_years    int not null default 3,
  liability_months         int not null default 12,
  governing_law            text not null default 'Ontario',
  discount_authority       text not null default 'never', -- never | with_approval
  pricing_note             text,
  owner_snapshot           jsonb,                         -- Owner details frozen at activation
  reseller_snapshot        jsonb,                         -- Reseller details frozen at activation
  owner_sign_name          text,
  owner_sign_title         text,
  owner_signed_date        date,
  reseller_sign_name       text,
  reseller_sign_title      text,
  reseller_signed_date     date,
  termination_type         text,                          -- convenience | cause | nonrenewal
  termination_notice_date  date,
  terminated_date          date,                          -- effective date; Commission ceases (s.10.4)
  termination_reason       text,
  created_by               text,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);
create unique index if not exists reseller_agreements_number_idx on public.reseller_agreements (agreement_number);
create index if not exists reseller_agreements_reseller_idx on public.reseller_agreements (reseller_id);

-- ── Customer registration (s.7.4) ───────────────────────────────────────────
create table if not exists public.reseller_customers (
  id              uuid primary key default gen_random_uuid(),
  agreement_id    uuid not null references public.reseller_agreements(id) on delete cascade,
  prospect_name   text not null,
  subdomain       text references public.nations(subdomain) on delete set null, -- set once the prospect is a nation in the registry
  submitted_date  date not null default current_date,
  status          text not null default 'submitted',     -- submitted | registered | declined
  decision_date   date,
  notes           text,
  created_by      text,
  created_at      timestamptz not null default now()
);
create index if not exists reseller_customers_agreement_idx on public.reseller_customers (agreement_id);
create index if not exists reseller_customers_sub_idx on public.reseller_customers (subdomain);

-- ── Monthly statements (s.9.1) ──────────────────────────────────────────────
create table if not exists public.reseller_statements (
  id                       uuid primary key default gen_random_uuid(),
  agreement_id             uuid not null references public.reseller_agreements(id) on delete cascade,
  period_month             date not null,                 -- first day of the month covered
  lines                    jsonb not null default '[]'::jsonb, -- per-customer Schedule A rows + invoices counted
  gross_revenue            numeric(12,2) not null default 0,
  deductions               numeric(12,2) not null default 0,
  net_revenue              numeric(12,2) not null default 0,
  commission_rate          numeric(5,2)  not null default 33,
  commission               numeric(12,2) not null default 0,
  clawback                 numeric(12,2) not null default 0, -- s.9.2 reversals / carried offset
  clawback_note            text,
  amount_due               numeric(12,2) not null default 0, -- commission - clawback (negative = carried forward)
  status                   text not null default 'draft',  -- draft | issued | paid
  due_date                 date,
  issued_date              date,
  paid_date                date,
  payment_ref              text,
  reseller_invoice_number  text,
  notes                    text,
  created_by               text,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);
create unique index if not exists reseller_statements_period_idx on public.reseller_statements (agreement_id, period_month);

-- ── RLS: super-admins only (same pattern as every control-plane table) ─────
alter table public.platform_owner      enable row level security;
alter table public.resellers           enable row level security;
alter table public.reseller_agreements enable row level security;
alter table public.reseller_customers  enable row level security;
alter table public.reseller_statements enable row level security;

drop policy if exists platform_owner_all      on public.platform_owner;
drop policy if exists resellers_all           on public.resellers;
drop policy if exists reseller_agreements_all on public.reseller_agreements;
drop policy if exists reseller_customers_all  on public.reseller_customers;
drop policy if exists reseller_statements_all on public.reseller_statements;

create policy platform_owner_all      on public.platform_owner      for all using (public.is_super_admin()) with check (public.is_super_admin());
create policy resellers_all           on public.resellers           for all using (public.is_super_admin()) with check (public.is_super_admin());
create policy reseller_agreements_all on public.reseller_agreements for all using (public.is_super_admin()) with check (public.is_super_admin());
create policy reseller_customers_all  on public.reseller_customers  for all using (public.is_super_admin()) with check (public.is_super_admin());
create policy reseller_statements_all on public.reseller_statements for all using (public.is_super_admin()) with check (public.is_super_admin());
