import type { StockSettings } from "./config";
import {
  classifyStockHealth,
  computeDraftPo,
  computeOnOrder,
  computeReorder,
  type DailySale,
  type ReorderResult,
  type StockHealthResult,
} from "./engine";
import { addDays } from "./engine/days";
import { blendIndex, monthlyIndex } from "./engine/seasonality";

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
  plan: ReorderResult;
  health: StockHealthResult;
  /** Reorder date is within two weeks (or past) and there is something to order. */
  due: boolean;
};

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
    const plan = computeReorder({
      salesByDay: sales,
      stockOnHand: item.on_hand,
      onOrder,
      effectiveLeadTimeDays: leadTimeDays,
      effectiveCoverageDays: coverageDays,
      safetyStockUnits: item.safety_stock,
      moq: supplier?.moq ?? 1,
      moqAppliesTo: supplier?.moq_applies_to === "sku" ? "SKU" : "ORDER",
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
      plan,
      health,
      due,
    };
  });
}

/** Items worth planning for: counted by the shop, still on sale, not hidden. */
export const isPlanned = (row: StockRow) =>
  row.item.tracked && !row.item.hidden && row.item.product_status !== "ARCHIVED";

export type DraftOrder = {
  supplier: SupplierRow;
  lines: { stock_item_id: string; name: string; qty: number; unit_cost: number }[];
  totalUnits: number;
  totalCost: number;
  expectedOn: string;
  bumpedToMinimum: boolean;
};

const isoDay = (date: Date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;

/** One suggested order per supplier, from everything of theirs that is due. */
export function draftOrders(rows: StockRow[], today: string): DraftOrder[] {
  const bySupplier = new Map<string, StockRow[]>();
  for (const row of rows) {
    if (!row.due || !row.supplier || !isPlanned(row)) continue;
    bySupplier.set(row.supplier.id, [...(bySupplier.get(row.supplier.id) ?? []), row]);
  }
  return [...bySupplier.values()]
    .map((list) => {
      const supplier = list[0].supplier!;
      const draft = computeDraftPo(
        list.map((row) => ({
          variantId: row.item.id,
          suggestedQty: row.plan.suggestedQty,
          unitCost: String(row.unitCost),
          effectiveLeadTimeDays: row.leadTimeDays,
        })),
        supplier.moq,
        supplier.moq_applies_to === "sku" ? "SKU" : "ORDER",
        dayToDate(today),
      );
      const names = new Map(list.map((row) => [row.item.id, row.name]));
      const lines = draft.lines.map((line) => ({
        stock_item_id: line.variantId,
        name: names.get(line.variantId) ?? "",
        qty: line.qty,
        unit_cost: Number(line.unitCost),
      }));
      return {
        supplier,
        lines,
        totalUnits: draft.totalUnits,
        totalCost: lines.reduce((sum, line) => sum + line.qty * line.unit_cost, 0),
        expectedOn: isoDay(draft.estDeliveryDate),
        bumpedToMinimum: draft.moqBumped,
      };
    })
    .sort((a, b) => b.totalCost - a.totalCost);
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
