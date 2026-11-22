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
  };

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
  return {
    kind: "balance_sheet",
    period_start: asOf,
    period_end: asOf,
    data: {
      cash: last(bank) ?? 0,
      receivables: last(findGroup(rows, "AR")),
      total_assets: last(findGroup(rows, "TotalAssets")),
      currency: report.Header?.Currency ?? null,
    },
  };
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
