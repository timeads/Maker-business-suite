import type { StockSettings } from "./config";
import { resolveCost, type ItemCost } from "./cost";
import {
  caseLabel,
  casePackOf,
  classifyStockHealth,
  computeDraftPo,
  computeOnOrder,
  computeReorder,
  computeVelocity,
  type DailySale,
  type ReorderResult,
  roundUpToCase,
  type StockHealthResult,
} from "./engine";
import {
  daysApart,
  earliestArrival,
  latestOrderDay,
  planBuildAhead,
  type BuildAhead,
  type Closure,
} from "./engine/closures";
import { addDays } from "./engine/days";
import { blendIndex, monthlyIndex } from "./engine/seasonality";
import { SPARSE_WINDOW_DAYS } from "./engine/velocity";
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
  /** The workspace's own cost for a unit; wins over every other figure. */
  own_cost?: number | string | null;
  /** Photos the shop sync noted: this option's own, and the product's main one. */
  variant_image_url?: string | null;
  image_url?: string | null;
};
/** What an item brought in over the last 90 days (units × the price paid). */
export type RevenueRow = { stock_item_id: string; revenue: number | string };
/** Units checked in for an item across all its orders, and what they cost in all. */
export type ReceivedCostRow = {
  stock_item_id: string;
  units: number | string;
  total: string | number;
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
/** A stretch a supplier is shut, as stored (`supplier_closures`). */
export type ClosureRow = {
  id: string;
  supplier_id: string;
  name: string;
  starts_on: string;
  ends_on: string;
};
export type SaleRow = { stock_item_id: string; day: string; units: number | string };
/** A day the shop's count for an item read zero or less (from the daily count). */
export type EmptyDayRow = { stock_item_id: string; day: string };
export type OpenLine = {
  stock_item_id: string;
  qty_ordered: number;
  qty_received: number;
  status: string;
  /** The order the line sits on, for the "on order" chip. */
  order_number?: number;
  order_created_at?: string;
};

export type StockRow = {
  item: ItemRow;
  name: string;
  supplier: SupplierRow | null;
  leadTimeDays: number;
  coverageDays: number;
  onOrder: number;
  /** What a unit costs, as a plain number for showing and sorting (see `cost`). */
  unitCost: number;
  /** The same figure in whole cents, where it came from, and the others beside it. */
  cost: ItemCost;
  price: number | null;
  /** Units to a case, when it is bought by the case. */
  casePack: number | null;
  /** The smallest amount of this one item an order can carry (1 = no minimum). */
  minimum: number;
  /** The engine's own figures. `plan.suggestedQty` is before case rounding. */
  plan: ReorderResult;
  /** Sold-out days the sales rate left out (0 when it was never out, or none are known). */
  soldOutDays: number;
  /** What to order: the engine's figure, raised to whole cases. */
  suggestedQty: number;
  health: StockHealthResult;
  /** Reorder date is within two weeks (or past) and there is something to order. */
  due: boolean;
  /** A rule in Settings ("gift card"...) keeps this one out of planning. */
  skippedByRule: boolean;
  /** The stretches its supplier is shut, today's and those to come. */
  closures: Closure[];
  /**
   * Set when a closure moved the order-by date earlier, so the order lands
   * before the supplier shuts (`plan.reorderDate` is already the moved date).
   */
  closure: {
    name: string;
    startsOn: string;
    endsOn: string;
    /** The order-by date the sums gave before the closure was counted. */
    movedFrom: Date;
    /** They are shut today. */
    underWay: boolean;
  } | null;
  /**
   * Ordering ahead of the supplier's next closure: the last day to order, and
   * how many to order today so the shelf lasts until the first order after
   * they reopen could arrive. Null when no closure is coming.
   */
  buildAhead: (BuildAhead & { qty: number }) | null;
  /** What it brought in over 90 days, and that as a share (0 to 1) of everything sold. */
  revenue90: number;
  revenueShare: number;
  /**
   * Sent orders still owing some of this item: how many, and the oldest one's
   * number. A line that has all arrived no longer counts, as in TuftStock.
   */
  openOrders: { count: number; firstNumber: number | null };
  /** This option's photo, else the product's. Null when the shop gave none. */
  photo: string | null;
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

const isoDay = (date: Date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;

/**
 * The first day whose count can matter to the sales rate: the engine's
 * longest window back from the workspace's today. Older empty days needn't
 * be read at all.
 */
export const emptyDaysSince = (today: string) =>
  isoDay(addDays(dayToDate(today), -SPARSE_WINDOW_DAYS));

export function buildStockRows(input: {
  items: ItemRow[];
  suppliers: SupplierRow[];
  sales: SaleRow[];
  openLines: OpenLine[];
  /**
   * Days each item's count read zero or less. The engine leaves those days
   * out of the sales rate (a day with a sale is never counted as sold out),
   * exactly as TuftStock does. Left out, every day counts.
   */
  emptyDays?: EmptyDayRow[];
  /** What checked-in deliveries cost, per item, for the average cost. */
  received?: ReceivedCostRow[];
  /**
   * When suppliers are shut. An item's order-by date moves earlier so its
   * order isn't in the works on a closed day (engine/closures.ts).
   */
  closures?: ClosureRow[];
  /**
   * What each item brought in over the last 90 days, from the sales
   * themselves. Left out, it is estimated as units sold × today's price.
   */
  revenue?: RevenueRow[];
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
  const emptyByItem = new Map<string, Date[]>();
  for (const row of input.emptyDays ?? []) {
    const date = dayToDate(row.day);
    const list = emptyByItem.get(row.stock_item_id);
    if (list) list.push(date);
    else emptyByItem.set(row.stock_item_id, [date]);
  }
  const receivedByItem = new Map(
    (input.received ?? []).map((row) => [
      row.stock_item_id,
      { units: Number(row.units), total: String(row.total) },
    ]),
  );
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
  const closuresBySupplier = new Map<string, Closure[]>();
  for (const row of input.closures ?? []) {
    const closure = { id: row.id, name: row.name, startsOn: row.starts_on, endsOn: row.ends_on };
    const list = closuresBySupplier.get(row.supplier_id);
    if (list) list.push(closure);
    else closuresBySupplier.set(row.supplier_id, [closure]);
  }
  const revenueByItem = input.revenue
    ? new Map(input.revenue.map((row) => [row.stock_item_id, Number(row.revenue) || 0]))
    : null;

  const built = input.items.map((item) => {
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
    const empty = emptyByItem.get(item.id) ?? [];
    const reorder = (cover: number) =>
      computeReorder({
        salesByDay: sales,
        stockOnHand: item.on_hand,
        onOrder,
        effectiveLeadTimeDays: leadTimeDays,
        effectiveCoverageDays: cover,
        safetyStockUnits: item.safety_stock,
        moq,
        moqAppliesTo: perItem ? "SKU" : "ORDER",
        reviewBufferDays: input.settings.review_buffer_days,
        today,
        seasonalIndex,
        outOfStockDates: empty,
      });
    let plan = reorder(coverageDays);
    let suggestedQty = roundUpToCase(plan.suggestedQty, casePack);

    // Closures. The engine's dates and amounts above know nothing of them;
    // what follows only ever moves the order-by date earlier and the amount up.
    const shut = (supplier && closuresBySupplier.get(supplier.id)) || NO_CLOSURES;
    let closure: StockRow["closure"] = null;
    let buildAhead: StockRow["buildAhead"] = null;
    if (shut.length > 0 && !plan.isDeadStock) {
      const ahead = planBuildAhead({ today: input.today, leadDays: leadTimeDays, closures: shut });
      if (ahead) {
        // Enough to last until the first order after they reopen could arrive.
        const cover = Math.max(coverageDays, ahead.daysToCover - leadTimeDays);
        buildAhead = {
          ...ahead,
          qty: roundUpToCase(reorder(cover).suggestedQty, casePack),
        };
      }
      if (plan.reorderDate) {
        // The engine's order-by date is "arrive by this day, less the lead time".
        const last = latestOrderDay({
          needBy: isoDay(addDays(plan.reorderDate, leadTimeDays)),
          leadDays: leadTimeDays,
          closures: shut,
        });
        if (last.closure && last.daysEarlier > 0) {
          const moved = dayToDate(last.orderBy);
          closure = {
            name: last.closure.name,
            startsOn: last.closure.startsOn,
            endsOn: last.closure.endsOn,
            movedFrom: plan.reorderDate,
            underWay:
              daysApart(last.closure.startsOn, input.today) >= 0 &&
              daysApart(input.today, last.closure.endsOn) >= 0,
          };
          plan = { ...plan, reorderDate: moved, isOverdue: moved.getTime() < today.getTime() };
          // This is the order that has to sit the closure out: size it for that.
          if (buildAhead && buildAhead.closure.startsOn === last.closure.startsOn) {
            suggestedQty = Math.max(suggestedQty, buildAhead.qty);
          }
        }
      }
      // An order placed today that can't get going until they reopen has
      // that much longer to cover.
      const wait = daysApart(
        input.today,
        earliestArrival({ orderDay: input.today, leadDays: leadTimeDays, closures: shut }).startsOn,
      );
      if (wait > 0 && plan.suggestedQty > 0) {
        suggestedQty = Math.max(
          suggestedQty,
          roundUpToCase(reorder(coverageDays + wait).suggestedQty, casePack),
        );
      }
      // Too late to land before they shut: the card for that closure says
      // what an order placed today would need to be.
      if (buildAhead?.missed) {
        buildAhead = { ...buildAhead, qty: Math.max(buildAhead.qty, suggestedQty) };
      }
    }
    const health = classifyStockHealth({
      stockOnHand: item.on_hand,
      onOrder,
      unitsPerDay: plan.unitsPerDay,
      isDeadStock: plan.isDeadStock,
      effectiveLeadTimeDays: leadTimeDays,
      effectiveCoverageDays: coverageDays,
      reviewBufferDays: input.settings.review_buffer_days,
    });
    const cost = resolveCost({
      ownCost: item.own_cost,
      received: receivedByItem.get(item.id),
      shopCost: item.unit_cost,
    });
    const due =
      suggestedQty > 0 &&
      plan.reorderDate !== null &&
      plan.reorderDate.getTime() <= addDays(today, DUE_WITHIN_DAYS).getTime();
    return {
      item,
      name: itemName(item),
      supplier,
      leadTimeDays,
      coverageDays,
      onOrder,
      unitCost: cost.cost.toNumber(),
      cost,
      price: item.price == null ? null : Number(item.price) || 0,
      casePack,
      minimum: perItem ? moq : 1,
      plan,
      // The engine's own count of the days it dropped (a day with a sale never is).
      soldOutDays: empty.length > 0 ? computeVelocity(sales, today, empty).outOfStockDays : 0,
      suggestedQty,
      closures: shut,
      closure,
      buildAhead,
      health,
      due,
      skippedByRule: matchesSkipWords(item, input.settings.skip_words),
      revenue90: revenueByItem
        ? (revenueByItem.get(item.id) ?? 0)
        : plan.sales90d * (Number(item.price) || 0),
      revenueShare: 0,
      openOrders: openOrdersOf(linesByItem.get(item.id) ?? []),
      photo: item.variant_image_url ?? item.image_url ?? null,
    };
  });
  // Each item's share of everything sold in 90 days (TuftStock's "% Rev").
  const grand = built.reduce((sum, row) => sum + row.revenue90, 0);
  if (grand > 0) for (const row of built) row.revenueShare = row.revenue90 / grand;
  return built;
}

const NO_CLOSURES: Closure[] = [];

/** Sent orders that still owe some of an item, oldest first. */
function openOrdersOf(lines: OpenLine[]): StockRow["openOrders"] {
  const seen = new Map<number, string>();
  for (const line of lines) {
    const status = line.status.toLowerCase();
    if (status !== "ordered" && status !== "partial") continue;
    if (line.qty_ordered - line.qty_received <= 0 || line.order_number == null) continue;
    if (!seen.has(line.order_number)) seen.set(line.order_number, line.order_created_at ?? "");
  }
  const oldest = [...seen].sort((a, b) => a[1].localeCompare(b[1]) || a[0] - b[0])[0];
  return { count: seen.size, firstNumber: oldest ? oldest[0] : null };
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

/**
 * One draft order per supplier from the rows given (each must have a supplier).
 * Lines with nothing to order are dropped; a supplier's minimum counted across
 * the order scales the lines up to it (draft-po.ts); then every line is raised
 * to whole cases, so the total can only grow past the minimum.
 */
function buildDrafts(
  rows: StockRow[],
  today: string,
  qtyOf: (row: StockRow) => number = (row) => row.suggestedQty,
): DraftOrder[] {
  const bySupplier = new Map<string, StockRow[]>();
  for (const row of rows) {
    if (!row.supplier || qtyOf(row) <= 0) continue;
    bySupplier.set(row.supplier.id, [...(bySupplier.get(row.supplier.id) ?? []), row]);
  }
  return [...bySupplier.values()]
    .map((list) => {
      const supplier = list[0].supplier!;
      const draft = computeDraftPo(
        list.map((row) => ({
          variantId: row.item.id,
          suggestedQty: qtyOf(row),
          unitCost: row.cost.cost.toFixed(2),
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
        // Counted from the day they reopen, if it would otherwise run through a closure.
        expectedOn: earliestArrival({
          orderDay: today,
          leadDays: Math.max(0, ...list.map((row) => row.leadTimeDays)),
          closures: list[0].closures,
        }).arrives,
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

/** How far ahead a closure's order shows on the "To order" tab. */
export const CLOSURE_CARD_DAYS = 60;

export type ClosureOrder = DraftOrder & {
  closure: { name: string; startsOn: string; endsOn: string };
  /** The last day to place it (the earliest among its items, when they differ). */
  orderBefore: string;
  /** That day has gone by. */
  missed: boolean;
  /** When the first order placed after they reopen could arrive. */
  nextArrival: string;
  /** It needs placing within two weeks, so it stands in for the supplier's usual order. */
  dueNow: boolean;
};

/**
 * One order per supplier with a closure coming: everything of theirs that
 * would run short before the first order after they reopen could arrive,
 * sized to last until then. Shown from sixty days before its last order day.
 */
export function closureOrders(rows: StockRow[], today: string): ClosureOrder[] {
  const affected = rows.filter(
    (row) => isPlanned(row) && hasLiveSupplier(row) && (row.buildAhead?.qty ?? 0) > 0,
  );
  const out: ClosureOrder[] = [];
  for (const draft of buildDrafts(affected, today, (row) => row.buildAhead?.qty ?? 0)) {
    const lines = new Set(draft.lines.map((line) => line.stock_item_id));
    const plans = affected
      .filter((row) => lines.has(row.item.id) && row.supplier!.id === draft.supplier.id)
      .map((row) => row.buildAhead!);
    if (plans.length === 0) continue;
    const orderBefore = plans.map((plan) => plan.orderBefore).sort()[0];
    const until = daysApart(today, orderBefore);
    if (until > CLOSURE_CARD_DAYS) continue;
    const { closure } = plans[0];
    out.push({
      ...draft,
      closure: { name: closure.name, startsOn: closure.startsOn, endsOn: closure.endsOn },
      orderBefore,
      missed: until < 0,
      nextArrival: plans
        .map((plan) => plan.nextArrival)
        .sort()
        .at(-1)!,
      dueNow: until <= DUE_WITHIN_DAYS,
    });
  }
  return out.sort((a, b) => a.orderBefore.localeCompare(b.orderBefore));
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
 * The best sellers: the top fifth of all items by their share of what the
 * shop took in over 90 days. TuftStock's rule, kept as it is: every item is
 * ranked (left-out ones too), and the cut is a fifth of the list, at least one.
 */
export function topSellerIds(rows: StockRow[]): Set<string> {
  const sorted = [...rows].sort((a, b) => b.revenueShare - a.revenueShare);
  const cut = Math.max(1, Math.ceil(sorted.length * 0.2));
  return new Set(sorted.slice(0, cut).map((row) => row.item.id));
}

/**
 * A best seller, with a supplier still in use, whose order-by date is within
 * a week or already past.
 */
export function isAtRisk(row: StockRow, top: Set<string>, today: string): boolean {
  return (
    isPlanned(row) &&
    hasLiveSupplier(row) &&
    top.has(row.item.id) &&
    row.plan.reorderDate !== null &&
    daysFrom(row.plan.reorderDate, today) <= 7
  );
}

/** Dead stock, as TuftStock counts it: nothing sold in 90 days and some still on the shelf. */
export const isDeadStock = (row: StockRow) => row.plan.isDeadStock && row.item.on_hand > 0;

/** Whole days from the workspace's today to a date (negative when it has passed). */
export const daysFrom = (date: Date, today: string) =>
  Math.round((date.getTime() - dayToDate(today).getTime()) / 86_400_000);

/** It will run out before a new order could arrive. */
export const runsOutBeforeArrival = (row: StockRow, today: string) =>
  row.plan.stockOutDate !== null && daysFrom(row.plan.stockOutDate, today) < row.leadTimeDays;

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
  const out = row.soldOutDays;
  const sells = `Sells about ${perMonth(row)} a month${
    out > 0 ? ` while it's in stock (${out} sold-out day${out === 1 ? "" : "s"} left out)` : ""
  }`;
  const cases = caseLabel(row.suggestedQty, row.casePack);
  const shut = row.closure ?? row.buildAhead?.closure ?? null;
  const through = shut
    ? `through ${shut.name}, when ${row.supplier?.name ?? "the supplier"} is shut`
    : "until they reopen";
  if (plan.suggestedQty <= 0) {
    const runsOut = plan.stockOutDate ? `, runs out ${relativeDay(plan.stockOutDate, today)}` : "";
    // Plenty by the usual sums, but not enough to sit out a closure.
    if (row.suggestedQty > 0) {
      return `${sells}. ${have}${runsOut}. That would do for now, but order ${row.suggestedQty}${
        cases ? ` (${cases})` : ""
      } to last ${through}.`;
    }
    return `${sells}. ${have}: enough for now${runsOut}.`;
  }
  let text = `${sells}. ${have}, runs out ${relativeDay(plan.stockOutDate, today)}. To last the ${
    row.leadTimeDays
  } days it takes to arrive and ${row.coverageDays} days after`;
  if (item.safety_stock > 0) text += `, keeping ${item.safety_stock} spare`;
  text += `, order ${plan.suggestedQty}`;
  if (plan.moqApplied) text += ` (raised to the smallest order of ${row.minimum})`;
  const plainQty = roundUpToCase(plan.suggestedQty, row.casePack);
  const plainCases = caseLabel(plainQty, row.casePack);
  if (plainCases) {
    text +=
      plainQty === plan.suggestedQty
        ? `: ${plainCases}`
        : `, rounded up to ${plainCases} (${plainQty})`;
  }
  if (row.suggestedQty > plainQty) {
    text += `. Raised to ${row.suggestedQty}${cases ? ` (${cases})` : ""} to last ${through}`;
  }
  return `${text}.`;
}

/**
 * A number of days as words, the way TuftStock's lists say it: "14 days",
 * "about 1 month", "3 months", "about 1 year".
 */
export function distanceWords(days: number): string {
  const n = Math.abs(Math.round(days));
  if (n < 30) return `${n} day${n === 1 ? "" : "s"}`;
  const months = Math.round(n / 30);
  if (n < 60) return `about ${months} month${months === 1 ? "" : "s"}`;
  if (months < 12) return `${months} months`;
  const years = Math.floor(months / 12);
  const extra = months % 12;
  if (extra < 3) return `about ${years} year${years === 1 ? "" : "s"}`;
  if (extra < 9) return `over ${years} year${years === 1 ? "" : "s"}`;
  return `almost ${years + 1} years`;
}

/** "in 14 days", "about 1 month ago", "today": how far a date is from the workspace's today. */
export function relativeDay(date: Date | null, today: string): string {
  if (!date) return "–";
  const days = daysFrom(date, today);
  if (days === 0) return "today";
  return days > 0 ? `in ${distanceWords(days)}` : `${distanceWords(days)} ago`;
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
