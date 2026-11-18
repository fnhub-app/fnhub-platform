-- 20261118_finance_writeoffs.sql
-- Write-off recommendations (Phase: arrears write-off workflow).
--
-- A write-off is management's recommendation to write off an uncollectable
-- arrears account. Flow: management recommends on the TIC Rent & Arrears tab
-- (status 'pending_ed') -> the ED approves or declines -> on approval the
-- recommendation PDF is emailed to the nation's finance mailbox (status
-- 'sent_to_finance'). The app does NOT post the ledger credit; finance posts the
-- actual write-off entry on receipt (separation of duties).
--
-- Mapped into the finance module data layer (_FIN_TABLES in finance-data.js),
-- alongside finance_collections / finance_journal. Created / approved from the
-- housing side via REST (shared-data.js) using the staff bearer token; the RLS
-- helpers (public.hs_is_office / public.hs_is_mgmt) come from
-- 20260703_rls_lockdown.sql, which must have run on this nation's project first.

create table if not exists public.finance_writeoffs (
  id                  uuid primary key default gen_random_uuid(),
  nation_id           text,
  tenant_id           uuid,
  tenant_name         text,
  balance_at_rec      numeric default 0,       -- arrears balance snapshot at recommendation
  recommended_amount  numeric default 0,       -- amount recommended for write-off (defaults to balance)
  reason              text,                     -- uncollectable | deceased | bankruptcy | left_no_forwarding | hardship | other
  justification       text,                     -- required narrative
  status              text not null default 'pending_ed',  -- pending_ed | approved | sent_to_finance | declined
  recommended_by      text,
  recommended_at      timestamptz default now(),
  ed_approved_by      text,
  ed_approved_at      timestamptz,
  declined_by         text,
  declined_at         timestamptz,
  decline_reason      text,
  sent_to_finance_at  timestamptz,
  archived            boolean not null default false,
  created_by          text,
  created_at          timestamptz default now()
);

create index if not exists finance_writeoffs_status_idx on public.finance_writeoffs (status) where archived = false;
create index if not exists finance_writeoffs_tenant_idx on public.finance_writeoffs (tenant_id);

alter table public.finance_writeoffs enable row level security;

-- Housing office (management + housing employees) may read and create recommendations.
drop policy if exists finance_writeoffs_select on public.finance_writeoffs;
create policy finance_writeoffs_select on public.finance_writeoffs
  for select to authenticated using (public.hs_is_office());

drop policy if exists finance_writeoffs_insert on public.finance_writeoffs;
create policy finance_writeoffs_insert on public.finance_writeoffs
  for insert to authenticated with check (public.hs_is_office());

-- Only management (ED + Housing Manager) may update (approve / decline / mark sent / archive).
drop policy if exists finance_writeoffs_update on public.finance_writeoffs;
create policy finance_writeoffs_update on public.finance_writeoffs
  for update to authenticated using (public.hs_is_mgmt()) with check (public.hs_is_mgmt());

-- No delete policy: rows are archived (archived = true), never deleted.
