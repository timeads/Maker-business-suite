import type { StockSettings } from "./config";
import {
  caseLabel,
  casePackOf,
  classifyStockHealth,
  computeDraftPo,
  computeOnOrder,
  computeReorder,
  type DailySale,
  type ReorderResult,
  roundUpToCase,
  type StockHealthResult,
} from "./engine";
import { addDays } from "./engine/days";
import { blendIndex, monthlyIndex } from "./engine/seasonality";
import { computePoTotals } from "./po/totals";

/**
 * Turns the rows in the database into what the Stock screens show. Nothing
 * here is stored: every figure is worked out from sales, stock and orders
 * each time, by the engine in ./engine.
 */

export type ItemRow = {
  id: string;
  title: string;
  variant_title: string | null;
  sku: string | null;
  on_hand: number;
  unit_cost: number | string | null;
  tracked: boolean;
  product_status: string | null;
  supplier_id: string | null;
  lead_time_days: number | null;
  coverage_days: number | null;
  safety_stock: number;
  hidden: boolean;
  /** Who the shop says it comes from, and what it sells for there. */
  vendor?: string | null;
  price?: number | string | null;
  /** Units to a case; this item's own smallest order; the supplier's code for it. */
  case_pack?: number | null;
  moq?: number | null;
  supplier_sku?: string | null;
};
export type SupplierRow = {
  id: string;
  name: string;
  lead_time_days: number;
  coverage_days: number;
  moq: number;
  moq_applies_to: "order" | "sku";
  archived_at?: string | null;
};
export type SaleRow = { stock_item_id: string; day: string; units: number | string };
export type OpenLine = {
  stock_item_id: string;
  qty_ordered: number;
  qty_received: number;
  status: string;
};

export type StockRow = {
  item: ItemRow;
  name: string;
  supplier: SupplierRow | null;
  leadTimeDays: number;
  coverageDays: number;
  onOrder: number;
  unitCost: number;
  price: number | null;
  /** Units to a case, when it is bought by the case. */
  casePack: number | null;
  /** The smallest amount of this one item an order can carry (1 = no minimum). */
  minimum: number;
  /** The engine's own figures. `plan.suggestedQty` is before case rounding. */
  plan: ReorderResult;
  /** What to order: the engine's figure, raised to whole cases. */
  suggestedQty: number;
  health: StockHealthResult;
  /** Reorder date is within two weeks (or past) and there is something to order. */
  due: boolean;
  /** A rule in Settings ("gift card"...) keeps this one out of planning. */
  skippedByRule: boolean;
};

/** True when the item's name carries one of the workspace's "never reorder" words. */
export function matchesSkipWords(
  item: Pick<ItemRow, "title" | "variant_title">,
  words: readonly string[],
): boolean {
  if (words.length === 0) return false;
  const name = `${item.title} ${item.variant_title ?? ""}`.toLowerCase();
  return words.some((word) => {
    const w = word.trim().toLowerCase();
    return w.length >= 2 && name.includes(w);
  });
}

/** "Wool rug · Large", or just the title when there is one option. */
export const itemName = (item: Pick<ItemRow, "title" | "variant_title">) =>
  item.variant_title ? `${item.title} · ${item.variant_title}` : item.title;

/** A YYYY-MM-DD day as a date at local midnight, the way the engine counts days. */
export const dayToDate = (day: string) => {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(y, m - 1, d);
};

const DUE_WITHIN_DAYS = 14;

export function buildStockRows(input: {
  items: ItemRow[];
  suppliers: SupplierRow[];
  sales: SaleRow[];
  openLines: OpenLine[];
  settings: StockSettings;
  /** The workspace's own "today", YYYY-MM-DD. */
  today: string;
}): StockRow[] {
  const today = dayToDate(input.today);
  const suppliers = new Map(input.suppliers.map((s) => [s.id, s]));
  const salesByItem = new Map<string, DailySale[]>();
  const everything: DailySale[] = [];
  for (const sale of input.sales) {
    const row = { date: dayToDate(sale.day), unitsSold: Number(sale.units) };
    everything.push(row);
    const list = salesByItem.get(sale.stock_item_id);
    if (list) list.push(row);
    else salesByItem.set(sale.stock_item_id, [row]);
  }
  const linesByItem = new Map<string, OpenLine[]>();
  for (const line of input.openLines) {
    const list = linesByItem.get(line.stock_item_id);
    if (list) list.push(line);
    else linesByItem.set(line.stock_item_id, [line]);
  }
  // The engine reads months in UTC; shift local-midnight dates so the month is right.
  const forIndex = (rows: DailySale[]) =>
    rows.map((r) => {
      const d = r.date as Date;
      return {
        date: new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())),
        unitsSold: r.unitsSold,
      };
    });
  const storeIndex = input.settings.seasonality ? monthlyIndex(forIndex(everything)) : null;

  return input.items.map((item) => {
    const supplier = item.supplier_id ? (suppliers.get(item.supplier_id) ?? null) : null;
    const leadTimeDays =
      item.lead_time_days ?? supplier?.lead_time_days ?? input.settings.default_lead_time_days;
    const coverageDays =
      item.coverage_days ?? supplier?.coverage_days ?? input.settings.default_coverage_days;
    const sales = salesByItem.get(item.id) ?? [];
    const onOrder = computeOnOrder(
      (linesByItem.get(item.id) ?? []).map((line) => ({
        status: line.status.toUpperCase(),
        qtyOrdered: line.qty_ordered,
        qtyReceived: line.qty_received,
      })),
    );
    const units = sales.reduce((n, s) => n + s.unitsSold, 0);
    const seasonalIndex = storeIndex
      ? blendIndex(monthlyIndex(forIndex(sales)), storeIndex, units)
      : undefined;
    // The item's own smallest order wins over the supplier's, and is always
    // counted per item. A supplier's minimum counted across the whole order is
    // applied when the order is drafted (draft-po.ts), not here.
    const perItem = item.moq != null || supplier?.moq_applies_to === "sku";
    const moq = item.moq ?? supplier?.moq ?? 1;
    const casePack = casePackOf(item.case_pack);
    const plan = computeReorder({
      salesByDay: sales,
      stockOnHand: item.on_hand,
      onOrder,
      effectiveLeadTimeDays: leadTimeDays,
      effectiveCoverageDays: coverageDays,
      safetyStockUnits: item.safety_stock,
      moq,
      moqAppliesTo: perItem ? "SKU" : "ORDER",
      reviewBufferDays: input.settings.review_buffer_days,
      today,
      seasonalIndex,
    });
    const health = classifyStockHealth({
      stockOnHand: item.on_hand,
      onOrder,
      unitsPerDay: plan.unitsPerDay,
      isDeadStock: plan.isDeadStock,
      effectiveLeadTimeDays: leadTimeDays,
      effectiveCoverageDays: coverageDays,
      reviewBufferDays: input.settings.review_buffer_days,
    });
    const due =
      plan.suggestedQty > 0 &&
      plan.reorderDate !== null &&
      plan.reorderDate.getTime() <= addDays(today, DUE_WITHIN_DAYS).getTime();
    return {
      item,
      name: itemName(item),
      supplier,
      leadTimeDays,
      coverageDays,
      onOrder,
      unitCost: Number(item.unit_cost ?? 0) || 0,
      price: item.price == null ? null : Number(item.price) || 0,
      casePack,
      minimum: perItem ? moq : 1,
      plan,
      suggestedQty: roundUpToCase(plan.suggestedQty, casePack),
      health,
      due,
      skippedByRule: matchesSkipWords(item, input.settings.skip_words),
    };
  });
}

/**
 * Why an item is left out of suggestions and orders, or null when it is planned for.
 * "hidden" is the person's own "Don't reorder" switch; "rule" is the name rule in
 * Settings; the last two come from the shop.
 */
export type NotPlannedReason = "hidden" | "rule" | "untracked" | "archived";
export function notPlannedReason(row: StockRow): NotPlannedReason | null {
  if (row.item.hidden) return "hidden";
  if (row.skippedByRule) return "rule";
  if (!row.item.tracked) return "untracked";
  if (row.item.product_status === "ARCHIVED") return "archived";
  return null;
}
export const NOT_PLANNED_LABELS: Record<NotPlannedReason, string> = {
  hidden: "You said don't reorder",
  rule: "Matches a rule in Settings",
  untracked: "Your shop doesn't count it",
  archived: "Archived in your shop",
};

/** Items worth planning for: counted by the shop, still on sale, not switched off. */
export const isPlanned = (row: StockRow) => notPlannedReason(row) === null;

export type DraftLine = {
  stock_item_id: string;
  name: string;
  qty: number;
  unit_cost: number;
  supplier_sku: string | null;
  /** "2 cases of 36", when the item is bought by the case. */
  cases: string | null;
};
export type DraftOrder = {
  supplier: SupplierRow;
  lines: DraftLine[];
  totalUnits: number;
  totalCost: number;
  expectedOn: string;
  bumpedToMinimum: boolean;
};

const isoDay = (date: Date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;

/**
 * One draft order per supplier from the rows given (each must have a supplier).
 * Lines with nothing to order are dropped; a supplier's minimum counted across
 * the order scales the lines up to it (draft-po.ts); then every line is raised
 * to whole cases, so the total can only grow past the minimum.
 */
function buildDrafts(rows: StockRow[], today: string): DraftOrder[] {
  const bySupplier = new Map<string, StockRow[]>();
  for (const row of rows) {
    if (!row.supplier || row.suggestedQty <= 0) continue;
    bySupplier.set(row.supplier.id, [...(bySupplier.get(row.supplier.id) ?? []), row]);
  }
  return [...bySupplier.values()]
    .map((list) => {
      const supplier = list[0].supplier!;
      const draft = computeDraftPo(
        list.map((row) => ({
          variantId: row.item.id,
          suggestedQty: row.suggestedQty,
          unitCost: row.unitCost.toFixed(2),
          effectiveLeadTimeDays: row.leadTimeDays,
        })),
        supplier.moq,
        supplier.moq_applies_to === "sku" ? "SKU" : "ORDER",
        dayToDate(today),
      );
      const byId = new Map(list.map((row) => [row.item.id, row]));
      const lines = draft.lines.map((line) => {
        const row = byId.get(line.variantId)!;
        const qty = roundUpToCase(line.qty, row.casePack);
        return {
          stock_item_id: line.variantId,
          name: row.name,
          qty,
          unit_cost: Number(line.unitCost),
          supplier_sku: row.item.supplier_sku ?? null,
          cases: caseLabel(qty, row.casePack),
        };
      });
      return {
        supplier,
        lines,
        totalUnits: lines.reduce((n, line) => n + line.qty, 0),
        totalCost: computePoTotals({
          lines: lines.map((line) => ({
            qtyOrdered: line.qty,
            unitCost: line.unit_cost.toFixed(2),
          })),
          shippingCost: 0,
          taxRatePct: 0,
          adjustments: [],
        }).subtotal.toNumber(),
        expectedOn: isoDay(draft.estDeliveryDate),
        bumpedToMinimum: draft.moqBumped,
      };
    })
    .sort((a, b) => b.totalCost - a.totalCost);
}

/**
 * True when the item has someone to order it from: a supplier that is still
 * used. One marked "we don't order from them any more" counts as none.
 */
export const hasLiveSupplier = (row: StockRow) =>
  row.supplier !== null && !row.supplier.archived_at;

/**
 * One suggested order per supplier, from everything of theirs that is due.
 * Suppliers no longer used get no order, here as when items are ticked.
 */
export function draftOrders(rows: StockRow[], today: string): DraftOrder[] {
  return buildDrafts(
    rows.filter((row) => row.due && hasLiveSupplier(row) && isPlanned(row)),
    today,
  );
}

export type SelectionDraft = {
  orders: DraftOrder[];
  /** Ticked, but with no supplier to order from (none, or one no longer used). */
  noSupplier: StockRow[];
  /** Ticked, but there is plenty: nothing to order right now. */
  nothingToOrder: StockRow[];
  /** Ticked, but switched off from reordering. */
  notPlanned: StockRow[];
};

/**
 * Draft orders for the ticked items, one per supplier, whatever their
 * order-by date (TuftStock's "Auto Draft PO"). Anything that can't go on an
 * order is handed back by reason rather than dropped quietly.
 */
export function draftOrdersForItems(
  rows: StockRow[],
  itemIds: Iterable<string>,
  today: string,
): SelectionDraft {
  const picked = new Set(itemIds);
  const out: SelectionDraft = { orders: [], noSupplier: [], nothingToOrder: [], notPlanned: [] };
  const usable: StockRow[] = [];
  for (const row of rows) {
    if (!picked.has(row.item.id)) continue;
    if (!isPlanned(row)) out.notPlanned.push(row);
    else if (!hasLiveSupplier(row)) out.noSupplier.push(row);
    else if (row.suggestedQty <= 0) out.nothingToOrder.push(row);
    else usable.push(row);
  }
  out.orders = buildDrafts(usable, today);
  return out;
}

/**
 * The best sellers: the top fifth of planned items by what they brought in
 * over 90 days (units × the shop's price; plain units when no prices are known).
 */
export function topSellerIds(rows: StockRow[]): Set<string> {
  const planned = rows.filter(isPlanned);
  const priced = planned.some((row) => (row.price ?? 0) > 0 && row.plan.sales90d > 0);
  const worth = (row: StockRow) => row.plan.sales90d * (priced ? (row.price ?? 0) : 1);
  const sorted = [...planned].sort((a, b) => worth(b) - worth(a));
  const cut = Math.max(1, Math.ceil(sorted.length * 0.2));
  return new Set(
    sorted
      .slice(0, cut)
      .filter((row) => worth(row) > 0)
      .map((row) => row.item.id),
  );
}

/** A best seller whose order-by date is within a week, or already past. */
export function isAtRisk(row: StockRow, top: Set<string>, today: string): boolean {
  return (
    isPlanned(row) &&
    top.has(row.item.id) &&
    row.plan.reorderDate !== null &&
    row.plan.reorderDate.getTime() <= addDays(dayToDate(today), 7).getTime()
  );
}

/** "12", "0.5": a monthly rate short enough to read at a glance. */
export const perMonth = (row: StockRow) => {
  const v = row.plan.velocityPerMonth;
  return v >= 10 ? String(Math.round(v)) : v.toFixed(1).replace(/\.0$/, "");
};

/**
 * How the suggested quantity was reached, in plain words: what sells, what's
 * here, when it runs out, and how the number was rounded.
 */
export function explainSuggestion(row: StockRow, today: string): string {
  const { plan, item } = row;
  if (plan.isDeadStock) return "Nothing sold in 90 days, so there's nothing to suggest.";
  const have = `${item.on_hand} on the shelf${row.onOrder > 0 ? `, ${row.onOrder} on the way` : ""}`;
  const sells = `Sells about ${perMonth(row)} a month`;
  if (plan.suggestedQty <= 0) {
    return `${sells}. ${have}: enough for now${
      plan.stockOutDate ? `, runs out ${relativeDay(plan.stockOutDate, today)}` : ""
    }.`;
  }
  let text = `${sells}. ${have}, runs out ${relativeDay(plan.stockOutDate, today)}. To last the ${
    row.leadTimeDays
  } days it takes to arrive and ${row.coverageDays} days after`;
  if (item.safety_stock > 0) text += `, keeping ${item.safety_stock} spare`;
  text += `, order ${plan.suggestedQty}`;
  if (plan.moqApplied) text += ` (raised to the smallest order of ${row.minimum})`;
  const cases = caseLabel(row.suggestedQty, row.casePack);
  if (cases) {
    text +=
      row.suggestedQty === plan.suggestedQty
        ? `: ${cases}`
        : `, rounded up to ${cases} (${row.suggestedQty})`;
  }
  return `${text}.`;
}

/** "in 5 days", "3 days ago", "today": how far a date is from the workspace's today. */
export function relativeDay(date: Date | null, today: string): string {
  if (!date) return "–";
  const days = Math.round((date.getTime() - dayToDate(today).getTime()) / 86_400_000);
  if (days === 0) return "today";
  const n = Math.abs(days);
  const span =
    n < 14
      ? `${n} day${n === 1 ? "" : "s"}`
      : n < 70
        ? `${Math.round(n / 7)} weeks`
        : `${Math.round(n / 30)} months`;
  return days > 0 ? `in ${span}` : `${span} ago`;
}

export const HEALTH_LABELS = {
  out: "Out of stock",
  under: "Running low",
  healthy: "Healthy",
  over: "Too much",
  nosales: "Not selling",
} as const;

export const ORDER_STATUS: Record<
  string,
  { label: string; tone: "open" | "waiting" | "good" | "bad" | "closed" }
> = {
  draft: { label: "Draft", tone: "closed" },
  ordered: { label: "Sent, waiting", tone: "open" },
  partial: { label: "Part arrived", tone: "waiting" },
  closed: { label: "All in", tone: "good" },
  cancelled: { label: "Cancelled", tone: "closed" },
};
