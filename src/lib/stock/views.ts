import { caseLabel } from "./engine";
import {
  HEALTH_LABELS,
  NOT_PLANNED_LABELS,
  explainSuggestion,
  isAtRisk,
  isPlanned,
  notPlannedReason,
  relativeDay,
  topSellerIds,
  type StockRow,
} from "./plan";

/**
 * The "Everything" grid: its views, its columns, how it sorts and what a row
 * looks like on screen and in the spreadsheet. Pure, and shared by the page
 * and the CSV download so the two always agree.
 */

export const VIEWS = [
  ["all", "All"],
  ["atrisk", "At-risk top sellers"],
  ["out", "Out of stock"],
  ["under", "Running low"],
  ["healthy", "Healthy"],
  ["over", "Too much"],
  ["nosales", "Dead stock"],
  ["onorder", "On its way"],
  ["nosupplier", "No supplier"],
  ["hidden", "Not reordering"],
] as const;
export type ViewKey = (typeof VIEWS)[number][0];
export const isViewKey = (value: unknown): value is ViewKey => VIEWS.some(([key]) => key === value);

export const VIEW_NOTES: Partial<Record<ViewKey, string>> = {
  atrisk: "Your best sellers (the top fifth by sales) that need ordering within a week.",
  nosales: "Nothing sold in 90 days, and there's still some on the shelf.",
  hidden:
    "Left out of suggestions and orders. Tick any you want back and press “Reorder these again”.",
};

/** The rows each view holds. "hidden" is everything left out; the rest are planned items only. */
export function viewRows(rows: StockRow[], today: string): Record<ViewKey, StockRow[]> {
  const planned = rows.filter(isPlanned);
  const top = topSellerIds(rows);
  const byHealth = (health: string) => planned.filter((row) => row.health.health === health);
  return {
    all: planned,
    atrisk: planned.filter((row) => isAtRisk(row, top, today)),
    out: byHealth("out"),
    under: byHealth("under"),
    healthy: byHealth("healthy"),
    over: byHealth("over"),
    nosales: byHealth("nosales"),
    onorder: planned.filter((row) => row.onOrder > 0),
    nosupplier: planned.filter((row) => !row.supplier),
    hidden: rows.filter((row) => !isPlanned(row)),
  };
}

export function searchRows(rows: StockRow[], q: string): StockRow[] {
  const needle = q.trim().toLowerCase();
  if (!needle) return rows;
  return rows.filter(
    (row) =>
      row.name.toLowerCase().includes(needle) ||
      (row.item.sku ?? "").toLowerCase().includes(needle) ||
      (row.item.supplier_sku ?? "").toLowerCase().includes(needle) ||
      (row.supplier?.name ?? "").toLowerCase().includes(needle),
  );
}

export const COLUMNS = [
  { key: "item", label: "Item", numeric: false, always: true },
  { key: "supplier", label: "Supplier", numeric: false },
  { key: "sold30", label: "Sold in 30 days", numeric: true },
  { key: "monthly", label: "Sells a month", numeric: true },
  { key: "cost", label: "Costs you", numeric: true },
  { key: "price", label: "Sells for", numeric: true },
  { key: "lead", label: "Days to arrive", numeric: true },
  { key: "minimum", label: "Smallest order", numeric: true },
  { key: "casePack", label: "Case", numeric: true },
  { key: "have", label: "Have", numeric: true },
  { key: "coming", label: "Coming", numeric: true },
  { key: "runsOut", label: "Runs out", numeric: false },
  { key: "orderBy", label: "Order by", numeric: false },
  { key: "suggest", label: "Suggest", numeric: true },
  { key: "health", label: "How it's doing", numeric: false },
] as const;
export type ColumnKey = (typeof COLUMNS)[number]["key"];
export const isColumnKey = (value: unknown): value is ColumnKey =>
  COLUMNS.some((column) => column.key === value);
/** Shown until the viewer chooses otherwise. */
export const DEFAULT_HIDDEN_COLUMNS: ColumnKey[] = ["price", "lead"];

const time = (date: Date | null) => (date ? date.getTime() : Number.POSITIVE_INFINITY);
const text = (a: string, b: string) => a.localeCompare(b, "en", { sensitivity: "base" });

const SORTERS: Record<ColumnKey, (a: StockRow, b: StockRow) => number> = {
  item: (a, b) => text(a.name, b.name),
  // Items with no supplier sort after the rest.
  supplier: (a, b) => text(a.supplier?.name ?? "￿", b.supplier?.name ?? "￿"),
  sold30: (a, b) => a.plan.sales30d - b.plan.sales30d,
  monthly: (a, b) => a.plan.velocityPerMonth - b.plan.velocityPerMonth,
  cost: (a, b) => a.unitCost - b.unitCost,
  price: (a, b) => (a.price ?? 0) - (b.price ?? 0),
  lead: (a, b) => a.leadTimeDays - b.leadTimeDays,
  minimum: (a, b) => a.minimum - b.minimum,
  casePack: (a, b) => (a.casePack ?? 0) - (b.casePack ?? 0),
  have: (a, b) => a.item.on_hand - b.item.on_hand,
  coming: (a, b) => a.onOrder - b.onOrder,
  runsOut: (a, b) => time(a.plan.stockOutDate) - time(b.plan.stockOutDate),
  orderBy: (a, b) => time(a.plan.reorderDate) - time(b.plan.reorderDate),
  suggest: (a, b) => a.suggestedQty - b.suggestedQty,
  health: (a, b) => text(HEALTH_LABELS[a.health.health], HEALTH_LABELS[b.health.health]),
};

export type SortDir = "asc" | "desc";
/** Soonest order-by date first, as TuftStock's Reorders table opens. */
export const DEFAULT_SORT: { key: ColumnKey; dir: SortDir } = { key: "orderBy", dir: "asc" };

/** A new array, sorted. Ties (and items with no date) fall back to the name. */
export function sortRows(rows: StockRow[], key: ColumnKey, dir: SortDir): StockRow[] {
  const by = SORTERS[key];
  const sign = dir === "desc" ? -1 : 1;
  return [...rows].sort((a, b) => {
    const result = by(a, b);
    // Items with no date stay at the bottom whichever way the dates run.
    if ((key === "runsOut" || key === "orderBy") && !Number.isFinite(result)) {
      return Number.isNaN(result) ? text(a.name, b.name) : result;
    }
    return sign * result || text(a.name, b.name);
  });
}

/** One row as the grid draws it: plain values, ready to cross to the browser. */
export type GridRow = {
  id: string;
  name: string;
  sku: string | null;
  supplier: string | null;
  sold30: number;
  monthly: string;
  cost: number | null;
  price: number | null;
  lead: number;
  minimum: number;
  casePack: number | null;
  have: number;
  coming: number;
  runsOut: string;
  orderBy: string;
  overdue: boolean;
  suggest: number;
  cases: string | null;
  health: keyof typeof HEALTH_LABELS;
  healthLabel: string;
  /** Why it's left out of reordering, when it is. */
  left: string | null;
  /** The person's own switch, which "Reorder these again" can undo. */
  hiddenByHand: boolean;
  why: string;
};

export function toGridRow(row: StockRow, today: string): GridRow {
  const reason = notPlannedReason(row);
  return {
    id: row.item.id,
    name: row.name,
    sku: row.item.sku,
    supplier: row.supplier?.name ?? null,
    sold30: row.plan.sales30d,
    monthly: row.plan.isDeadStock ? "–" : row.plan.velocityPerMonth.toFixed(1),
    cost: row.item.unit_cost == null ? null : row.unitCost,
    price: row.price,
    lead: row.leadTimeDays,
    minimum: row.minimum,
    casePack: row.casePack,
    have: row.item.on_hand,
    coming: row.onOrder,
    runsOut: relativeDay(row.plan.stockOutDate, today),
    orderBy: relativeDay(row.plan.reorderDate, today),
    overdue: row.plan.isOverdue,
    suggest: row.suggestedQty,
    cases: caseLabel(row.suggestedQty, row.casePack),
    health: row.health.health,
    healthLabel: HEALTH_LABELS[row.health.health],
    left: reason ? NOT_PLANNED_LABELS[reason] : null,
    hiddenByHand: row.item.hidden,
    why: explainSuggestion(row, today),
  };
}

const isoDay = (date: Date | null) =>
  date
    ? `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`
    : "";

/** The same columns for the spreadsheet: real dates and plain numbers. */
export const CSV_VALUES: Record<ColumnKey, (row: StockRow) => string | number> = {
  item: (row) => row.name,
  supplier: (row) => row.supplier?.name ?? "",
  sold30: (row) => row.plan.sales30d,
  monthly: (row) => row.plan.velocityPerMonth.toFixed(1),
  cost: (row) => (row.item.unit_cost == null ? "" : row.unitCost.toFixed(2)),
  price: (row) => (row.price == null ? "" : row.price.toFixed(2)),
  lead: (row) => row.leadTimeDays,
  minimum: (row) => row.minimum,
  casePack: (row) => row.casePack ?? "",
  have: (row) => row.item.on_hand,
  coming: (row) => row.onOrder,
  runsOut: (row) => isoDay(row.plan.stockOutDate),
  orderBy: (row) => isoDay(row.plan.reorderDate),
  suggest: (row) => row.suggestedQty,
  health: (row) => HEALTH_LABELS[row.health.health],
};

/** The header row and one row per item, for the columns asked for (in the grid's order). */
export function csvTable(rows: StockRow[], columns: ColumnKey[]): (string | number)[][] {
  const wanted = COLUMNS.filter((column) => column.key === "item" || columns.includes(column.key));
  const header = wanted.flatMap((column) =>
    column.key === "item" ? ["Item", "SKU", "Supplier's code"] : [column.label],
  );
  return [
    header,
    ...rows.map((row) =>
      wanted.flatMap((column) =>
        column.key === "item"
          ? [row.name, row.item.sku ?? "", row.item.supplier_sku ?? ""]
          : [CSV_VALUES[column.key](row)],
      ),
    ),
  ];
}
