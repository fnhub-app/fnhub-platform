-- ============================================================================
-- hs_data_usage(): add sms_lifetime_count (total texts ever sent) alongside the
-- existing sms_month_count (this calendar month), so the control plane can show
-- both a monthly and a lifetime text count on the per-nation dashboard. Counts
-- sms_log rows with status sent/delivered; exception-guarded (null = sms_log not
-- present, e.g. the SMS migration has not been run).
--
-- Full replacement (supersedes 20261116_usage_sms_count.sql). Fleet-wide +
-- idempotent. Run from the admin panel's Fleet Migrations tab by exact filename:
--   20261125_usage_sms_lifetime.sql
-- ============================================================================

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
  ai_in         bigint := 0;
  ai_out        bigint := 0;
  units_n       integer := null;
  sms_n         integer := null;
  sms_life      bigint  := null;
begin
  -- Gate: active management staff only (ED / super_user / Housing Manager).
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

  -- AI token usage this calendar month (UTC), summed from the audit log's
  -- detail JSON. Exception-guarded so a malformed row can never break usage.
  begin
    select coalesce(sum((j->>'input_tokens')::bigint), 0),
           coalesce(sum((j->>'output_tokens')::bigint), 0)
      into ai_in, ai_out
    from (
      select detail::jsonb as j
        from public.housing_audit_log
       where action in ('ai_query','ai_draft','support_chat')
         and created_at >= date_trunc('month', now())
         and detail is not null
         and left(btrim(detail), 1) = '{'
    ) q;
  exception when others then
    ai_in := 0; ai_out := 0;
  end;

  -- Homes on record: non-archived housing units. Drives the control plane's
  -- dynamic subscription banding. Exception-guarded (null = not reported).
  begin
    select count(*)::integer into units_n
      from public.housing_units
     where coalesce(archived, false) = false;
  exception when others then
    units_n := null;
  end;

  -- Texts sent this calendar month (UTC): billable sends only.
  begin
    select count(*)::integer into sms_n
      from public.sms_log
     where status in ('sent','delivered')
       and created_at >= date_trunc('month', now());
  exception when others then
    sms_n := null;
  end;

  -- Texts sent ALL TIME (lifetime): every successful send on record.
  begin
    select count(*)::bigint into sms_life
      from public.sms_log
     where status in ('sent','delivered');
  exception when others then
    sms_life := null;
  end;

  return jsonb_build_object(
    'database_bytes',     db_bytes,
    'storage_bytes',      storage_bytes,
    'tables',             coalesce(tables, '[]'::jsonb),
    'ai_input_tokens',    ai_in,
    'ai_output_tokens',   ai_out,
    'units_count',        units_n,
    'sms_month_count',    sms_n,
    'sms_lifetime_count', sms_life,
    'generated_at',       now()
  );
end;
$$;

grant execute on function public.hs_data_usage() to authenticated;
