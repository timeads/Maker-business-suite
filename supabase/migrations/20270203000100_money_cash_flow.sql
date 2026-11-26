-- Money: QuickBooks' cash flow statement, kept by month beside the profit
-- and loss, for burn and runway.
--
-- The QuickBooks sync (read-only, the accounting scope already granted) now
-- also reads the CashFlow report summarised by month and saves one
-- `cash_flow` snapshot per month through the same service-role function as
-- the other reports (`save_financial_snapshots`, keyed by workspace,
-- provider, kind and month, so reading again replaces in place). Amounts are
-- whole cents. A worker still on earlier code never sends this kind and
-- keeps working; a newer worker against a database without this migration
-- has its cash flow refused and carries on with the rest of the sync.
--
-- The monthly profit and loss now reaches back to the first of January three
-- years before this one, and carries other income and other expenses in
-- cents. That needs no schema change: the snapshot's `data` is already a
-- document, and a month an earlier sync stored simply lacks the new figures.

alter table public.financial_snapshots
  drop constraint financial_snapshots_kind_check;
alter table public.financial_snapshots
  add constraint financial_snapshots_kind_check
  check (kind in ('profit_and_loss', 'balance_sheet', 'ar_aging', 'cash_flow'));

-- Reading a month's report again, or a later one, never piles rows up: the
-- monthly kinds are one row per month, and the as-of kinds one row per day.
-- The money view reads the monthly kinds by month and only the latest as-of
-- row of each other kind, so this index serves both.
create index if not exists financial_snapshots_kind_period_idx
  on public.financial_snapshots (tenant_id, kind, period_start desc);
