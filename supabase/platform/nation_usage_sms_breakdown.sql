-- Control-plane: per-event SMS activity breakdown per nation.
-- report-nation-usage pushes sms_breakdown (an aggregate of the nation's
-- sms_log grouped by event + delivery status, from hs_data_usage()) so the
-- admin SMS tab can show which notification events are texting and whether any
-- are failing. Aggregate counts only -- no numbers, no message text, no PII.
-- Run once on the fnhub-platform project SQL Editor.

alter table public.nation_usage
  add column if not exists sms_breakdown jsonb;
