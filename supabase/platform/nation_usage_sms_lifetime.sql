-- Control-plane: lifetime text count per nation.
-- report-nation-usage pushes sms_lifetime_count (total texts ever sent, from the
-- nation's hs_data_usage()) so the admin per-nation dashboard can show a monthly
-- AND a lifetime text count. Run once on the fnhub-platform project SQL Editor.

alter table public.nation_usage
  add column if not exists sms_lifetime_count bigint;
