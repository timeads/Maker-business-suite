import { toCents } from "../../dashboard/lines";
import type { SnapshotRow } from "../types";

/**
 * QuickBooks reports come back as a tree of rows and columns built for
 * display. These helpers pull out the handful of numbers the money view
 * needs. Anything they can't find is left out rather than guessed.
 */

type ColData = { value?: string };
type ReportRow = {
  group?: string;
  type?: string;
  ColData?: ColData[];
  Header?: { ColData?: ColData[] };
  Summary?: { ColData?: ColData[] };
  Rows?: { Row?: ReportRow[] };
};
type ReportColumn = {
  ColTitle?: string;
  ColType?: string;
  MetaData?: { Name?: string; Value?: string }[];
};
export type QuickBooksReport = {
  Header?: { Currency?: string; StartPeriod?: string; EndPeriod?: string };
  Columns?: { Column?: ReportColumn[] };
  Rows?: { Row?: ReportRow[] };
};

const number = (value: string | undefined): number => {
  const parsed = Number((value ?? "").replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
};

/** A report's amount in whole cents, read from its text so nothing is lost to rounding. */
const cents = (value: string | undefined): number => toCents((value ?? "").replace(/,/g, ""));

/** Depth-first search for the section with this `group`. */
function findGroup(rows: ReportRow[] | undefined, group: string): ReportRow | null {
  for (const row of rows ?? []) {
    if (row.group === group) return row;
    const nested = findGroup(row.Rows?.Row, group);
    if (nested) return nested;
  }
  return null;
}

const summary = (row: ReportRow | null): ColData[] => row?.Summary?.ColData ?? row?.ColData ?? [];

const meta = (column: ReportColumn, name: string) =>
  column.MetaData?.find((m) => m.Name === name)?.Value;

/** One snapshot per month from a ProfitAndLoss report summarised by month. */
export function parseProfitAndLoss(report: QuickBooksReport): SnapshotRow[] {
  const columns = report.Columns?.Column ?? [];
  const rows = report.Rows?.Row;
  const groups = {
    income: summary(findGroup(rows, "Income")),
    cogs: summary(findGroup(rows, "COGS")),
    gross_profit: summary(findGroup(rows, "GrossProfit")),
    expenses: summary(findGroup(rows, "Expenses")),
    net_income: summary(findGroup(rows, "NetIncome")),
    // Below the operating line: one-off income and gains, and their like.
    other_income: summary(findGroup(rows, "OtherIncome")),
    other_expenses: summary(findGroup(rows, "OtherExpenses") ?? findGroup(rows, "OtherExpense")),
  };
  /** A section's amount in cents, or null when the books have no such section. */
  const optional = (cells: ColData[], index: number) =>
    cells.length > 0 ? cents(cells[index]?.value) : null;

  const snapshots: SnapshotRow[] = [];
  columns.forEach((column, index) => {
    const start = meta(column, "StartDate");
    const end = meta(column, "EndDate");
    // Only real month columns: skips the label column and the grand total.
    if (!start || !end || start.slice(0, 7) !== end.slice(0, 7)) return;
    const income = number(groups.income[index]?.value);
    const cogs = number(groups.cogs[index]?.value);
    snapshots.push({
      kind: "profit_and_loss",
      period_start: `${start.slice(0, 7)}-01`,
      period_end: end,
      data: {
        income,
        cogs,
        // Some books have no cost-of-goods section, and so no gross profit row.
        gross_profit:
          groups.gross_profit.length > 0
            ? number(groups.gross_profit[index]?.value)
            : income - cogs,
        expenses: number(groups.expenses[index]?.value),
        net_income: number(groups.net_income[index]?.value),
        // Added later, in whole cents. Missing from months an earlier sync
        // stored; readers treat a missing figure as "not known", never 0.
        other_income_cents: optional(groups.other_income, index) ?? 0,
        other_expenses_cents: optional(groups.other_expenses, index) ?? 0,
        currency: report.Header?.Currency ?? null,
      },
    });
  });
  return snapshots;
}

/**
 * Where cash came from and went, one snapshot per month, from a CashFlow
 * report summarised by month: running the business (operating), buying and
 * selling equipment (investing), loans and owner's money (financing), and
 * the net change. Whole cents. A month with no operating section is left out
 * rather than read as zero.
 */
export function parseCashFlow(report: QuickBooksReport): SnapshotRow[] {
  const columns = report.Columns?.Column ?? [];
  const rows = report.Rows?.Row;
  const operating = summary(findGroup(rows, "OperatingActivities"));
  const investing = summary(findGroup(rows, "InvestingActivities"));
  const financing = summary(findGroup(rows, "FinancingActivities"));
  const change = summary(findGroup(rows, "CashIncrease"));
  const ending = summary(findGroup(rows, "EndingCash"));
  if (operating.length === 0) return [];

  const snapshots: SnapshotRow[] = [];
  columns.forEach((column, index) => {
    const start = meta(column, "StartDate");
    const end = meta(column, "EndDate");
    if (!start || !end || start.slice(0, 7) !== end.slice(0, 7)) return;
    const operatingCents = cents(operating[index]?.value);
    const investingCents = investing.length > 0 ? cents(investing[index]?.value) : 0;
    const financingCents = financing.length > 0 ? cents(financing[index]?.value) : 0;
    snapshots.push({
      kind: "cash_flow",
      period_start: `${start.slice(0, 7)}-01`,
      period_end: end,
      data: {
        operating_cents: operatingCents,
        investing_cents: investingCents,
        financing_cents: financingCents,
        // The report's own figure where it gives one; else the three added up.
        net_change_cents:
          change.length > 0
            ? cents(change[index]?.value)
            : operatingCents + investingCents + financingCents,
        ending_cash_cents: ending.length > 0 ? cents(ending[index]?.value) : null,
        currency: report.Header?.Currency ?? null,
      },
    });
  });
  return snapshots;
}

/** Cash in the bank and what customers owe, from a BalanceSheet report. */
export function parseBalanceSheet(report: QuickBooksReport, asOf: string): SnapshotRow | null {
  const rows = report.Rows?.Row;
  const bank = findGroup(rows, "BankAccounts");
  if (!bank) return null;
  const last = (row: ReportRow | null) => {
    const cells = summary(row);
    return cells.length > 1 ? number(cells[cells.length - 1]?.value) : null;
  };
  // Each bank account's own line, for "where this number came from".
  const accounts: { name: string; cents: number }[] = [];
  const collect = (list: ReportRow[] | undefined) => {
    for (const row of list ?? []) {
      const cells = row.ColData ?? [];
      const name = (cells[0]?.value ?? "").trim();
      if (row.type === "Data" && name && cells.length > 1 && accounts.length < 50) {
        accounts.push({ name: name.slice(0, 120), cents: cents(cells[cells.length - 1]?.value) });
      }
      collect(row.Rows?.Row);
    }
  };
  collect(bank.Rows?.Row);
  return {
    kind: "balance_sheet",
    period_start: asOf,
    period_end: asOf,
    data: {
      cash: last(bank) ?? 0,
      bank_accounts: accounts,
      receivables: last(findGroup(rows, "AR")),
      total_assets: last(findGroup(rows, "TotalAssets")),
      currency: report.Header?.Currency ?? null,
    },
  };
}

/**
 * Each liability account's own line from a BalanceSheet report (cards,
 * loans, lines of credit), for Money's debts. Never stored as it is: the
 * database keeps a balance only for a debt an owner or admin linked to an
 * account of that name, so nobody else can read what is owed.
 */
export function parseLiabilityAccounts(
  report: QuickBooksReport,
): { name: string; cents: number }[] {
  const liabilities = findGroup(report.Rows?.Row, "Liabilities");
  if (!liabilities) return [];
  const out: { name: string; cents: number }[] = [];
  const collect = (list: ReportRow[] | undefined) => {
    for (const row of list ?? []) {
      const cells = row.ColData ?? [];
      const name = (cells[0]?.value ?? "").trim();
      if (row.type === "Data" && name && cells.length > 1 && out.length < 500) {
        out.push({ name: name.slice(0, 200), cents: cents(cells[cells.length - 1]?.value) });
      }
      collect(row.Rows?.Row);
    }
  };
  collect(liabilities.Rows?.Row);
  return out;
}

/** What customers owe, by how overdue it is, from an AgedReceivables report. */
export function parseAgedReceivables(report: QuickBooksReport, asOf: string): SnapshotRow | null {
  const columns = report.Columns?.Column ?? [];
  const totals = summary(findGroup(report.Rows?.Row, "GrandTotal"));
  if (totals.length === 0) return null;

  const buckets: { label: string; amount: number }[] = [];
  let total = 0;
  columns.forEach((column, index) => {
    const title = (column.ColTitle ?? "").trim();
    if (index === 0 || !title) return;
    const amount = number(totals[index]?.value);
    if (/^total$/i.test(title)) total = amount;
    else buckets.push({ label: title, amount });
  });
  if (buckets.length === 0) return null;
  return {
    kind: "ar_aging",
    period_start: asOf,
    period_end: asOf,
    data: {
      buckets,
      total: total || buckets.reduce((sum, bucket) => sum + bucket.amount, 0),
      currency: report.Header?.Currency ?? null,
    },
  };
}
