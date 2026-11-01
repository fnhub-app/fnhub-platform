-- ============================================================================
-- supabase/demo/demo-config.sql
--
-- Per-nation configuration for the DEMO nation. Run in the DEMO project's SQL
-- Editor AFTER bootstrap/schema.sql and seed.sql. Never run against CLFN.
--
-- If the editor shows "Potential issue detected ... Row Level Security",
-- choose "Run without RLS" -- this alters defaults and seeds settings rows; it
-- creates no tables.
--
-- 1) Repoint the nation_id defaults. schema.sql carries CLFN's default of
--    'clfn' on every table that has the column. Nothing reads nation_id
--    (database-per-nation makes it redundant), but the finance client writes it
--    explicitly from NATION_CONFIG.id, so leaving the default would mix 'demo'
--    finance rows with 'clfn' housing rows in the same database.
-- ============================================================================
alter table public.app_documents alter column nation_id set default 'demo';
alter table public.finance_arr_payments alter column nation_id set default 'demo';
alter table public.finance_arrangements alter column nation_id set default 'demo';
alter table public.finance_audit_log alter column nation_id set default 'demo';
alter table public.finance_collections alter column nation_id set default 'demo';
alter table public.finance_invoices alter column nation_id set default 'demo';
alter table public.finance_journal alter column nation_id set default 'demo';
alter table public.finance_loan_payments alter column nation_id set default 'demo';
alter table public.finance_loans alter column nation_id set default 'demo';
alter table public.finance_rent_ledger alter column nation_id set default 'demo';
alter table public.finance_utility_gas alter column nation_id set default 'demo';
alter table public.finance_utility_hydro alter column nation_id set default 'demo';
alter table public.housing_applications alter column nation_id set default 'demo';
alter table public.housing_audit_log alter column nation_id set default 'demo';
alter table public.housing_contacts alter column nation_id set default 'demo';
alter table public.housing_contractors alter column nation_id set default 'demo';
alter table public.housing_reno_budget alter column nation_id set default 'demo';
alter table public.housing_reno_progress alter column nation_id set default 'demo';
alter table public.housing_settings alter column nation_id set default 'demo';
alter table public.housing_sow alter column nation_id set default 'demo';
alter table public.housing_unit_photos alter column nation_id set default 'demo';
alter table public.housing_units alter column nation_id set default 'demo';
alter table public.staff alter column nation_id set default 'demo';
alter table public.tenants alter column nation_id set default 'demo';

-- ============================================================================
-- 2) Nation identity + theme, so the header, generated PDFs, leases and email
--    shells carry demo branding before anyone opens Settings.
--    Keys match applyNationOverrides() and _applyTheme().
-- ============================================================================
insert into housing_settings (key, value) values (
  'nation_config_override',
  '{"display_name":"Demo First Nation","name":"Demo First Nation","short":"DEMO",
    "email":"housing@demo.fnhub.app","housing_email":"housing@demo.fnhub.app",
    "phone":"(000) 555-0100","website":"https://demo.fnhub.app",
    "mailing_address":"P.O. Box 100\nDemo, ON  A0A 0A0","province":"Ontario"}'::jsonb
) on conflict (key) do update set value = excluded.value;

insert into housing_settings (key, value) values (
  'theme', '{"primary_color":"#4FC3F7"}'::jsonb
) on conflict (key) do update set value = excluded.value;

-- 3) Turn the demonstrable modules ON in-app. Licensing is set in the registry;
--    this is the separate per-nation _enabled state (CLFN_MODULES).
--    sms_notifications + contractor_portal are pinned OFF deliberately: the code
--    default for sms_notifications is TRUE, and applySavedModuleState only
--    overrides keys that are PRESENT here -- so without the explicit false below
--    the demo would silently have SMS ON. There is no is_demo client guard yet
--    (D3 unbuilt), so a live demo with SMS on + Twilio secrets could text a real
--    phone. Keep both off until the is_demo sendSms suppression lands.
insert into housing_settings (key, value) values (
  'module_enablement',
  '{"_enabled":{"finance":true,"match":true,"contractors":true,"renovations":true,
     "rfq":true,"mapping":true,"ai_assistant":true,"inspections":true,"projects":true,
     "email_intake":false,"sms_notifications":false,"contractor_portal":false}}'::jsonb
) on conflict (key) do update set value = excluded.value;
