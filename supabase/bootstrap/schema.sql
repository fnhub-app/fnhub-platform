-- ============================================================================
-- supabase/bootstrap/schema.sql
--
-- Reproducible schema for a NEW nation's Supabase project (Phase N1 / D0).
-- Captured from the CLFN project on 2026-08-16 via bootstrap/extract-schema.sql
-- and replayed against a clean Postgres to verify it applies end to end.
--
-- APPLY ORDER for a new nation (see docs/NATION-ONBOARDING.md Part B):
--   1. this file          -- tables, constraints, indexes, functions, triggers,
--                            RLS, policies, grants
--   2. supabase/seed.sql  -- storage bucket + optional nation identity row
--   3. create the first ED / super_user via Supabase Auth
--
-- PREREQUISITES -- all present by default on a new Supabase project, so this
-- applies as-is there, but it will NOT apply to a bare Postgres:
--   * schemas `extensions`, `vault`, `storage`, `auth`
--   * roles `anon`, `authenticated`, `service_role`
--   * `auth.uid()`, `auth.jwt()`, `auth.role()`, `storage.foldername()`
--   * table `storage.objects`
--
-- REGENERATE whenever a migration lands, or new nations start behind CLFN:
--   supabase db dump --linked -f supabase/bootstrap/schema.sql   (preferred)
--   or re-run bootstrap/extract-schema.sql in the SQL Editor.
--
-- KNOWN GAPS vs. a CLI dump (see extract-schema.sql header for the full list):
-- sequence CURRENT values, column comments, and collations are not carried.
-- None are load-bearing for a fresh nation.
--
-- NOTE -- `nation_id` defaults to 'clfn' on every table that has the column.
-- Nothing reads or filters on it (database-per-nation makes it redundant), so
-- this does not break a new nation. It does produce an inconsistency worth
-- fixing during provisioning: the finance client writes nation_id explicitly
-- from NATION_CONFIG.id (finance-data.js `_NATION()`), so a new nation's
-- FINANCE rows carry its real id while its HOUSING rows silently fall back to
-- the 'clfn' default. Either rewrite the defaults per nation after applying
-- this file, or drop the defaults -- but decide deliberately rather than
-- inheriting CLFN's id in another nation's database.
--
-- FOLLOW-UPS this capture surfaced (pre-existing on CLFN, not introduced here;
-- see the notes added to PLAN.md Phase DEMO):
--   * the RLS gate functions (get_my_role, is_housing_role, is_finance_role,
--     clfn_is_active_staff) are SECURITY DEFINER with no `SET search_path`
--   * clfn_is_active_staff() is referenced by no policy -- dead code
--   * both audit tables carry two overlapping append-only trigger pairs
-- ============================================================================

-- ============ Extensions ============
create extension if not exists "uuid-ossp" with schema extensions;
create extension if not exists pg_stat_statements with schema extensions;
create extension if not exists pgcrypto with schema extensions;
create extension if not exists supabase_vault with schema vault;
-- ============ Sequences ============
create sequence if not exists public.housing_app_id_seq as bigint increment by 1 minvalue 1 maxvalue 9223372036854775807 start with 5000 cache 1 no cycle;
create sequence if not exists public.staff_id_seq as bigint increment by 1 minvalue 1 maxvalue 9223372036854775807 start with 1 cache 1 no cycle;
-- ============ Tables ============
create table if not exists public.app_documents (
  id uuid default gen_random_uuid() not null,
  app_id text not null,
  file_path text not null,
  file_name text not null,
  file_size bigint default 0,
  file_type text default ''::text,
  added_by text default 'admin'::text,
  added_at timestamp with time zone default now(),
  notes text,
  nation_id text default 'clfn'::text not null
);
create table if not exists public.applicant_profiles (
  uid uuid not null,
  email text,
  full_name text,
  phone text,
  linked_app_ids text[] default '{}'::text[] not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null
);
create table if not exists public.application_submissions (
  id uuid default gen_random_uuid() not null,
  applicant_uid uuid not null,
  submission_type text default 'new'::text not null,
  linked_app_id text,
  payload jsonb default '{}'::jsonb not null,
  status text default 'draft'::text not null,
  review_notes text,
  reviewed_by text,
  reviewed_at timestamp with time zone,
  created_app_id text,
  submitted_at timestamp with time zone,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null
);
create table if not exists public.bcr_registry (
  id uuid default gen_random_uuid() not null,
  full_name text not null,
  bcrd_date date,
  reason text,
  active boolean default true,
  created_at timestamp with time zone default now(),
  created_by text,
  lifted_at timestamp with time zone,
  lifted_by text,
  date_of_birth date
);
create table if not exists public.contractor_notes (
  id uuid default gen_random_uuid() not null,
  contractor_id text not null,
  note_body text not null,
  author_name text,
  author_email text,
  created_at timestamp with time zone default now() not null
);
create table if not exists public.finance_arr_payments (
  id uuid default gen_random_uuid() not null,
  nation_id text default 'clfn'::text not null,
  arrangement_id uuid not null,
  invoice_id uuid,
  payment_date date not null,
  amount numeric(12,2) not null,
  method text,
  reference text,
  notes text,
  voids_id uuid,
  void_reason text,
  created_at timestamp with time zone default now() not null,
  created_by text not null
);
create table if not exists public.finance_arrangements (
  id uuid default gen_random_uuid() not null,
  nation_id text default 'clfn'::text not null,
  tenant_id uuid not null,
  total_owing numeric(12,2) not null,
  payment_amount numeric(12,2) not null,
  frequency text not null,
  start_date date not null,
  end_date date,
  status text default 'active'::text not null,
  reason text,
  approved_by text,
  approved_at timestamp with time zone,
  archived boolean default false not null,
  created_at timestamp with time zone default now() not null,
  created_by text not null,
  updated_at timestamp with time zone default now() not null,
  updated_by text
);
create table if not exists public.finance_audit_log (
  id uuid default gen_random_uuid() not null,
  nation_id text default 'clfn'::text not null,
  occurred_at timestamp with time zone default now() not null,
  actor_email text not null,
  actor_role text,
  action text not null,
  entity_type text not null,
  entity_id uuid,
  tenant_id uuid,
  summary text not null,
  detail jsonb
);
create table if not exists public.finance_collections (
  id uuid default gen_random_uuid() not null,
  nation_id text default 'clfn'::text not null,
  tenant_id uuid not null,
  opened_date date not null,
  closed_date date,
  stage text default 'flagged'::text not null,
  amount_at_open numeric(12,2) not null,
  amount_current numeric(12,2),
  agency text,
  notes text,
  archived boolean default false not null,
  created_at timestamp with time zone default now() not null,
  created_by text not null,
  updated_at timestamp with time zone default now() not null,
  updated_by text
);
create table if not exists public.finance_invoices (
  id uuid default gen_random_uuid() not null,
  nation_id text default 'clfn'::text not null,
  tenant_id uuid not null,
  unit_id text,
  invoice_number text,
  invoice_date date not null,
  due_date date,
  amount numeric(12,2) not null,
  category text,
  description text,
  status text default 'open'::text not null,
  archived boolean default false not null,
  created_at timestamp with time zone default now() not null,
  created_by text not null,
  updated_at timestamp with time zone default now() not null,
  updated_by text
);
create table if not exists public.finance_journal (
  id uuid default gen_random_uuid() not null,
  nation_id text default 'clfn'::text not null,
  tenant_id uuid,
  entry_date date not null,
  account_code text,
  debit numeric(12,2) default 0 not null,
  credit numeric(12,2) default 0 not null,
  description text not null,
  reference text,
  voids_id uuid,
  void_reason text,
  created_at timestamp with time zone default now() not null,
  created_by text not null
);
create table if not exists public.finance_loan_payments (
  id uuid default gen_random_uuid() not null,
  nation_id text default 'clfn'::text not null,
  loan_id uuid not null,
  payment_date date not null,
  principal_paid numeric(12,2) default 0 not null,
  interest_paid numeric(12,2) default 0 not null,
  total_paid numeric(12,2) generated always as ((principal_paid + interest_paid)) stored,
  method text,
  reference text,
  notes text,
  voids_id uuid,
  void_reason text,
  created_at timestamp with time zone default now() not null,
  created_by text not null
);
create table if not exists public.finance_loans (
  id uuid default gen_random_uuid() not null,
  nation_id text default 'clfn'::text not null,
  tenant_id uuid not null,
  loan_number text,
  principal numeric(12,2) not null,
  interest_rate numeric(5,3) default 0 not null,
  term_months integer not null,
  start_date date not null,
  purpose text,
  status text default 'draft'::text not null,
  approved_by text,
  approved_at timestamp with time zone,
  archived boolean default false not null,
  notes text,
  created_at timestamp with time zone default now() not null,
  created_by text not null,
  updated_at timestamp with time zone default now() not null,
  updated_by text
);
create table if not exists public.finance_rent_ledger (
  id uuid default gen_random_uuid() not null,
  nation_id text default 'clfn'::text not null,
  tenant_id uuid not null,
  unit_id text,
  entry_type text not null,
  amount numeric(12,2) not null,
  entry_date date not null,
  description text,
  voids_id uuid,
  void_reason text,
  created_at timestamp with time zone default now() not null,
  created_by text not null
);
create table if not exists public.finance_utility_gas (
  id uuid default gen_random_uuid() not null,
  nation_id text default 'clfn'::text not null,
  unit_id text not null,
  tenant_id uuid,
  period_start date not null,
  period_end date not null,
  meter_start numeric(12,2),
  meter_end numeric(12,2),
  units_used numeric(12,2) generated always as ((COALESCE(meter_end, (0)::numeric) - COALESCE(meter_start, (0)::numeric))) stored,
  amount_billed numeric(12,2) not null,
  amount_paid numeric(12,2) default 0 not null,
  invoice_id uuid,
  notes text,
  voids_id uuid,
  void_reason text,
  created_at timestamp with time zone default now() not null,
  created_by text not null
);
create table if not exists public.finance_utility_hydro (
  id uuid default gen_random_uuid() not null,
  nation_id text default 'clfn'::text not null,
  unit_id text not null,
  tenant_id uuid,
  period_start date not null,
  period_end date not null,
  meter_start numeric(12,2),
  meter_end numeric(12,2),
  kwh_used numeric(12,2) generated always as ((COALESCE(meter_end, (0)::numeric) - COALESCE(meter_start, (0)::numeric))) stored,
  amount_billed numeric(12,2) not null,
  amount_paid numeric(12,2) default 0 not null,
  invoice_id uuid,
  notes text,
  voids_id uuid,
  void_reason text,
  created_at timestamp with time zone default now() not null,
  created_by text not null
);
create table if not exists public.housing_application_notes (
  id uuid default gen_random_uuid() not null,
  app_id text not null,
  body text not null,
  author_user_id uuid,
  author_email text,
  author_name text,
  author_role text,
  created_at timestamp with time zone default now() not null
);
create table if not exists public.housing_applications (
  id text not null,
  sp_id integer,
  data jsonb not null,
  status text default 'draft'::text not null,
  score integer,
  tier text,
  classification text,
  reserve text,
  archived boolean default false,
  assigned_unit_id text,
  assigned_address text,
  submitted_at date,
  created_at timestamp with time zone default now(),
  updated_at timestamp with time zone default now(),
  urgent_need text default 'none'::text,
  health_risk text default 'none'::text,
  persons_over_standard integer default 0,
  lone_parent boolean default false,
  elder_in_household boolean default false,
  household_disability boolean default false,
  no_prior_tenancy boolean default true,
  rent_payment_history text default 'no_history'::text,
  unit_condition text default 'no_history'::text,
  tenancy_conduct text default 'no_history'::text,
  income_stability text default 'stable'::text,
  arrears_status text default 'none'::text,
  score_v2 smallint,
  tier_v2 text,
  score_breakdown_v2 jsonb,
  app_type text default 'new_housing'::text,
  nation_id text default 'clfn'::text not null,
  created_by_email text,
  transfer_pending boolean default false
);
create table if not exists public.housing_audit_log (
  id uuid default gen_random_uuid() not null,
  app_id text,
  action text not null,
  detail text,
  user_role text,
  entity_type text,
  entity_id text,
  actor text,
  created_at timestamp with time zone default now(),
  nation_id text default 'clfn'::text not null
);
create table if not exists public.housing_contacts (
  id uuid default gen_random_uuid() not null,
  data jsonb default '{}'::jsonb,
  created_at timestamp with time zone default now(),
  updated_at timestamp with time zone default now(),
  nation_id text default 'clfn'::text not null
);
create table if not exists public.housing_contractors (
  id text not null,
  name text,
  trade text,
  status text default 'pending_review'::text,
  data jsonb,
  created_at timestamp with time zone default now(),
  updated_at timestamp with time zone default now(),
  nation_id text default 'clfn'::text not null
);
create table if not exists public.housing_project_lots (
  id uuid default gen_random_uuid() not null,
  project_id uuid not null,
  lot_number text not null,
  address text,
  legal_description text,
  status text default 'raw'::text not null,
  unit_id text,
  notes text,
  data jsonb default '{}'::jsonb not null,
  created_at timestamp with time zone default now() not null
);
create table if not exists public.housing_projects (
  id uuid default gen_random_uuid() not null,
  project_number text,
  name text not null,
  type text default 'house_build'::text not null,
  status text default 'planning'::text not null,
  funding_source text,
  budget numeric,
  start_date date,
  target_date date,
  archived boolean default false not null,
  data jsonb default '{}'::jsonb not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null
);
create table if not exists public.housing_reno_budget (
  id uuid default gen_random_uuid() not null,
  unit_id text not null,
  data jsonb default '{}'::jsonb,
  created_at timestamp with time zone default now(),
  updated_at timestamp with time zone default now(),
  nation_id text default 'clfn'::text not null
);
create table if not exists public.housing_reno_progress (
  unit_id text not null,
  data jsonb not null,
  updated_at timestamp with time zone default now(),
  nation_id text default 'clfn'::text not null
);
create table if not exists public.housing_rfq (
  id text not null,
  sow_unit_id text not null,
  sow_project_number text not null,
  status text default 'draft'::text not null,
  issued_at timestamp with time zone,
  closes_at timestamp with time zone,
  recipient_contractor_ids text[] default '{}'::text[],
  awarded_contractor_id text,
  award_amount numeric,
  award_notes text,
  data jsonb default '{}'::jsonb not null,
  created_by text,
  created_at timestamp with time zone default now(),
  updated_at timestamp with time zone default now()
);
create table if not exists public.housing_settings (
  key text not null,
  value jsonb not null,
  updated_at timestamp with time zone default now(),
  nation_id text default 'clfn'::text not null
);
create table if not exists public.housing_sow (
  unit_id text not null,
  data jsonb not null,
  created_at timestamp with time zone default now(),
  updated_at timestamp with time zone default now(),
  nation_id text default 'clfn'::text not null
);
create table if not exists public.housing_unit_photos (
  id uuid default gen_random_uuid() not null,
  unit_id text not null,
  file_path text not null,
  file_name text,
  category text default 'general'::text,
  added_by text,
  added_at timestamp with time zone default now(),
  nation_id text default 'clfn'::text not null
);
create table if not exists public.housing_units (
  id text not null,
  num text,
  street text,
  bedrooms integer,
  bathrooms text,
  type text,
  foundation text,
  funder text,
  status text default 'vacant'::text,
  accessible boolean default false,
  is_elders boolean default false,
  archived boolean default false,
  assigned_to text,
  assigned_name text,
  assigned_date text,
  data jsonb,
  created_at timestamp with time zone default now(),
  updated_at timestamp with time zone default now(),
  nation_id text default 'clfn'::text not null,
  construction_cost numeric,
  latitude numeric(10,7),
  longitude numeric(10,7),
  photo_url text,
  hydro_meter_number text,
  gas_meter_number text,
  under_renovation boolean default false,
  last_inspection_date date,
  next_inspection_due date
);
create table if not exists public.inspections (
  id uuid default gen_random_uuid() not null,
  unit_id text not null,
  unit_address text,
  type text not null,
  inspection_date date not null,
  inspector_name text,
  inspector_role text,
  overall_status text default 'pending'::text,
  checklist jsonb default '[]'::jsonb,
  general_notes text,
  photos jsonb default '[]'::jsonb,
  sow_created boolean default false,
  sow_unit_id text,
  created_at timestamp with time zone default now(),
  created_by text,
  approved_by text,
  approved_at timestamp with time zone
);
create table if not exists public.magic_link_requests (
  id uuid default gen_random_uuid() not null,
  email text,
  ip text,
  created_at timestamp with time zone default now() not null
);
create table if not exists public.rent_ledger (
  id uuid default gen_random_uuid() not null,
  tenant_id uuid not null,
  monthly_rent numeric(10,2),
  arrears_balance numeric(10,2) default 0,
  arrangement_status text,
  arrangement_payment numeric(10,2),
  arrangement_start date,
  arrangement_clear_date date,
  updated_at timestamp with time zone default now() not null
);
create table if not exists public.staff (
  id bigint default nextval('staff_id_seq'::regclass) not null,
  name text not null,
  email text not null,
  role text default 'housing_employee_l1'::text not null,
  department text,
  is_active boolean default true,
  manager_email text,
  created_at timestamp with time zone default now(),
  nation_id text default 'clfn'::text not null,
  last_login_at timestamp with time zone,
  feature_access jsonb,
  access_expires_at date,
  magic_link boolean default false not null
);
create table if not exists public.tenant_movement_log (
  id uuid default gen_random_uuid() not null,
  unit_id text not null,
  unit_address text,
  tenant_name text not null,
  application_id text,
  move_in_date date,
  move_out_date date,
  duration_days integer,
  recorded_by text,
  created_at timestamp with time zone default now()
);
create table if not exists public.tenant_mr_submissions (
  id uuid default gen_random_uuid() not null,
  unit_id text not null,
  unit_address text,
  category text,
  description text not null,
  urgency text default 'routine'::text,
  contact_name text,
  contact_phone text,
  photo_path text,
  status text default 'new'::text not null,
  source_ip text,
  created_at timestamp with time zone default now() not null,
  reviewed_by text,
  reviewed_at timestamp with time zone,
  review_notes text,
  sow_project_number text,
  contact_email text
);
create table if not exists public.tenant_notes (
  id uuid default gen_random_uuid() not null,
  tenant_id uuid not null,
  note_body text not null,
  author_name text,
  created_at timestamp with time zone default now() not null
);
create table if not exists public.tenants (
  id uuid default gen_random_uuid() not null,
  nation_id text default 'clfn'::text not null,
  full_name text not null,
  band_number text,
  date_of_birth date,
  email text,
  phone text,
  current_unit_id text,
  status text default 'active'::text not null,
  moved_in_at date,
  moved_out_at date,
  notes text,
  archived boolean default false not null,
  created_at timestamp with time zone default now() not null,
  created_by text,
  updated_at timestamp with time zone default now() not null,
  updated_by text,
  street_address text,
  community text,
  province text default 'Ontario'::text,
  postal_code text,
  mailing_address text,
  tenant_type text,
  monthly_rent numeric(12,2) default 0,
  invoice_preference text default 'email'::text,
  auto_pay boolean default false not null,
  auto_pay_type text,
  hydro_account text,
  gas_account text,
  unit_number text,
  bedrooms integer,
  housing_stream text,
  move_in_date date,
  lease_type text,
  band_membership text,
  scoring_points integer,
  file_number text,
  wait_list_date date,
  vulnerability_flags text[],
  tenancy_status text,
  approved_by text,
  application_id text,
  home_care boolean default false,
  hydro_meter_number text,
  gas_meter_number text,
  lease_start_date date,
  lease_end_date date,
  merged_into uuid,
  contact_person text
);
create table if not exists public.unit_notes (
  id uuid default gen_random_uuid() not null,
  unit_id text not null,
  note_body text not null,
  author_name text,
  author_email text,
  created_at timestamp with time zone default now() not null
);
-- ============ Primary key / unique constraints ============
alter table public.app_documents add constraint app_documents_pkey PRIMARY KEY (id);
alter table public.applicant_profiles add constraint applicant_profiles_pkey PRIMARY KEY (uid);
alter table public.application_submissions add constraint application_submissions_pkey PRIMARY KEY (id);
alter table public.bcr_registry add constraint bcr_registry_pkey PRIMARY KEY (id);
alter table public.contractor_notes add constraint contractor_notes_pkey PRIMARY KEY (id);
alter table public.finance_arr_payments add constraint finance_arr_payments_pkey PRIMARY KEY (id);
alter table public.finance_arrangements add constraint finance_arrangements_pkey PRIMARY KEY (id);
alter table public.finance_audit_log add constraint finance_audit_log_pkey PRIMARY KEY (id);
alter table public.finance_collections add constraint finance_collections_pkey PRIMARY KEY (id);
alter table public.finance_invoices add constraint finance_invoices_pkey PRIMARY KEY (id);
alter table public.finance_journal add constraint finance_journal_pkey PRIMARY KEY (id);
alter table public.finance_loan_payments add constraint finance_loan_payments_pkey PRIMARY KEY (id);
alter table public.finance_loans add constraint finance_loans_pkey PRIMARY KEY (id);
alter table public.finance_rent_ledger add constraint finance_rent_ledger_pkey PRIMARY KEY (id);
alter table public.finance_utility_gas add constraint finance_utility_gas_pkey PRIMARY KEY (id);
alter table public.finance_utility_hydro add constraint finance_utility_hydro_pkey PRIMARY KEY (id);
alter table public.housing_application_notes add constraint housing_application_notes_pkey PRIMARY KEY (id);
alter table public.housing_applications add constraint housing_applications_pkey PRIMARY KEY (id);
alter table public.housing_audit_log add constraint housing_audit_log_pkey PRIMARY KEY (id);
alter table public.housing_contacts add constraint housing_contacts_pkey PRIMARY KEY (id);
alter table public.housing_contractors add constraint housing_contractors_pkey PRIMARY KEY (id);
alter table public.housing_project_lots add constraint housing_project_lots_pkey PRIMARY KEY (id);
alter table public.housing_projects add constraint housing_projects_pkey PRIMARY KEY (id);
alter table public.housing_projects add constraint housing_projects_project_number_key UNIQUE (project_number);
alter table public.housing_reno_budget add constraint housing_reno_budget_pkey PRIMARY KEY (id);
alter table public.housing_reno_budget add constraint housing_reno_budget_unit_id_key UNIQUE (unit_id);
alter table public.housing_reno_progress add constraint housing_reno_progress_pkey PRIMARY KEY (unit_id);
alter table public.housing_rfq add constraint housing_rfq_pkey PRIMARY KEY (id);
alter table public.housing_settings add constraint housing_settings_pkey PRIMARY KEY (key);
alter table public.housing_sow add constraint housing_sow_pkey PRIMARY KEY (unit_id);
alter table public.housing_unit_photos add constraint housing_unit_photos_pkey PRIMARY KEY (id);
alter table public.housing_units add constraint housing_units_pkey PRIMARY KEY (id);
alter table public.inspections add constraint inspections_pkey PRIMARY KEY (id);
alter table public.magic_link_requests add constraint magic_link_requests_pkey PRIMARY KEY (id);
alter table public.rent_ledger add constraint rent_ledger_pkey PRIMARY KEY (id);
alter table public.rent_ledger add constraint rent_ledger_tenant_id_key UNIQUE (tenant_id);
alter table public.staff add constraint staff_email_key UNIQUE (email);
alter table public.staff add constraint staff_pkey PRIMARY KEY (id);
alter table public.tenant_movement_log add constraint tenant_movement_log_pkey PRIMARY KEY (id);
alter table public.tenant_mr_submissions add constraint tenant_mr_submissions_pkey PRIMARY KEY (id);
alter table public.tenant_notes add constraint tenant_notes_pkey PRIMARY KEY (id);
alter table public.tenants add constraint tenants_pkey PRIMARY KEY (id);
alter table public.unit_notes add constraint unit_notes_pkey PRIMARY KEY (id);
-- ============ Check / foreign key constraints ============
alter table public.contractor_notes add constraint contractor_notes_contractor_id_fkey FOREIGN KEY (contractor_id) REFERENCES housing_contractors(id) ON DELETE CASCADE;
alter table public.finance_arr_payments add constraint finance_arr_payments_amount_check CHECK ((amount > (0)::numeric));
alter table public.finance_arr_payments add constraint finance_arr_payments_arrangement_id_fkey FOREIGN KEY (arrangement_id) REFERENCES finance_arrangements(id) ON DELETE RESTRICT;
alter table public.finance_arr_payments add constraint finance_arr_payments_invoice_id_fkey FOREIGN KEY (invoice_id) REFERENCES finance_invoices(id) ON DELETE RESTRICT;
alter table public.finance_arr_payments add constraint finance_arr_payments_voids_id_fkey FOREIGN KEY (voids_id) REFERENCES finance_arr_payments(id) ON DELETE RESTRICT;
alter table public.finance_arrangements add constraint finance_arrangements_frequency_check CHECK ((frequency = ANY (ARRAY['weekly'::text, 'biweekly'::text, 'monthly'::text, 'quarterly'::text])));
alter table public.finance_arrangements add constraint finance_arrangements_payment_amount_check CHECK ((payment_amount > (0)::numeric));
alter table public.finance_arrangements add constraint finance_arrangements_status_check CHECK ((status = ANY (ARRAY['draft'::text, 'active'::text, 'completed'::text, 'broken'::text, 'cancelled'::text])));
alter table public.finance_arrangements add constraint finance_arrangements_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT;
alter table public.finance_arrangements add constraint finance_arrangements_total_owing_check CHECK ((total_owing > (0)::numeric));
alter table public.finance_audit_log add constraint finance_audit_log_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT;
alter table public.finance_collections add constraint finance_collections_stage_check CHECK ((stage = ANY (ARRAY['flagged'::text, 'letter_1'::text, 'letter_2'::text, 'final_notice'::text, 'legal_referral'::text, 'written_off'::text, 'resolved'::text, 'closed'::text])));
alter table public.finance_collections add constraint finance_collections_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT;
alter table public.finance_invoices add constraint finance_invoices_amount_check CHECK ((amount > (0)::numeric));
alter table public.finance_invoices add constraint finance_invoices_status_check CHECK ((status = ANY (ARRAY['draft'::text, 'open'::text, 'partial'::text, 'paid'::text, 'cancelled'::text, 'written_off'::text])));
alter table public.finance_invoices add constraint finance_invoices_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT;
alter table public.finance_invoices add constraint finance_invoices_unit_id_fkey FOREIGN KEY (unit_id) REFERENCES housing_units(id) ON DELETE SET NULL;
alter table public.finance_journal add constraint chk_journal_dr_or_cr CHECK ((((debit > (0)::numeric) AND (credit = (0)::numeric)) OR ((debit = (0)::numeric) AND (credit > (0)::numeric))));
alter table public.finance_journal add constraint finance_journal_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT;
alter table public.finance_journal add constraint finance_journal_voids_id_fkey FOREIGN KEY (voids_id) REFERENCES finance_journal(id) ON DELETE RESTRICT;
alter table public.finance_loan_payments add constraint finance_loan_payments_loan_id_fkey FOREIGN KEY (loan_id) REFERENCES finance_loans(id) ON DELETE RESTRICT;
alter table public.finance_loan_payments add constraint finance_loan_payments_voids_id_fkey FOREIGN KEY (voids_id) REFERENCES finance_loan_payments(id) ON DELETE RESTRICT;
alter table public.finance_loans add constraint finance_loans_principal_check CHECK ((principal > (0)::numeric));
alter table public.finance_loans add constraint finance_loans_status_check CHECK ((status = ANY (ARRAY['draft'::text, 'pending_approval'::text, 'approved'::text, 'active'::text, 'closed'::text, 'defaulted'::text, 'cancelled'::text])));
alter table public.finance_loans add constraint finance_loans_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT;
alter table public.finance_loans add constraint finance_loans_term_months_check CHECK ((term_months > 0));
alter table public.finance_rent_ledger add constraint finance_rent_ledger_entry_type_check CHECK ((entry_type = ANY (ARRAY['opening_balance'::text, 'rent_charge'::text, 'payment'::text, 'adjustment_credit'::text, 'adjustment_debit'::text, 'void'::text])));
alter table public.finance_rent_ledger add constraint finance_rent_ledger_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT;
alter table public.finance_rent_ledger add constraint finance_rent_ledger_unit_id_fkey FOREIGN KEY (unit_id) REFERENCES housing_units(id) ON DELETE SET NULL;
alter table public.finance_rent_ledger add constraint finance_rent_ledger_voids_id_fkey FOREIGN KEY (voids_id) REFERENCES finance_rent_ledger(id) ON DELETE RESTRICT;
alter table public.finance_utility_gas add constraint chk_gas_period CHECK ((period_end >= period_start));
alter table public.finance_utility_gas add constraint finance_utility_gas_invoice_id_fkey FOREIGN KEY (invoice_id) REFERENCES finance_invoices(id) ON DELETE SET NULL;
alter table public.finance_utility_gas add constraint finance_utility_gas_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE SET NULL;
alter table public.finance_utility_gas add constraint finance_utility_gas_unit_id_fkey FOREIGN KEY (unit_id) REFERENCES housing_units(id) ON DELETE RESTRICT;
alter table public.finance_utility_gas add constraint finance_utility_gas_voids_id_fkey FOREIGN KEY (voids_id) REFERENCES finance_utility_gas(id) ON DELETE RESTRICT;
alter table public.finance_utility_hydro add constraint chk_hydro_period CHECK ((period_end >= period_start));
alter table public.finance_utility_hydro add constraint finance_utility_hydro_invoice_id_fkey FOREIGN KEY (invoice_id) REFERENCES finance_invoices(id) ON DELETE SET NULL;
alter table public.finance_utility_hydro add constraint finance_utility_hydro_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE SET NULL;
alter table public.finance_utility_hydro add constraint finance_utility_hydro_unit_id_fkey FOREIGN KEY (unit_id) REFERENCES housing_units(id) ON DELETE RESTRICT;
alter table public.finance_utility_hydro add constraint finance_utility_hydro_voids_id_fkey FOREIGN KEY (voids_id) REFERENCES finance_utility_hydro(id) ON DELETE RESTRICT;
alter table public.housing_application_notes add constraint housing_application_notes_body_check CHECK ((length(TRIM(BOTH FROM body)) > 0));
alter table public.housing_applications add constraint chk_arrears_status CHECK ((arrears_status = ANY (ARRAY['none'::text, 'cleared'::text, 'repayment'::text, 'no_repayment'::text])));
alter table public.housing_applications add constraint chk_health_risk CHECK ((health_risk = ANY (ARRAY['severe'::text, 'moderate'::text, 'minor'::text, 'none'::text])));
alter table public.housing_applications add constraint chk_income_stability CHECK ((income_stability = ANY (ARRAY['stable'::text, 'irregular'::text, 'none'::text])));
alter table public.housing_applications add constraint chk_rent_payment_history CHECK ((rent_payment_history = ANY (ARRAY['excellent'::text, 'mostly'::text, 'occasional'::text, 'frequent'::text, 'no_history'::text])));
alter table public.housing_applications add constraint chk_tenancy_conduct CHECK ((tenancy_conduct = ANY (ARRAY['clean'::text, 'minor'::text, 'unresolved'::text, 'no_history'::text])));
alter table public.housing_applications add constraint chk_unit_condition CHECK ((unit_condition = ANY (ARRAY['excellent'::text, 'good'::text, 'fair'::text, 'damage'::text, 'no_history'::text])));
alter table public.housing_project_lots add constraint housing_project_lots_project_id_fkey FOREIGN KEY (project_id) REFERENCES housing_projects(id) ON DELETE CASCADE;
alter table public.housing_project_lots add constraint housing_project_lots_unit_id_fkey FOREIGN KEY (unit_id) REFERENCES housing_units(id) ON DELETE SET NULL;
alter table public.rent_ledger add constraint rent_ledger_arrangement_status_check CHECK (((arrangement_status IS NULL) OR (arrangement_status = ANY (ARRAY['none'::text, 'active'::text, 'completed'::text, 'defaulted'::text]))));
alter table public.rent_ledger add constraint rent_ledger_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;
alter table public.tenant_notes add constraint tenant_notes_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;
alter table public.tenants add constraint tenants_auto_pay_type_chk CHECK (((auto_pay_type IS NULL) OR (auto_pay_type = ANY (ARRAY['eft'::text, 'payroll'::text]))));
alter table public.tenants add constraint tenants_current_unit_id_fkey FOREIGN KEY (current_unit_id) REFERENCES housing_units(id) ON DELETE SET NULL;
alter table public.tenants add constraint tenants_invoice_preference_chk CHECK (((invoice_preference IS NULL) OR (invoice_preference = ANY (ARRAY['email'::text, 'print'::text]))));
alter table public.tenants add constraint tenants_merged_into_fkey FOREIGN KEY (merged_into) REFERENCES tenants(id) ON DELETE SET NULL;
alter table public.tenants add constraint tenants_status_check CHECK ((status = ANY (ARRAY['applicant'::text, 'active'::text, 'former'::text, 'deceased'::text, 'evicted'::text])));
alter table public.tenants add constraint tenants_tenant_type_chk CHECK (((tenant_type IS NULL) OR (tenant_type = ANY (ARRAY['band-on'::text, 'band-off'::text, 'band-staff'::text, 'clea'::text, 'community'::text]))));
alter table public.unit_notes add constraint unit_notes_unit_id_fkey FOREIGN KEY (unit_id) REFERENCES housing_units(id) ON DELETE CASCADE;
-- ============ Indexes ============
CREATE INDEX app_documents_app_id_idx ON public.app_documents USING btree (app_id);
CREATE INDEX app_sub_linked_idx ON public.application_submissions USING btree (linked_app_id);
CREATE INDEX app_sub_owner_idx ON public.application_submissions USING btree (applicant_uid, updated_at DESC);
CREATE INDEX app_sub_status_idx ON public.application_submissions USING btree (status, updated_at DESC);
CREATE INDEX bcr_registry_active_idx ON public.bcr_registry USING btree (active);
CREATE INDEX bcr_registry_name_idx ON public.bcr_registry USING btree (lower(full_name));
CREATE INDEX housing_rfq_sow_idx ON public.housing_rfq USING btree (sow_unit_id, sow_project_number);
CREATE INDEX housing_rfq_status_idx ON public.housing_rfq USING btree (status);
CREATE INDEX housing_rfq_year_idx ON public.housing_rfq USING btree ("left"(id, 8));
CREATE INDEX housing_unit_photos_unit_id_idx ON public.housing_unit_photos USING btree (unit_id);
CREATE INDEX idx_arr_nation ON public.finance_arrangements USING btree (nation_id);
CREATE INDEX idx_arr_status ON public.finance_arrangements USING btree (status) WHERE (archived = false);
CREATE INDEX idx_arr_tenant ON public.finance_arrangements USING btree (tenant_id);
CREATE INDEX idx_arrpay_arrangement ON public.finance_arr_payments USING btree (arrangement_id);
CREATE INDEX idx_arrpay_invoice ON public.finance_arr_payments USING btree (invoice_id) WHERE (invoice_id IS NOT NULL);
CREATE INDEX idx_arrpay_nation ON public.finance_arr_payments USING btree (nation_id);
CREATE INDEX idx_col_nation ON public.finance_collections USING btree (nation_id);
CREATE INDEX idx_col_open ON public.finance_collections USING btree (opened_date DESC) WHERE (closed_date IS NULL);
CREATE INDEX idx_col_stage ON public.finance_collections USING btree (stage) WHERE (archived = false);
CREATE INDEX idx_col_tenant ON public.finance_collections USING btree (tenant_id);
CREATE INDEX idx_contractor_notes_ct_created ON public.contractor_notes USING btree (contractor_id, created_at DESC);
CREATE INDEX idx_finaudit_actor ON public.finance_audit_log USING btree (actor_email);
CREATE INDEX idx_finaudit_entity ON public.finance_audit_log USING btree (entity_type, entity_id);
CREATE INDEX idx_finaudit_nation ON public.finance_audit_log USING btree (nation_id);
CREATE INDEX idx_finaudit_occurred ON public.finance_audit_log USING btree (occurred_at DESC);
CREATE INDEX idx_finaudit_tenant ON public.finance_audit_log USING btree (tenant_id) WHERE (tenant_id IS NOT NULL);
CREATE INDEX idx_gas_nation ON public.finance_utility_gas USING btree (nation_id);
CREATE INDEX idx_gas_period ON public.finance_utility_gas USING btree (period_start DESC);
CREATE INDEX idx_gas_tenant ON public.finance_utility_gas USING btree (tenant_id) WHERE (tenant_id IS NOT NULL);
CREATE INDEX idx_gas_unit ON public.finance_utility_gas USING btree (unit_id);
CREATE INDEX idx_housing_app_notes_app_id_created ON public.housing_application_notes USING btree (app_id, created_at DESC);
CREATE INDEX idx_housing_applications_nation_id ON public.housing_applications USING btree (nation_id);
CREATE INDEX idx_housing_apps_score_v2 ON public.housing_applications USING btree (score_v2 DESC NULLS LAST);
CREATE INDEX idx_housing_apps_tier_v2 ON public.housing_applications USING btree (tier_v2);
CREATE INDEX idx_housing_audit_log_nation_id ON public.housing_audit_log USING btree (nation_id);
CREATE INDEX idx_housing_contractors_nation_id ON public.housing_contractors USING btree (nation_id);
CREATE INDEX idx_housing_project_lots_project ON public.housing_project_lots USING btree (project_id);
CREATE INDEX idx_housing_project_lots_unit ON public.housing_project_lots USING btree (unit_id);
CREATE INDEX idx_housing_reno_progress_nation_id ON public.housing_reno_progress USING btree (nation_id);
CREATE INDEX idx_housing_sow_nation_id ON public.housing_sow USING btree (nation_id);
CREATE INDEX idx_housing_units_nation_id ON public.housing_units USING btree (nation_id);
CREATE INDEX idx_hydro_nation ON public.finance_utility_hydro USING btree (nation_id);
CREATE INDEX idx_hydro_period ON public.finance_utility_hydro USING btree (period_start DESC);
CREATE INDEX idx_hydro_tenant ON public.finance_utility_hydro USING btree (tenant_id) WHERE (tenant_id IS NOT NULL);
CREATE INDEX idx_hydro_unit ON public.finance_utility_hydro USING btree (unit_id);
CREATE INDEX idx_invoices_due ON public.finance_invoices USING btree (due_date) WHERE ((status = ANY (ARRAY['open'::text, 'partial'::text])) AND (archived = false));
CREATE INDEX idx_invoices_nation ON public.finance_invoices USING btree (nation_id);
CREATE INDEX idx_invoices_status ON public.finance_invoices USING btree (status) WHERE (archived = false);
CREATE INDEX idx_invoices_tenant ON public.finance_invoices USING btree (tenant_id);
CREATE INDEX idx_journal_account ON public.finance_journal USING btree (account_code) WHERE (account_code IS NOT NULL);
CREATE INDEX idx_journal_date ON public.finance_journal USING btree (entry_date DESC);
CREATE INDEX idx_journal_nation ON public.finance_journal USING btree (nation_id);
CREATE INDEX idx_journal_tenant ON public.finance_journal USING btree (tenant_id) WHERE (tenant_id IS NOT NULL);
CREATE INDEX idx_loanpay_date ON public.finance_loan_payments USING btree (payment_date DESC);
CREATE INDEX idx_loanpay_loan ON public.finance_loan_payments USING btree (loan_id);
CREATE INDEX idx_loanpay_nation ON public.finance_loan_payments USING btree (nation_id);
CREATE INDEX idx_loans_nation ON public.finance_loans USING btree (nation_id);
CREATE INDEX idx_loans_status ON public.finance_loans USING btree (status) WHERE (archived = false);
CREATE INDEX idx_loans_tenant ON public.finance_loans USING btree (tenant_id);
CREATE INDEX idx_rentled_date ON public.finance_rent_ledger USING btree (entry_date DESC);
CREATE INDEX idx_rentled_nation ON public.finance_rent_ledger USING btree (nation_id);
CREATE INDEX idx_rentled_tenant ON public.finance_rent_ledger USING btree (tenant_id);
CREATE INDEX idx_rentled_tenant_date ON public.finance_rent_ledger USING btree (tenant_id, entry_date DESC);
CREATE INDEX idx_rentled_voids ON public.finance_rent_ledger USING btree (voids_id) WHERE (voids_id IS NOT NULL);
CREATE INDEX idx_tenants_current_unit ON public.tenants USING btree (current_unit_id) WHERE (archived = false);
CREATE INDEX idx_tenants_name_search ON public.tenants USING gin (to_tsvector('english'::regconfig, full_name));
CREATE INDEX idx_tenants_nation ON public.tenants USING btree (nation_id);
CREATE INDEX idx_tenants_status_active ON public.tenants USING btree (status) WHERE (archived = false);
CREATE INDEX idx_unit_notes_unit_created ON public.unit_notes USING btree (unit_id, created_at DESC);
CREATE INDEX inspections_date_idx ON public.inspections USING btree (inspection_date DESC);
CREATE INDEX inspections_unit_id_idx ON public.inspections USING btree (unit_id);
CREATE INDEX mlr_email_idx ON public.magic_link_requests USING btree (email, created_at DESC);
CREATE INDEX mlr_ip_idx ON public.magic_link_requests USING btree (ip, created_at DESC);
CREATE INDEX rent_ledger_tenant_id_idx ON public.rent_ledger USING btree (tenant_id);
CREATE INDEX tenant_mr_ip_idx ON public.tenant_mr_submissions USING btree (source_ip, created_at DESC);
CREATE INDEX tenant_mr_status_idx ON public.tenant_mr_submissions USING btree (status, created_at DESC);
CREATE INDEX tenant_mr_unit_idx ON public.tenant_mr_submissions USING btree (unit_id, created_at DESC);
CREATE INDEX tenant_notes_tenant_id_created_idx ON public.tenant_notes USING btree (tenant_id, created_at DESC);
CREATE INDEX tenant_notes_tenant_id_idx ON public.tenant_notes USING btree (tenant_id);
CREATE INDEX tenants_merged_into_idx ON public.tenants USING btree (merged_into);
-- ============ Functions ============
CREATE OR REPLACE FUNCTION public._block_app_notes_mutation()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
begin
  raise exception 'housing_application_notes is append-only - UPDATE/DELETE not permitted';
end;
$function$
;
CREATE OR REPLACE FUNCTION public._hs_block_mutation()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
begin
  raise exception '% is append-only - UPDATE/DELETE not permitted', tg_table_name;
end $function$
;
CREATE OR REPLACE FUNCTION public.block_audit_modifications()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  RAISE EXCEPTION 'Audit log rows are append-only. % on % is not permitted.',
    TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'insufficient_privilege';
END;
$function$
;
CREATE OR REPLACE FUNCTION public.clfn_is_active_staff()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM   staff
    WHERE  email     = auth.jwt() ->> 'email'
      AND  is_active = true
  );
$function$
;
CREATE OR REPLACE FUNCTION public.get_my_role()
 RETURNS text
 LANGUAGE sql
 STABLE SECURITY DEFINER
AS $function$
  SELECT role
  FROM staff
  WHERE email     = auth.jwt()->>'email'
    AND is_active = true
  LIMIT 1;
$function$
;
CREATE OR REPLACE FUNCTION public.is_finance_role()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
AS $function$
  SELECT get_my_role() IN (
    'ed', 'housing_manager', 'housing_employee_l2',
    'cfo', 'finance_l1'
  );
$function$
;
CREATE OR REPLACE FUNCTION public.is_housing_role()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
AS $function$
  SELECT get_my_role() IN (
    'ed', 'housing_manager',
    'housing_employee_l2', 'housing_employee_l1'
  );
$function$
;
CREATE OR REPLACE FUNCTION public.next_housing_app_id()
 RETURNS text
 LANGUAGE sql
AS $function$
  select 'APP-' || lpad(nextval('public.housing_app_id_seq')::text, 6, '0');
$function$
;
CREATE OR REPLACE FUNCTION public.sync_tenants_from_unit()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  old_name text := COALESCE(TRIM(OLD.assigned_name), '');
  new_name text := COALESCE(TRIM(NEW.assigned_name), '');
  new_tenant_id uuid;
BEGIN
  IF old_name = new_name THEN
    RETURN NEW;
  END IF;

  IF old_name <> '' AND new_name = '' THEN
    UPDATE public.tenants
      SET status          = 'former',
          current_unit_id = NULL,
          moved_out_at    = COALESCE(moved_out_at, CURRENT_DATE),
          updated_at      = now()
      WHERE current_unit_id = NEW.id
        AND full_name = old_name
        AND status = 'active';
    RETURN NEW;
  END IF;

  IF new_name <> '' THEN
    IF old_name <> '' THEN
      UPDATE public.tenants
        SET status          = 'former',
            current_unit_id = NULL,
            moved_out_at    = COALESCE(moved_out_at, CURRENT_DATE),
            updated_at      = now()
        WHERE current_unit_id = NEW.id
          AND full_name = old_name
          AND status = 'active';
    END IF;

    INSERT INTO public.tenants (
      nation_id, full_name, current_unit_id, status, moved_in_at, created_by, updated_by
    ) VALUES (
      COALESCE(NEW.nation_id, 'clfn'),
      new_name,
      NEW.id,
      'active',
      COALESCE(NEW.assigned_date::date, CURRENT_DATE),
      'system:tenants_sync',
      'system:tenants_sync'
    )
    RETURNING id INTO new_tenant_id;
  END IF;

  RETURN NEW;
END;
$function$
;
CREATE OR REPLACE FUNCTION public.touch_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$function$
;
CREATE OR REPLACE FUNCTION public.update_housing_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
begin
  new.updated_at = now();
  return new;
end;
$function$
;
-- ============ Triggers ============
CREATE TRIGGER trg_finance_arrangements_touch_updated_at BEFORE UPDATE ON public.finance_arrangements FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER trg_finance_audit_log_block_del BEFORE DELETE ON public.finance_audit_log FOR EACH ROW EXECUTE FUNCTION _hs_block_mutation();
CREATE TRIGGER trg_finance_audit_log_block_upd BEFORE UPDATE ON public.finance_audit_log FOR EACH ROW EXECUTE FUNCTION _hs_block_mutation();
CREATE TRIGGER trg_finaudit_no_modify BEFORE DELETE OR UPDATE ON public.finance_audit_log FOR EACH ROW EXECUTE FUNCTION block_audit_modifications();
CREATE TRIGGER trg_finance_collections_touch_updated_at BEFORE UPDATE ON public.finance_collections FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER trg_finance_invoices_touch_updated_at BEFORE UPDATE ON public.finance_invoices FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER trg_finance_loans_touch_updated_at BEFORE UPDATE ON public.finance_loans FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER trg_block_app_notes_delete BEFORE DELETE ON public.housing_application_notes FOR EACH ROW EXECUTE FUNCTION _block_app_notes_mutation();
CREATE TRIGGER trg_block_app_notes_update BEFORE UPDATE ON public.housing_application_notes FOR EACH ROW EXECUTE FUNCTION _block_app_notes_mutation();
CREATE TRIGGER housing_applications_updated_at BEFORE UPDATE ON public.housing_applications FOR EACH ROW EXECUTE FUNCTION update_housing_updated_at();
CREATE TRIGGER trg_housaudit_no_modify BEFORE DELETE OR UPDATE ON public.housing_audit_log FOR EACH ROW EXECUTE FUNCTION block_audit_modifications();
CREATE TRIGGER trg_housing_audit_log_block_del BEFORE DELETE ON public.housing_audit_log FOR EACH ROW EXECUTE FUNCTION _hs_block_mutation();
CREATE TRIGGER trg_housing_audit_log_block_upd BEFORE UPDATE ON public.housing_audit_log FOR EACH ROW EXECUTE FUNCTION _hs_block_mutation();
CREATE TRIGGER housing_contractors_updated_at BEFORE UPDATE ON public.housing_contractors FOR EACH ROW EXECUTE FUNCTION update_housing_updated_at();
CREATE TRIGGER housing_reno_progress_updated_at BEFORE UPDATE ON public.housing_reno_progress FOR EACH ROW EXECUTE FUNCTION update_housing_updated_at();
CREATE TRIGGER housing_sow_updated_at BEFORE UPDATE ON public.housing_sow FOR EACH ROW EXECUTE FUNCTION update_housing_updated_at();
CREATE TRIGGER housing_units_updated_at BEFORE UPDATE ON public.housing_units FOR EACH ROW EXECUTE FUNCTION update_housing_updated_at();
CREATE TRIGGER trg_units_sync_tenants AFTER INSERT OR UPDATE OF assigned_name, assigned_date ON public.housing_units FOR EACH ROW EXECUTE FUNCTION sync_tenants_from_unit();
CREATE TRIGGER trg_tenants_touch_updated_at BEFORE UPDATE ON public.tenants FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
-- ============ Views ============
-- ============ Row level security ============
alter table public.app_documents enable row level security;
alter table public.applicant_profiles enable row level security;
alter table public.application_submissions enable row level security;
alter table public.bcr_registry enable row level security;
alter table public.contractor_notes enable row level security;
alter table public.finance_arr_payments enable row level security;
alter table public.finance_arrangements enable row level security;
alter table public.finance_audit_log enable row level security;
alter table public.finance_collections enable row level security;
alter table public.finance_invoices enable row level security;
alter table public.finance_journal enable row level security;
alter table public.finance_loan_payments enable row level security;
alter table public.finance_loans enable row level security;
alter table public.finance_rent_ledger enable row level security;
alter table public.finance_utility_gas enable row level security;
alter table public.finance_utility_hydro enable row level security;
alter table public.housing_application_notes enable row level security;
alter table public.housing_applications enable row level security;
alter table public.housing_audit_log enable row level security;
alter table public.housing_contacts enable row level security;
alter table public.housing_contractors enable row level security;
alter table public.housing_project_lots enable row level security;
alter table public.housing_projects enable row level security;
alter table public.housing_reno_budget enable row level security;
alter table public.housing_reno_progress enable row level security;
alter table public.housing_rfq enable row level security;
alter table public.housing_settings enable row level security;
alter table public.housing_sow enable row level security;
alter table public.housing_unit_photos enable row level security;
alter table public.housing_units enable row level security;
alter table public.inspections enable row level security;
alter table public.magic_link_requests enable row level security;
alter table public.rent_ledger enable row level security;
alter table public.staff enable row level security;
alter table public.tenant_movement_log enable row level security;
alter table public.tenant_mr_submissions enable row level security;
alter table public.tenant_notes enable row level security;
alter table public.tenants enable row level security;
alter table public.unit_notes enable row level security;
-- ============ Policies ============
create policy staff_delete on public.app_documents as PERMISSIVE for DELETE to authenticated using ((get_my_role() IS NOT NULL));
create policy staff_insert on public.app_documents as PERMISSIVE for INSERT to authenticated with check ((get_my_role() IS NOT NULL));
create policy staff_select on public.app_documents as PERMISSIVE for SELECT to authenticated using ((get_my_role() IS NOT NULL));
create policy staff_update on public.app_documents as PERMISSIVE for UPDATE to authenticated using ((get_my_role() IS NOT NULL)) with check ((get_my_role() IS NOT NULL));
create policy applicant_profiles_select on public.applicant_profiles as PERMISSIVE for SELECT to public using (((uid = auth.uid()) OR (EXISTS ( SELECT 1
   FROM staff s
  WHERE ((lower(s.email) = lower((auth.jwt() ->> 'email'::text))) AND s.is_active)))));
create policy applicant_profiles_staff_update on public.applicant_profiles as PERMISSIVE for UPDATE to public using ((EXISTS ( SELECT 1
   FROM staff s
  WHERE ((lower(s.email) = lower((auth.jwt() ->> 'email'::text))) AND s.is_active))));
create policy app_sub_select on public.application_submissions as PERMISSIVE for SELECT to public using (((applicant_uid = auth.uid()) OR (EXISTS ( SELECT 1
   FROM staff s
  WHERE ((lower(s.email) = lower((auth.jwt() ->> 'email'::text))) AND s.is_active)))));
create policy app_sub_staff_update on public.application_submissions as PERMISSIVE for UPDATE to public using ((EXISTS ( SELECT 1
   FROM staff s
  WHERE ((lower(s.email) = lower((auth.jwt() ->> 'email'::text))) AND s.is_active))));
create policy staff_delete on public.bcr_registry as PERMISSIVE for DELETE to authenticated using ((get_my_role() IS NOT NULL));
create policy staff_insert on public.bcr_registry as PERMISSIVE for INSERT to authenticated with check ((get_my_role() IS NOT NULL));
create policy staff_select on public.bcr_registry as PERMISSIVE for SELECT to authenticated using ((get_my_role() IS NOT NULL));
create policy staff_update on public.bcr_registry as PERMISSIVE for UPDATE to authenticated using ((get_my_role() IS NOT NULL)) with check ((get_my_role() IS NOT NULL));
create policy contractor_notes_insert_staff on public.contractor_notes as PERMISSIVE for INSERT to public with check ((get_my_role() IS NOT NULL));
create policy contractor_notes_select_staff on public.contractor_notes as PERMISSIVE for SELECT to public using ((get_my_role() IS NOT NULL));
create policy staff_delete on public.finance_arr_payments as PERMISSIVE for DELETE to authenticated using (is_finance_role());
create policy staff_insert on public.finance_arr_payments as PERMISSIVE for INSERT to authenticated with check (is_finance_role());
create policy staff_select on public.finance_arr_payments as PERMISSIVE for SELECT to authenticated using (is_finance_role());
create policy staff_update on public.finance_arr_payments as PERMISSIVE for UPDATE to authenticated using (is_finance_role()) with check (is_finance_role());
create policy staff_delete on public.finance_arrangements as PERMISSIVE for DELETE to authenticated using (is_finance_role());
create policy staff_insert on public.finance_arrangements as PERMISSIVE for INSERT to authenticated with check (is_finance_role());
create policy staff_select on public.finance_arrangements as PERMISSIVE for SELECT to authenticated using (is_finance_role());
create policy staff_update on public.finance_arrangements as PERMISSIVE for UPDATE to authenticated using (is_finance_role()) with check (is_finance_role());
create policy fin_audit_insert on public.finance_audit_log as PERMISSIVE for INSERT to authenticated with check (true);
create policy fin_audit_log_read_finance_roles on public.finance_audit_log as PERMISSIVE for SELECT to authenticated using (is_finance_role());
create policy staff_delete on public.finance_collections as PERMISSIVE for DELETE to authenticated using (is_finance_role());
create policy staff_insert on public.finance_collections as PERMISSIVE for INSERT to authenticated with check (is_finance_role());
create policy staff_select on public.finance_collections as PERMISSIVE for SELECT to authenticated using (is_finance_role());
create policy staff_update on public.finance_collections as PERMISSIVE for UPDATE to authenticated using (is_finance_role()) with check (is_finance_role());
create policy staff_delete on public.finance_invoices as PERMISSIVE for DELETE to authenticated using (is_finance_role());
create policy staff_insert on public.finance_invoices as PERMISSIVE for INSERT to authenticated with check (is_finance_role());
create policy staff_select on public.finance_invoices as PERMISSIVE for SELECT to authenticated using (is_finance_role());
create policy staff_update on public.finance_invoices as PERMISSIVE for UPDATE to authenticated using (is_finance_role()) with check (is_finance_role());
create policy staff_delete on public.finance_journal as PERMISSIVE for DELETE to authenticated using (is_finance_role());
create policy staff_insert on public.finance_journal as PERMISSIVE for INSERT to authenticated with check (is_finance_role());
create policy staff_select on public.finance_journal as PERMISSIVE for SELECT to authenticated using (is_finance_role());
create policy staff_update on public.finance_journal as PERMISSIVE for UPDATE to authenticated using (is_finance_role()) with check (is_finance_role());
create policy staff_delete on public.finance_loan_payments as PERMISSIVE for DELETE to authenticated using (is_finance_role());
create policy staff_insert on public.finance_loan_payments as PERMISSIVE for INSERT to authenticated with check (is_finance_role());
create policy staff_select on public.finance_loan_payments as PERMISSIVE for SELECT to authenticated using (is_finance_role());
create policy staff_update on public.finance_loan_payments as PERMISSIVE for UPDATE to authenticated using (is_finance_role()) with check (is_finance_role());
create policy staff_delete on public.finance_loans as PERMISSIVE for DELETE to authenticated using (is_finance_role());
create policy staff_insert on public.finance_loans as PERMISSIVE for INSERT to authenticated with check (is_finance_role());
create policy staff_select on public.finance_loans as PERMISSIVE for SELECT to authenticated using (is_finance_role());
create policy staff_update on public.finance_loans as PERMISSIVE for UPDATE to authenticated using (is_finance_role()) with check (is_finance_role());
create policy staff_delete on public.finance_rent_ledger as PERMISSIVE for DELETE to authenticated using (is_finance_role());
create policy staff_insert on public.finance_rent_ledger as PERMISSIVE for INSERT to authenticated with check (is_finance_role());
create policy staff_select on public.finance_rent_ledger as PERMISSIVE for SELECT to authenticated using (is_finance_role());
create policy staff_update on public.finance_rent_ledger as PERMISSIVE for UPDATE to authenticated using (is_finance_role()) with check (is_finance_role());
create policy staff_delete on public.finance_utility_gas as PERMISSIVE for DELETE to authenticated using (is_finance_role());
create policy staff_insert on public.finance_utility_gas as PERMISSIVE for INSERT to authenticated with check (is_finance_role());
create policy staff_select on public.finance_utility_gas as PERMISSIVE for SELECT to authenticated using (is_finance_role());
create policy staff_update on public.finance_utility_gas as PERMISSIVE for UPDATE to authenticated using (is_finance_role()) with check (is_finance_role());
create policy staff_delete on public.finance_utility_hydro as PERMISSIVE for DELETE to authenticated using (is_finance_role());
create policy staff_insert on public.finance_utility_hydro as PERMISSIVE for INSERT to authenticated with check (is_finance_role());
create policy staff_select on public.finance_utility_hydro as PERMISSIVE for SELECT to authenticated using (is_finance_role());
create policy staff_update on public.finance_utility_hydro as PERMISSIVE for UPDATE to authenticated using (is_finance_role()) with check (is_finance_role());
create policy staff_insert on public.housing_application_notes as PERMISSIVE for INSERT to authenticated with check (is_housing_role());
create policy staff_select on public.housing_application_notes as PERMISSIVE for SELECT to authenticated using (is_housing_role());
create policy staff_delete on public.housing_applications as PERMISSIVE for DELETE to authenticated using (is_housing_role());
create policy staff_insert on public.housing_applications as PERMISSIVE for INSERT to authenticated with check (is_housing_role());
create policy staff_select on public.housing_applications as PERMISSIVE for SELECT to authenticated using (is_housing_role());
create policy staff_update on public.housing_applications as PERMISSIVE for UPDATE to authenticated using (is_housing_role()) with check (is_housing_role());
create policy "Allow authenticated inserts" on public.housing_audit_log as PERMISSIVE for INSERT to authenticated with check (true);
create policy audit_log_read_housing_roles on public.housing_audit_log as PERMISSIVE for SELECT to authenticated using ((is_housing_role() OR is_finance_role()));
create policy staff_delete on public.housing_contacts as PERMISSIVE for DELETE to authenticated using ((get_my_role() IS NOT NULL));
create policy staff_insert on public.housing_contacts as PERMISSIVE for INSERT to authenticated with check ((get_my_role() IS NOT NULL));
create policy staff_select on public.housing_contacts as PERMISSIVE for SELECT to authenticated using ((get_my_role() IS NOT NULL));
create policy staff_update on public.housing_contacts as PERMISSIVE for UPDATE to authenticated using ((get_my_role() IS NOT NULL)) with check ((get_my_role() IS NOT NULL));
create policy staff_delete on public.housing_contractors as PERMISSIVE for DELETE to authenticated using ((get_my_role() IS NOT NULL));
create policy staff_insert on public.housing_contractors as PERMISSIVE for INSERT to authenticated with check ((get_my_role() IS NOT NULL));
create policy staff_select on public.housing_contractors as PERMISSIVE for SELECT to authenticated using ((get_my_role() IS NOT NULL));
create policy staff_update on public.housing_contractors as PERMISSIVE for UPDATE to authenticated using ((get_my_role() IS NOT NULL)) with check ((get_my_role() IS NOT NULL));
create policy housing_project_lots_delete_staff on public.housing_project_lots as PERMISSIVE for DELETE to public using ((get_my_role() IS NOT NULL));
create policy housing_project_lots_insert_staff on public.housing_project_lots as PERMISSIVE for INSERT to public with check ((get_my_role() IS NOT NULL));
create policy housing_project_lots_select_staff on public.housing_project_lots as PERMISSIVE for SELECT to public using ((get_my_role() IS NOT NULL));
create policy housing_project_lots_update_staff on public.housing_project_lots as PERMISSIVE for UPDATE to public using ((get_my_role() IS NOT NULL));
create policy housing_projects_insert_staff on public.housing_projects as PERMISSIVE for INSERT to public with check ((get_my_role() IS NOT NULL));
create policy housing_projects_select_staff on public.housing_projects as PERMISSIVE for SELECT to public using ((get_my_role() IS NOT NULL));
create policy housing_projects_update_staff on public.housing_projects as PERMISSIVE for UPDATE to public using ((get_my_role() IS NOT NULL));
create policy staff_delete on public.housing_reno_budget as PERMISSIVE for DELETE to authenticated using ((get_my_role() IS NOT NULL));
create policy staff_insert on public.housing_reno_budget as PERMISSIVE for INSERT to authenticated with check ((get_my_role() IS NOT NULL));
create policy staff_select on public.housing_reno_budget as PERMISSIVE for SELECT to authenticated using ((get_my_role() IS NOT NULL));
create policy staff_update on public.housing_reno_budget as PERMISSIVE for UPDATE to authenticated using ((get_my_role() IS NOT NULL)) with check ((get_my_role() IS NOT NULL));
create policy staff_delete on public.housing_reno_progress as PERMISSIVE for DELETE to authenticated using ((get_my_role() IS NOT NULL));
create policy staff_insert on public.housing_reno_progress as PERMISSIVE for INSERT to authenticated with check ((get_my_role() IS NOT NULL));
create policy staff_select on public.housing_reno_progress as PERMISSIVE for SELECT to authenticated using ((get_my_role() IS NOT NULL));
create policy staff_update on public.housing_reno_progress as PERMISSIVE for UPDATE to authenticated using ((get_my_role() IS NOT NULL)) with check ((get_my_role() IS NOT NULL));
create policy staff_delete on public.housing_rfq as PERMISSIVE for DELETE to authenticated using ((get_my_role() IS NOT NULL));
create policy staff_insert on public.housing_rfq as PERMISSIVE for INSERT to authenticated with check ((get_my_role() IS NOT NULL));
create policy staff_select on public.housing_rfq as PERMISSIVE for SELECT to authenticated using ((get_my_role() IS NOT NULL));
create policy staff_update on public.housing_rfq as PERMISSIVE for UPDATE to authenticated using ((get_my_role() IS NOT NULL)) with check ((get_my_role() IS NOT NULL));
create policy settings_no_delete on public.housing_settings as PERMISSIVE for DELETE to authenticated using (false);
create policy settings_select_housing on public.housing_settings as PERMISSIVE for SELECT to authenticated using (is_housing_role());
create policy settings_update_ed_only on public.housing_settings as PERMISSIVE for UPDATE to authenticated using ((get_my_role() = 'ed'::text)) with check ((get_my_role() = 'ed'::text));
create policy settings_write_ed_only on public.housing_settings as PERMISSIVE for INSERT to authenticated with check ((get_my_role() = 'ed'::text));
create policy staff_delete on public.housing_sow as PERMISSIVE for DELETE to authenticated using ((get_my_role() IS NOT NULL));
create policy staff_insert on public.housing_sow as PERMISSIVE for INSERT to authenticated with check ((get_my_role() IS NOT NULL));
create policy staff_select on public.housing_sow as PERMISSIVE for SELECT to authenticated using ((get_my_role() IS NOT NULL));
create policy staff_update on public.housing_sow as PERMISSIVE for UPDATE to authenticated using ((get_my_role() IS NOT NULL)) with check ((get_my_role() IS NOT NULL));
create policy staff_delete on public.housing_unit_photos as PERMISSIVE for DELETE to authenticated using ((get_my_role() IS NOT NULL));
create policy staff_insert on public.housing_unit_photos as PERMISSIVE for INSERT to authenticated with check ((get_my_role() IS NOT NULL));
create policy staff_select on public.housing_unit_photos as PERMISSIVE for SELECT to authenticated using ((get_my_role() IS NOT NULL));
create policy staff_update on public.housing_unit_photos as PERMISSIVE for UPDATE to authenticated using ((get_my_role() IS NOT NULL)) with check ((get_my_role() IS NOT NULL));
create policy staff_delete on public.housing_units as PERMISSIVE for DELETE to authenticated using ((get_my_role() IS NOT NULL));
create policy staff_insert on public.housing_units as PERMISSIVE for INSERT to authenticated with check ((get_my_role() IS NOT NULL));
create policy staff_select on public.housing_units as PERMISSIVE for SELECT to authenticated using ((get_my_role() IS NOT NULL));
create policy staff_update on public.housing_units as PERMISSIVE for UPDATE to authenticated using ((get_my_role() IS NOT NULL)) with check ((get_my_role() IS NOT NULL));
create policy staff_delete on public.inspections as PERMISSIVE for DELETE to authenticated using ((get_my_role() IS NOT NULL));
create policy staff_insert on public.inspections as PERMISSIVE for INSERT to authenticated with check ((get_my_role() IS NOT NULL));
create policy staff_select on public.inspections as PERMISSIVE for SELECT to authenticated using ((get_my_role() IS NOT NULL));
create policy staff_update on public.inspections as PERMISSIVE for UPDATE to authenticated using ((get_my_role() IS NOT NULL)) with check ((get_my_role() IS NOT NULL));
create policy staff_delete on public.rent_ledger as PERMISSIVE for DELETE to authenticated using (is_finance_role());
create policy staff_insert on public.rent_ledger as PERMISSIVE for INSERT to authenticated with check (is_finance_role());
create policy staff_select on public.rent_ledger as PERMISSIVE for SELECT to authenticated using (is_finance_role());
create policy staff_update on public.rent_ledger as PERMISSIVE for UPDATE to authenticated using (is_finance_role()) with check (is_finance_role());
create policy staff_insert_ed_only on public.staff as PERMISSIVE for INSERT to authenticated with check ((get_my_role() = 'ed'::text));
create policy staff_no_delete on public.staff as PERMISSIVE for DELETE to authenticated using (false);
create policy staff_select_authenticated on public.staff as PERMISSIVE for SELECT to authenticated using (((auth.uid() IS NOT NULL) AND (get_my_role() IS NOT NULL)));
create policy staff_update_ed_only on public.staff as PERMISSIVE for UPDATE to authenticated using ((get_my_role() = 'ed'::text)) with check ((get_my_role() = 'ed'::text));
create policy staff_insert on public.tenant_movement_log as PERMISSIVE for INSERT to authenticated with check ((get_my_role() IS NOT NULL));
create policy staff_select on public.tenant_movement_log as PERMISSIVE for SELECT to authenticated using ((get_my_role() IS NOT NULL));
create policy tenant_mr_staff_read on public.tenant_mr_submissions as PERMISSIVE for SELECT to public using ((EXISTS ( SELECT 1
   FROM staff s
  WHERE ((lower(s.email) = lower((auth.jwt() ->> 'email'::text))) AND s.is_active))));
create policy tenant_mr_staff_update on public.tenant_mr_submissions as PERMISSIVE for UPDATE to public using ((EXISTS ( SELECT 1
   FROM staff s
  WHERE ((lower(s.email) = lower((auth.jwt() ->> 'email'::text))) AND s.is_active))));
create policy staff_delete on public.tenant_notes as PERMISSIVE for DELETE to authenticated using ((get_my_role() IS NOT NULL));
create policy staff_insert on public.tenant_notes as PERMISSIVE for INSERT to authenticated with check ((get_my_role() IS NOT NULL));
create policy staff_select on public.tenant_notes as PERMISSIVE for SELECT to authenticated using ((get_my_role() IS NOT NULL));
create policy staff_update on public.tenant_notes as PERMISSIVE for UPDATE to authenticated using ((get_my_role() IS NOT NULL)) with check ((get_my_role() IS NOT NULL));
create policy staff_delete on public.tenants as PERMISSIVE for DELETE to authenticated using ((get_my_role() IS NOT NULL));
create policy staff_insert on public.tenants as PERMISSIVE for INSERT to authenticated with check ((get_my_role() IS NOT NULL));
create policy staff_select on public.tenants as PERMISSIVE for SELECT to authenticated using ((get_my_role() IS NOT NULL));
create policy staff_update on public.tenants as PERMISSIVE for UPDATE to authenticated using ((get_my_role() IS NOT NULL)) with check ((get_my_role() IS NOT NULL));
create policy unit_notes_insert_staff on public.unit_notes as PERMISSIVE for INSERT to public with check ((get_my_role() IS NOT NULL));
create policy unit_notes_select_staff on public.unit_notes as PERMISSIVE for SELECT to public using ((get_my_role() IS NOT NULL));
create policy "Allow authenticated uploads" on storage.objects as PERMISSIVE for INSERT to authenticated with check ((bucket_id = 'housing-files'::text));
create policy "authenticated_delete 58041z_0" on storage.objects as PERMISSIVE for DELETE to public using ((auth.role() = 'authenticated'::text));
create policy "authenticated_delete 58041z_1" on storage.objects as PERMISSIVE for SELECT to public using ((auth.role() = 'authenticated'::text));
create policy "authenticated_insert 58041z_0" on storage.objects as PERMISSIVE for INSERT to public with check ((auth.role() = 'authenticated'::text));
create policy "authenticated_read 58041z_0" on storage.objects as PERMISSIVE for SELECT to public using ((auth.role() = 'authenticated'::text));
create policy authenticated_update on storage.objects as PERMISSIVE for UPDATE to authenticated using ((auth.role() = 'authenticated'::text)) with check ((auth.role() = 'authenticated'::text));
create policy intake_owner_delete on storage.objects as PERMISSIVE for DELETE to authenticated using (((bucket_id = 'housing-files'::text) AND ((storage.foldername(name))[1] = 'application-intake'::text) AND ((storage.foldername(name))[2] = (auth.uid())::text)));
create policy intake_owner_insert on storage.objects as PERMISSIVE for INSERT to authenticated with check (((bucket_id = 'housing-files'::text) AND ((storage.foldername(name))[1] = 'application-intake'::text) AND ((storage.foldername(name))[2] = (auth.uid())::text)));
create policy intake_owner_select on storage.objects as PERMISSIVE for SELECT to authenticated using (((bucket_id = 'housing-files'::text) AND ((storage.foldername(name))[1] = 'application-intake'::text) AND ((storage.foldername(name))[2] = (auth.uid())::text)));
create policy intake_staff_select on storage.objects as PERMISSIVE for SELECT to authenticated using (((bucket_id = 'housing-files'::text) AND ((storage.foldername(name))[1] = 'application-intake'::text) AND (EXISTS ( SELECT 1
   FROM staff s
  WHERE ((lower(s.email) = lower((auth.jwt() ->> 'email'::text))) AND s.is_active)))));
-- ============ Grants ============
grant delete, insert, references, select, trigger, truncate, update on public.app_documents to anon;
grant delete, insert, references, select, trigger, truncate, update on public.app_documents to authenticated;
grant delete, insert, references, select, trigger, truncate, update on public.app_documents to service_role;
grant delete, insert, references, select, trigger, truncate, update on public.applicant_profiles to anon;
grant delete, insert, references, select, trigger, truncate, update on public.applicant_profiles to authenticated;
grant delete, insert, references, select, trigger, truncate, update on public.applicant_profiles to service_role;
grant delete, insert, references, select, trigger, truncate, update on public.application_submissions to anon;
grant delete, insert, references, select, trigger, truncate, update on public.application_submissions to authenticated;
grant delete, insert, references, select, trigger, truncate, update on public.application_submissions to service_role;
grant delete, insert, references, select, trigger, truncate, update on public.bcr_registry to anon;
grant delete, insert, references, select, trigger, truncate, update on public.bcr_registry to authenticated;
grant delete, insert, references, select, trigger, truncate, update on public.bcr_registry to service_role;
grant delete, insert, references, select, trigger, truncate, update on public.contractor_notes to anon;
grant delete, insert, references, select, trigger, truncate, update on public.contractor_notes to authenticated;
grant delete, insert, references, select, trigger, truncate, update on public.contractor_notes to service_role;
grant delete, insert, references, select, trigger, truncate, update on public.finance_arr_payments to anon;
grant delete, insert, references, select, trigger, truncate, update on public.finance_arr_payments to authenticated;
grant delete, insert, references, select, trigger, truncate, update on public.finance_arr_payments to service_role;
grant delete, insert, references, select, trigger, truncate, update on public.finance_arrangements to anon;
grant delete, insert, references, select, trigger, truncate, update on public.finance_arrangements to authenticated;
grant delete, insert, references, select, trigger, truncate, update on public.finance_arrangements to service_role;
grant insert, references, select, trigger, truncate on public.finance_audit_log to anon;
grant insert, references, select, trigger, truncate on public.finance_audit_log to authenticated;
grant delete, insert, references, select, trigger, truncate, update on public.finance_audit_log to service_role;
grant delete, insert, references, select, trigger, truncate, update on public.finance_collections to anon;
grant delete, insert, references, select, trigger, truncate, update on public.finance_collections to authenticated;
grant delete, insert, references, select, trigger, truncate, update on public.finance_collections to service_role;
grant delete, insert, references, select, trigger, truncate, update on public.finance_invoices to anon;
grant delete, insert, references, select, trigger, truncate, update on public.finance_invoices to authenticated;
grant delete, insert, references, select, trigger, truncate, update on public.finance_invoices to service_role;
grant delete, insert, references, select, trigger, truncate, update on public.finance_journal to anon;
grant delete, insert, references, select, trigger, truncate, update on public.finance_journal to authenticated;
grant delete, insert, references, select, trigger, truncate, update on public.finance_journal to service_role;
grant delete, insert, references, select, trigger, truncate, update on public.finance_loan_payments to anon;
grant delete, insert, references, select, trigger, truncate, update on public.finance_loan_payments to authenticated;
grant delete, insert, references, select, trigger, truncate, update on public.finance_loan_payments to service_role;
grant delete, insert, references, select, trigger, truncate, update on public.finance_loans to anon;
grant delete, insert, references, select, trigger, truncate, update on public.finance_loans to authenticated;
grant delete, insert, references, select, trigger, truncate, update on public.finance_loans to service_role;
grant delete, insert, references, select, trigger, truncate, update on public.finance_rent_ledger to anon;
grant delete, insert, references, select, trigger, truncate, update on public.finance_rent_ledger to authenticated;
grant delete, insert, references, select, trigger, truncate, update on public.finance_rent_ledger to service_role;
grant delete, insert, references, select, trigger, truncate, update on public.finance_utility_gas to anon;
grant delete, insert, references, select, trigger, truncate, update on public.finance_utility_gas to authenticated;
grant delete, insert, references, select, trigger, truncate, update on public.finance_utility_gas to service_role;
grant delete, insert, references, select, trigger, truncate, update on public.finance_utility_hydro to anon;
grant delete, insert, references, select, trigger, truncate, update on public.finance_utility_hydro to authenticated;
grant delete, insert, references, select, trigger, truncate, update on public.finance_utility_hydro to service_role;
grant delete, insert, references, select, trigger, truncate, update on public.housing_application_notes to anon;
grant delete, insert, references, select, trigger, truncate, update on public.housing_application_notes to authenticated;
grant delete, insert, references, select, trigger, truncate, update on public.housing_application_notes to service_role;
grant delete, insert, references, select, trigger, truncate, update on public.housing_applications to anon;
grant delete, insert, references, select, trigger, truncate, update on public.housing_applications to authenticated;
grant delete, insert, references, select, trigger, truncate, update on public.housing_applications to service_role;
grant insert, references, select, trigger, truncate on public.housing_audit_log to anon;
grant insert, references, select, trigger, truncate on public.housing_audit_log to authenticated;
grant delete, insert, references, select, trigger, truncate, update on public.housing_audit_log to service_role;
grant delete, insert, references, select, trigger, truncate, update on public.housing_contacts to anon;
grant delete, insert, references, select, trigger, truncate, update on public.housing_contacts to authenticated;
grant delete, insert, references, select, trigger, truncate, update on public.housing_contacts to service_role;
grant delete, insert, references, select, trigger, truncate, update on public.housing_contractors to anon;
grant delete, insert, references, select, trigger, truncate, update on public.housing_contractors to authenticated;
grant delete, insert, references, select, trigger, truncate, update on public.housing_contractors to service_role;
grant delete, insert, references, select, trigger, truncate, update on public.housing_project_lots to anon;
grant delete, insert, references, select, trigger, truncate, update on public.housing_project_lots to authenticated;
grant delete, insert, references, select, trigger, truncate, update on public.housing_project_lots to service_role;
grant delete, insert, references, select, trigger, truncate, update on public.housing_projects to anon;
grant delete, insert, references, select, trigger, truncate, update on public.housing_projects to authenticated;
grant delete, insert, references, select, trigger, truncate, update on public.housing_projects to service_role;
grant delete, insert, references, select, trigger, truncate, update on public.housing_reno_budget to anon;
grant delete, insert, references, select, trigger, truncate, update on public.housing_reno_budget to authenticated;
grant delete, insert, references, select, trigger, truncate, update on public.housing_reno_budget to service_role;
grant delete, insert, references, select, trigger, truncate, update on public.housing_reno_progress to anon;
grant delete, insert, references, select, trigger, truncate, update on public.housing_reno_progress to authenticated;
grant delete, insert, references, select, trigger, truncate, update on public.housing_reno_progress to service_role;
grant delete, insert, references, select, trigger, truncate, update on public.housing_rfq to anon;
grant delete, insert, references, select, trigger, truncate, update on public.housing_rfq to authenticated;
grant delete, insert, references, select, trigger, truncate, update on public.housing_rfq to service_role;
grant delete, insert, references, select, trigger, truncate, update on public.housing_settings to anon;
grant delete, insert, references, select, trigger, truncate, update on public.housing_settings to authenticated;
grant delete, insert, references, select, trigger, truncate, update on public.housing_settings to service_role;
grant delete, insert, references, select, trigger, truncate, update on public.housing_sow to anon;
grant delete, insert, references, select, trigger, truncate, update on public.housing_sow to authenticated;
grant delete, insert, references, select, trigger, truncate, update on public.housing_sow to service_role;
grant delete, insert, references, select, trigger, truncate, update on public.housing_unit_photos to anon;
grant delete, insert, references, select, trigger, truncate, update on public.housing_unit_photos to authenticated;
grant delete, insert, references, select, trigger, truncate, update on public.housing_unit_photos to service_role;
grant delete, insert, references, select, trigger, truncate, update on public.housing_units to anon;
grant delete, insert, references, select, trigger, truncate, update on public.housing_units to authenticated;
grant delete, insert, references, select, trigger, truncate, update on public.housing_units to service_role;
grant delete, insert, references, select, trigger, truncate, update on public.inspections to anon;
grant delete, insert, references, select, trigger, truncate, update on public.inspections to authenticated;
grant delete, insert, references, select, trigger, truncate, update on public.inspections to service_role;
grant delete, insert, references, select, trigger, truncate, update on public.magic_link_requests to anon;
grant delete, insert, references, select, trigger, truncate, update on public.magic_link_requests to authenticated;
grant delete, insert, references, select, trigger, truncate, update on public.magic_link_requests to service_role;
grant delete, insert, references, select, trigger, truncate, update on public.rent_ledger to anon;
grant delete, insert, references, select, trigger, truncate, update on public.rent_ledger to authenticated;
grant delete, insert, references, select, trigger, truncate, update on public.rent_ledger to service_role;
grant delete, insert, references, select, trigger, truncate, update on public.staff to anon;
grant delete, insert, references, select, trigger, truncate, update on public.staff to authenticated;
grant delete, insert, references, select, trigger, truncate, update on public.staff to service_role;
grant delete, insert, references, select, trigger, truncate, update on public.tenant_movement_log to anon;
grant delete, insert, references, select, trigger, truncate, update on public.tenant_movement_log to authenticated;
grant delete, insert, references, select, trigger, truncate, update on public.tenant_movement_log to service_role;
grant delete, insert, references, select, trigger, truncate, update on public.tenant_mr_submissions to anon;
grant delete, insert, references, select, trigger, truncate, update on public.tenant_mr_submissions to authenticated;
grant delete, insert, references, select, trigger, truncate, update on public.tenant_mr_submissions to service_role;
grant delete, insert, references, select, trigger, truncate, update on public.tenant_notes to anon;
grant delete, insert, references, select, trigger, truncate, update on public.tenant_notes to authenticated;
grant delete, insert, references, select, trigger, truncate, update on public.tenant_notes to service_role;
grant delete, insert, references, select, trigger, truncate, update on public.tenants to anon;
grant delete, insert, references, select, trigger, truncate, update on public.tenants to authenticated;
grant delete, insert, references, select, trigger, truncate, update on public.tenants to service_role;
grant delete, insert, references, select, trigger, truncate, update on public.unit_notes to anon;
grant delete, insert, references, select, trigger, truncate, update on public.unit_notes to authenticated;
grant delete, insert, references, select, trigger, truncate, update on public.unit_notes to service_role;
-- ============ Sequence ownership ============
alter sequence public.staff_id_seq owned by public.staff.id;

-- ============ Data & Storage usage RPC (Settings -> Nation) ============
-- Returns real byte sizes for the data-usage panel. Management-only; resolves
-- the caller's role directly from staff by JWT email (no RLS-helper dependency).
-- Kept in the bootstrap so every provisioned nation has it (matches the
-- standalone migration supabase/migrations/20260815_data_usage.sql).
create or replace function public.hs_data_usage()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  caller_email  text;
  caller_role   text;
  db_bytes      bigint;
  storage_bytes bigint;
  tables        jsonb;
begin
  caller_email := lower(coalesce(auth.jwt() ->> 'email', ''));
  select lower(coalesce(role, ''))
    into caller_role
    from public.staff
   where lower(email) = caller_email
     and coalesce(is_active, true) = true
   limit 1;

  if caller_role is null
     or caller_role not in ('ed','super_user','housing_manager','hm','manager') then
    raise exception 'not permitted';
  end if;

  select pg_database_size(current_database()) into db_bytes;

  select jsonb_agg(t) into tables from (
    select c.relname::text as "table",
           pg_total_relation_size(c.oid) as bytes
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r'
    order by pg_total_relation_size(c.oid) desc
    limit 15
  ) t;

  begin
    select coalesce(sum((metadata->>'size')::bigint), 0)
      into storage_bytes
    from storage.objects;
  exception when others then
    storage_bytes := null;
  end;

  return jsonb_build_object(
    'database_bytes', db_bytes,
    'storage_bytes',  storage_bytes,
    'tables',         coalesce(tables, '[]'::jsonb),
    'generated_at',   now()
  );
end;
$$;

grant execute on function public.hs_data_usage() to authenticated;
