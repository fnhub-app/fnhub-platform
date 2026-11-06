-- ============================================================================
-- Finance payment + collection notes columns.
--
-- Run in each nation's Supabase SQL Editor BEFORE the matching app deploy (the
-- mappers now write these columns, so the column must exist first or the
-- loan/arrangement payment + collection saves would 400). Safe to re-run.
--
-- Why:
--  * Loan-payment and arrangement-payment NOTES were silently dropped on every
--    reload -- the *_ToRow mappers wrote no `notes` field and the *_FromRow
--    mappers hardcoded `notes: ''`, and the tables had no `notes` column. Staff
--    typed a note (e.g. "cheque #1234", "partial - balance next month"); it
--    showed in-memory, then vanished on the next load.
--  * Collections packed the agency as a synthetic "Agency: <value>" first line
--    inside `notes` (no agency column), so a user note that literally started
--    with "Agency: " was consumed as the agency value and disappeared.
-- ============================================================================

alter table public.finance_loan_payments add column if not exists notes text;
alter table public.finance_arr_payments  add column if not exists notes text;
alter table public.finance_collections   add column if not exists agency text;

-- Backfill: move the legacy packed agency (the first "Agency: <value>" line) out
-- of `notes` and into the new `agency` column for existing collection rows, so
-- the app can stop stripping that prefix on read.
update public.finance_collections
   set agency = regexp_replace(split_part(notes, E'\n', 1), '^Agency: ', ''),
       notes  = nullif(regexp_replace(notes, E'^Agency: [^\n]*\n?', ''), '')
 where agency is null
   and notes like 'Agency: %';
