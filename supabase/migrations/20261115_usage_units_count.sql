-- ============================================================================
-- hs_data_usage(): add units_count (homes on record) for dynamic billing.
--
-- The control plane's recurring invoicing can price the subscription band by
-- the nation's REAL home count instead of a hand-picked line item. This
-- extends the management-gated usage function with units_count (non-archived
-- housing_units rows); report-nation-usage carries it up to nation_usage
-- alongside the byte counts + AI tokens.
--
-- Fleet-wide + idempotent (create or replace). Run from the admin panel's
-- Fleet Migrations tab by exact filename: 20261115_usage_units_count.sql
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

  return jsonb_build_object(
    'database_bytes',   db_bytes,
    'storage_bytes',    storage_bytes,
    'tables',           coalesce(tables, '[]'::jsonb),
    'ai_input_tokens',  ai_in,
    'ai_output_tokens', ai_out,
    'units_count',      units_n,
    'generated_at',     now()
  );
end;
$$;

grant execute on function public.hs_data_usage() to authenticated;
