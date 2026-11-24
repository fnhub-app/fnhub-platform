-- ============================================================================
-- hs_data_usage(): add sms_breakdown -- an aggregate of sms_log grouped by
-- event + delivery status (sent / delivered / failed / skipped_optout), all
-- time. Lets the control plane show WHICH notification events are texting and
-- whether any are failing, so a low text count can be explained (most
-- maintenance-request activity is email/in-app, not SMS; failed/opt-out sends
-- never count toward billed totals). Aggregate counts only -- no numbers, no
-- recipients, no PII. Exception-guarded (null = sms_log not present).
--
-- Full replacement (supersedes 20261125_usage_sms_lifetime.sql). Fleet-wide +
-- idempotent. Run from the admin panel's Fleet Migrations tab by exact filename:
--   20261126_usage_sms_breakdown.sql
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
  sms_bd        jsonb   := null;
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

  -- SMS activity breakdown (all time): one entry per (event, status) with a
  -- count. Small by construction (events x statuses). Aggregate only -- no
  -- phone numbers or message bodies leave the nation.
  begin
    select coalesce(
             jsonb_agg(
               jsonb_build_object('event', ev, 'status', st, 'count', n)
               order by ev, st
             ),
             '[]'::jsonb)
      into sms_bd
    from (
      select coalesce(nullif(btrim(event), ''), '(none)') as ev,
             coalesce(nullif(btrim(status), ''), '(none)') as st,
             count(*)::bigint as n
        from public.sms_log
       group by 1, 2
    ) q;
  exception when others then
    sms_bd := null;
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
    'sms_breakdown',      sms_bd,
    'generated_at',       now()
  );
end;
$$;

grant execute on function public.hs_data_usage() to authenticated;
