import { COST_SOURCE_LABELS } from "./cost";
import { caseLabel } from "./engine";
import {
  HEALTH_LABELS,
  NOT_PLANNED_LABELS,
  explainSuggestion,
  isAtRisk,
  isDeadStock,
  isPlanned,
  notPlannedReason,
  peakMark,
  relativeDay,
  runsOutBeforeArrival,
  topSellerIds,
  type StockRow,
} from "./plan";

/**
 * The "Everything" grid: its views, its columns, how it sorts and what a row
 * looks like on screen and in the spreadsheet. Pure, and shared by the page
 * and the CSV download so the two always agree.
 */

// The first five are TuftStock's own, in its order and with its names; the
// rest sort the list by how each item is doing.
export const VIEWS = [
  ["all", "All"],
  ["onorder", "On Order"],
  ["nosales", "Dead Stock"],
  ["hidden", "Hidden"],
  ["atrisk", "At-risk Top Sellers"],
  ["out", "Out of stock"],
  ["under", "Running low"],
  ["healthy", "Healthy"],
  ["over", "Too much"],
  ["nosupplier", "No supplier"],
] as const;
export type ViewKey = (typeof VIEWS)[number][0];
export const isViewKey = (value: unknown): value is ViewKey => VIEWS.some(([key]) => key === value);
/** How many of the views are TuftStock's five; the others follow a divider. */
export const MAIN_VIEW_COUNT = 5;

export const VIEW_NOTES: Partial<Record<ViewKey, string>> = {
  atrisk:
    "Your best sellers (the top fifth by what they bring in) that need ordering within a week.",
  nosales: "Nothing sold in 90 days, and there's still some on the shelf.",
  hidden: "Left out of suggestions and orders. Press “Unhide” on any you want back.",
};

/** The rows each view holds. "hidden" is everything left out; the rest are planned items only. */
export function viewRows(rows: StockRow[], today: string): Record<ViewKey, StockRow[]> {
  const planned = rows.filter(isPlanned);
  const top = topSellerIds(rows);
  const byHealth = (health: string) => planned.filter((row) => row.health.health === health);
  return {
    all: planned,
    onorder: planned.filter((row) => row.onOrder > 0),
    nosales: planned.filter(isDeadStock),
    hidden: rows.filter((row) => !isPlanned(row)),
    atrisk: planned.filter((row) => isAtRisk(row, top, today)),
    out: byHealth("out"),
    under: byHealth("under"),
    healthy: byHealth("healthy"),
    over: byHealth("over"),
    nosupplier: planned.filter((row) => !row.supplier),
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

// The first seven are the reorder list as TuftStock shows it; the rest are
// there for the asking under "Columns".
export const COLUMNS = [
  { key: "item", label: "Product", numeric: false, always: true },
  { key: "sold30", label: "30D Sales", numeric: true },
  { key: "forecast", label: "30D Forecast", numeric: true },
  { key: "have", label: "Stock", numeric: false },
  { key: "runsOut", label: "Stock Out", numeric: false },
  { key: "orderBy", label: "Reorder", numeric: false },
  { key: "pctRev", label: "% Rev", numeric: true },
  { key: "suggest", label: "Suggest", numeric: true },
  { key: "supplier", label: "Supplier", numeric: false },
  { key: "monthly", label: "Sells a month", numeric: true },
  { key: "cost", label: "Costs you", numeric: true },
  { key: "price", label: "Sells for", numeric: true },
  { key: "lead", label: "Days to arrive", numeric: true },
  { key: "cover", label: "Order covers (days)", numeric: true },
  { key: "spare", label: "Keep spare", numeric: true },
  { key: "minimum", label: "Smallest order", numeric: true },
  { key: "casePack", label: "Case", numeric: true },
  { key: "coming", label: "Coming", numeric: true },
  { key: "health", label: "How it's doing", numeric: false },
] as const;
export type ColumnKey = (typeof COLUMNS)[number]["key"];
export const isColumnKey = (value: unknown): value is ColumnKey =>
  COLUMNS.some((column) => column.key === value);
/** Shown until the viewer chooses otherwise: the list as TuftStock opens it. */
export const DEFAULT_VISIBLE_COLUMNS: ColumnKey[] = [
  "item",
  "sold30",
  "forecast",
  "have",
  "runsOut",
  "orderBy",
  "pctRev",
];
export const DEFAULT_HIDDEN_COLUMNS: ColumnKey[] = COLUMNS.map((column) => column.key).filter(
  (key) => !DEFAULT_VISIBLE_COLUMNS.includes(key),
);
/** The figures a manager can change right in the table. */
export const EDITABLE_COLUMNS: ColumnKey[] = [
  "cost",
  "lead",
  "cover",
  "spare",
  "minimum",
  "casePack",
];

const time = (date: Date | null) => (date ? date.getTime() : Number.POSITIVE_INFINITY);
const text = (a: string, b: string) => a.localeCompare(b, "en", { sensitivity: "base" });

const SORTERS: Record<ColumnKey, (a: StockRow, b: StockRow) => number> = {
  item: (a, b) => text(a.name, b.name),
  // Items with no supplier sort after the rest.
  supplier: (a, b) => text(a.supplier?.name ?? "￿", b.supplier?.name ?? "￿"),
  sold30: (a, b) => a.plan.sales30d - b.plan.sales30d,
  forecast: (a, b) => a.plan.forecast30d - b.plan.forecast30d,
  pctRev: (a, b) => a.revenueShare - b.revenueShare,
  monthly: (a, b) => a.plan.velocityPerMonth - b.plan.velocityPerMonth,
  cost: (a, b) => a.unitCost - b.unitCost,
  price: (a, b) => (a.price ?? 0) - (b.price ?? 0),
  lead: (a, b) => a.leadTimeDays - b.leadTimeDays,
  cover: (a, b) => a.coverageDays - b.coverageDays,
  spare: (a, b) => a.item.safety_stock - b.item.safety_stock,
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
  /** Its place when the view is in its usual order (soonest reorder first). */
  rank: number | null;
  name: string;
  /** The product's name and this option's, for the two lines of the Product cell. */
  title: string;
  option: string | null;
  /** A small photo on the shop platform's own image servers, or null. */
  photo: string | null;
  sku: string | null;
  supplier: string | null;
  sold30: number;
  forecast: number;
  /** "2.2%": its share of what the shop took in over 90 days. */
  pctRev: string;
  /** Sent orders still owing some of it, and the oldest one's number. */
  comingOrders: number;
  comingOrder: number | null;
  /** The oldest of those orders' parcels in a few words, for the chip's tooltip. */
  comingNote: string | null;
  /** It will run out before a new order could arrive. */
  runsOutSoon: boolean;
  /** A supplier's closure moved the order-by date earlier: a few words, and the longer story. */
  closure: { label: string; why: string } | null;
  monthly: string;
  cost: number | null;
  /** Where the cost comes from, in words ("average of your deliveries"). */
  costFrom: string;
  price: number | null;
  lead: number;
  cover: number;
  spare: number;
  minimum: number;
  casePack: number | null;
  /**
   * The item's own figures, as they'd sit in a box ("" = none typed), for
   * changing them in the table. `lead`, `cover` and `minimum` above are what
   * is used once the supplier's figures have filled the gaps.
   */
  own: { cost: string; lead: string; cover: string; moq: string };
  have: number;
  coming: number;
  runsOut: string;
  orderBy: string;
  overdue: boolean;
  suggest: number;
  cases: string | null;
  /** "↑1.25×" beside the suggestion when it is being bought into a busy season. */
  peak: string | null;
  health: keyof typeof HEALTH_LABELS;
  healthLabel: string;
  /** Why it's left out of reordering, when it is. */
  left: string | null;
  /** The person's own switch, which "Reorder these again" can undo. */
  hiddenByHand: boolean;
  why: string;
};

export const shortDay = (day: string) =>
  new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", day: "numeric" }).format(
    new Date(`${day}T12:00:00Z`),
  );

/** What a closure did to a row's order-by date, in words. Null when it did nothing. */
export function closureNote(row: StockRow, today: string): GridRow["closure"] {
  const shut = row.closure;
  if (!shut) return null;
  const dates = `${shortDay(shut.startsOn)} to ${shortDay(shut.endsOn)}`;
  const who = row.supplier?.name ?? "The supplier";
  if (shut.underWay) {
    return {
      label: `Shut for ${shut.name}`,
      why: `${who} is shut for ${shut.name} (${dates}). An order placed now only gets going when they're back, so to arrive in time it was due ${relativeDay(row.plan.reorderDate, today)}.`,
    };
  }
  return {
    label: `Before ${shut.name}`,
    why: `${who} is shut for ${shut.name} (${dates}). To arrive before they shut, order ${relativeDay(row.plan.reorderDate, today)} rather than ${relativeDay(shut.movedFrom, today)}.`,
  };
}

export const percent = (share: number) => `${(share * 100).toFixed(1)}%`;

export function toGridRow(
  row: StockRow,
  today: string,
  extra: {
    rank?: number | null;
    photo?: string | null;
    /** Parcels in words, by order number (`loadOrderTracking`). */
    tracking?: Map<number, string[]>;
  } = {},
): GridRow {
  const reason = notPlannedReason(row);
  return {
    id: row.item.id,
    rank: extra.rank ?? null,
    name: row.name,
    title: row.item.title,
    option: row.item.variant_title,
    photo: extra.photo ?? null,
    sku: row.item.sku,
    supplier: row.supplier?.name ?? null,
    sold30: row.plan.sales30d,
    forecast: row.plan.forecast30d,
    pctRev: percent(row.revenueShare),
    comingOrders: row.openOrders.count,
    comingOrder: row.openOrders.firstNumber,
    comingNote:
      row.openOrders.firstNumber != null
        ? (extra.tracking?.get(row.openOrders.firstNumber)?.join("; ") ?? null)
        : null,
    runsOutSoon: runsOutBeforeArrival(row, today),
    closure: closureNote(row, today),
    monthly: row.plan.isDeadStock ? "–" : row.plan.velocityPerMonth.toFixed(1),
    cost: row.cost.source === "none" ? null : row.unitCost,
    costFrom: COST_SOURCE_LABELS[row.cost.source],
    price: row.price,
    lead: row.leadTimeDays,
    cover: row.coverageDays,
    spare: row.item.safety_stock,
    own: {
      cost: row.cost.own?.toFixed(2) ?? "",
      lead: row.item.lead_time_days == null ? "" : String(row.item.lead_time_days),
      cover: row.item.coverage_days == null ? "" : String(row.item.coverage_days),
      moq: row.item.moq == null ? "" : String(row.item.moq),
    },
    minimum: row.minimum,
    casePack: row.casePack,
    have: row.item.on_hand,
    coming: row.onOrder,
    runsOut: relativeDay(row.plan.stockOutDate, today),
    orderBy: relativeDay(row.plan.reorderDate, today),
    overdue: row.plan.isOverdue,
    suggest: row.suggestedQty,
    cases: caseLabel(row.suggestedQty, row.casePack),
    peak: row.suggestedQty > 0 ? peakMark(row) : null,
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
  forecast: (row) => row.plan.forecast30d,
  pctRev: (row) => (row.revenueShare * 100).toFixed(1),
  monthly: (row) => row.plan.velocityPerMonth.toFixed(1),
  cost: (row) => (row.cost.source === "none" ? "" : row.cost.cost.toFixed(2)),
  price: (row) => (row.price == null ? "" : row.price.toFixed(2)),
  lead: (row) => row.leadTimeDays,
  cover: (row) => row.coverageDays,
  spare: (row) => row.item.safety_stock,
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
    column.key === "item" ? ["Product", "SKU", "Supplier's code"] : [column.label],
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

/** Each row's place in the view's usual order (soonest reorder first), from 1. */
export function rankRows(rows: StockRow[]): Map<string, number> {
  return new Map(
    sortRows(rows, DEFAULT_SORT.key, DEFAULT_SORT.dir).map((row, index) => [
      row.item.id,
      index + 1,
    ]),
  );
}
