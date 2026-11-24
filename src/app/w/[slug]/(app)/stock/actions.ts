"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { getEntitlements } from "@/lib/entitlements";
import { localDay } from "@/lib/bookings/slots";
import { canWriteShopifyStock } from "@/lib/connections/providers/shopify-stock";
import { guessCarrier, tidyTracking } from "@/lib/shipping/carriers";
import { Money } from "@/lib/stock/balance/money";
import {
  MAX_SAVED_VIEWS,
  MAX_SEASONS,
  STOCK_MODULE,
  STOCK_SEASONS_KEY,
  STOCK_SETTINGS_KEY,
  STOCK_VIEWS_KEY,
  parseSavedViews,
  parseSeasons,
  savedViewsSchema,
  seasonsSchema,
  stockSettingsSchema,
  type SeasonConfig,
} from "@/lib/stock/config";
import { isColumnKey, isViewKey } from "@/lib/stock/views";
import { startingQty } from "@/lib/stock/engine";
import { dayNumber, daysApart } from "@/lib/stock/engine/closures";
import {
  closureOrders,
  draftOrders,
  draftOrdersForItems,
  seasonGroupItems,
  type DraftOrder,
  type StockRow,
} from "@/lib/stock/plan";
import { createClient } from "@/lib/supabase/server";
import { canManage, getTenantContext } from "@/lib/tenants";
import { loadIncoming, loadStock } from "./data";

export type StockState = { error?: string; message?: string };

const NO_ACCESS = "Stock isn't part of this workspace's plan right now.";
const NOT_ALLOWED = "Only owners and admins can do that.";
const READ_ONLY =
  "This workspace is read-only because its plan has ended. Pick a plan to make changes.";
const OOPS = "That didn't save. Please try again.";
const UUID = /^[0-9a-f-]{36}$/i;
const KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

async function context(slug: string, managersOnly = true) {
  const user = await requireUser(`/w/${slug}/stock`);
  const ctx = await getTenantContext(slug, user.id);
  if (!ctx) return { error: NO_ACCESS } as const;
  const entitlements = await getEntitlements(ctx.tenant.id);
  if (!entitlements.can("module.stock")) return { error: NO_ACCESS } as const;
  if (!entitlements.canWrite) return { error: READ_ONLY } as const;
  if (managersOnly && !canManage(ctx.role)) return { error: NOT_ALLOWED } as const;
  return { tenant: ctx.tenant, supabase: await createClient() } as const;
}

const text = (formData: FormData, name: string) => String(formData.get(name) ?? "").trim();
const whole = (formData: FormData, name: string) => {
  const value = text(formData, name);
  return value === "" ? null : Number.parseInt(value, 10);
};
const done = (slug: string) => revalidatePath(`/w/${slug}/stock`, "layout");
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * The key the page made for this press of the button. Pressing twice sends the
 * same key, and the database hands back the first press's orders instead of
 * making more. With no usable key (scripts off) we make one here: the order is
 * still drafted, just without that protection.
 */
const requestKey = (formData: FormData) => {
  const key = text(formData, "request_key");
  return KEY.test(key) ? key : crypto.randomUUID();
};

/** An amount of money typed into a form, as "12.50". Null when it isn't one. */
function amount(value: string, { negative = false } = {}): string | null {
  if (value === "") return "0.00";
  if (!/^-?\d{0,9}(\.\d{0,4})?$/.test(value) || !/\d/.test(value)) return null;
  try {
    const money = new Money(value);
    return money.isNegative() && !negative ? null : money.toFixed(2);
  } catch {
    return null;
  }
}

const orderPayload = (order: DraftOrder) => ({
  supplier_id: order.supplier.id,
  expected_on: order.expectedOn,
  lines: order.lines.map((line) => ({
    stock_item_id: line.stock_item_id,
    qty: line.qty,
    unit_cost: line.unit_cost.toFixed(2),
    supplier_sku: line.supplier_sku ?? "",
    note: "",
  })),
});

const names = (rows: StockRow[]) =>
  rows.length <= 2
    ? rows.map((row) => row.name).join(" and ")
    : `${rows[0].name} and ${rows.length - 1} more`;

export async function saveSupplier(
  slug: string,
  supplierId: string | null,
  _prev: StockState,
  formData: FormData,
): Promise<StockState> {
  const ctx = await context(slug);
  if ("error" in ctx) return { error: ctx.error };
  const name = text(formData, "name");
  const email = text(formData, "email");
  const lead = whole(formData, "lead");
  const cover = whole(formData, "cover");
  const moq = whole(formData, "moq") ?? 1;
  if (!name || name.length > 120) return { error: "Give the supplier a name." };
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { error: "That email doesn't look right." };
  }
  const moreEmails = [
    ...new Set(
      text(formData, "more_emails")
        .split(/[\s,;]+/)
        .map((value) => value.trim().toLowerCase())
        .filter(Boolean),
    ),
  ];
  if (
    moreEmails.length > 5 ||
    moreEmails.some((value) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value))
  ) {
    return { error: "Check the other emails: up to five, with commas between them." };
  }
  // Empty follows the workspace's usual figure (Stock → Settings).
  if (lead !== null && !(lead >= 0 && lead <= 365)) {
    return { error: "How many days from ordering to arriving? (0 to 365, or leave it empty)" };
  }
  if (cover === null || !(cover >= 1 && cover <= 365)) {
    return { error: "How many days of sales should one order cover? (1 to 365)" };
  }
  if (!(moq >= 1 && moq <= 1_000_000)) return { error: "The smallest order is at least 1." };
  const { data: savedId, error } = await ctx.supabase.rpc("save_supplier", {
    p_tenant_id: ctx.tenant.id,
    p_supplier_id: supplierId,
    p_name: name,
    p_email: email,
    p_lead_time_days: lead,
    p_coverage_days: cover,
    p_moq: moq,
    p_moq_applies_to: text(formData, "moq_applies_to") === "sku" ? "sku" : "order",
    p_notes: text(formData, "notes"),
    p_archived: formData.get("archived") === "on",
  });
  if (error) {
    return { error: error.code === "23505" ? "You already have a supplier with that name." : OOPS };
  }
  const { error: contactError } = await ctx.supabase.rpc("save_supplier_contact", {
    p_tenant_id: ctx.tenant.id,
    p_supplier_id: (savedId as string | null) ?? supplierId,
    p_contact_name: text(formData, "contact_name").slice(0, 120),
    p_more_emails: moreEmails,
  });
  if (contactError) return { error: OOPS };
  done(slug);
  return { message: supplierId ? "Saved." : `${name} is added.` };
}

/**
 * Sets a supplier's days-to-arrive to how long their past orders really took.
 * The figure is worked out again here, on the server, not taken from the page.
 */
export async function adoptLeadTime(
  slug: string,
  supplierId: string,
  _prev: StockState,
  _formData: FormData,
): Promise<StockState> {
  const ctx = await context(slug);
  if ("error" in ctx) return { error: ctx.error };
  if (!UUID.test(supplierId)) return { error: OOPS };
  const { leadTimes } = await loadIncoming(ctx.supabase, ctx.tenant);
  const observed = leadTimes.get(supplierId);
  if (!observed) return { error: "There aren't enough arrived orders yet to go by." };
  const { error } = await ctx.supabase.rpc("set_supplier_lead_time", {
    p_tenant_id: ctx.tenant.id,
    p_supplier_id: supplierId,
    p_days: Math.min(365, Math.max(0, observed.days)),
  });
  if (error) return { error: OOPS };
  done(slug);
  return { message: `Set to ${observed.days} days. Order-by dates for their items have moved.` };
}

/** The "Don't reorder" switch on one item: still listed, never suggested. */
export async function setItemReorder(
  slug: string,
  itemId: string,
  dontReorder: boolean,
  _prev: StockState,
  _formData: FormData,
): Promise<StockState> {
  const ctx = await context(slug);
  if ("error" in ctx) return { error: ctx.error };
  if (!UUID.test(itemId)) return { error: OOPS };
  const { error } = await ctx.supabase.rpc("set_stock_items_reorder", {
    p_tenant_id: ctx.tenant.id,
    p_item_ids: [itemId],
    p_dont_reorder: dontReorder,
  });
  if (error) return { error: OOPS };
  done(slug);
  return {
    message: dontReorder
      ? "Done. It stays in your lists, but we won't suggest it or put it on an order."
      : "It's back: we'll plan for this one again.",
  };
}

/** Gives one item to a supplier (or to none), from its row in the table. */
export async function saveItemSupplier(
  slug: string,
  itemId: string,
  supplierId: string,
): Promise<StockState> {
  const ctx = await context(slug);
  if ("error" in ctx) return { error: ctx.error };
  if (!UUID.test(itemId) || (supplierId !== "" && !UUID.test(supplierId))) return { error: OOPS };
  const { error } = await ctx.supabase.rpc("assign_stock_supplier", {
    p_tenant_id: ctx.tenant.id,
    p_item_ids: [itemId],
    p_supplier_id: supplierId || null,
  });
  if (error) return { error: OOPS };
  done(slug);
  return { message: "Saved" };
}

/** Saves one item's own planning. Empty lead time, cover or smallest order means "use the supplier's". */
export async function saveItemPlan(
  slug: string,
  itemId: string,
  _prev: StockState,
  formData: FormData,
): Promise<StockState> {
  const ctx = await context(slug);
  if ("error" in ctx) return { error: ctx.error };
  const lead = whole(formData, "lead");
  const cover = whole(formData, "cover");
  const safety = whole(formData, "safety") ?? 0;
  const casePack = whole(formData, "case_pack");
  const moq = whole(formData, "moq");
  const supplier = text(formData, "supplier");
  const supplierSku = text(formData, "supplier_sku");
  if (!UUID.test(itemId)) return { error: OOPS };
  if (lead !== null && !(lead >= 0 && lead <= 365)) return { error: "Lead time is 0 to 365 days." };
  if (cover !== null && !(cover >= 1 && cover <= 365)) return { error: "Cover is 1 to 365 days." };
  if (!(safety >= 0 && safety <= 1_000_000)) return { error: "Spare stock can't be negative." };
  if (casePack !== null && !(casePack >= 1 && casePack <= 100_000)) {
    return { error: "How many come in a case? Leave it empty if you buy them one at a time." };
  }
  if (moq !== null && !(moq >= 1 && moq <= 1_000_000)) {
    return { error: "The smallest order is at least 1. Leave it empty to use the supplier's." };
  }
  if (supplierSku.length > 120) return { error: "That supplier code is too long." };
  const { error } = await ctx.supabase.rpc("save_stock_item_plan", {
    p_tenant_id: ctx.tenant.id,
    p_item_id: itemId,
    p_supplier_id: UUID.test(supplier) ? supplier : null,
    p_lead_time_days: lead,
    p_coverage_days: cover,
    p_safety_stock: safety,
    p_hidden: formData.get("hidden") === "on",
    // A case of one is just single units.
    p_case_pack: casePack !== null && casePack > 1 ? casePack : null,
    p_moq: moq,
    p_supplier_sku: supplierSku,
  });
  if (error) return { error: OOPS };
  done(slug);
  return { message: "Saved." };
}

/**
 * The workspace's own cost for one item. Left empty, the figure is taken off
 * and the cost goes back to the average of deliveries, or the shop's.
 */
export async function saveItemCost(
  slug: string,
  itemId: string,
  _prev: StockState,
  formData: FormData,
): Promise<StockState> {
  const ctx = await context(slug);
  if ("error" in ctx) return { error: ctx.error };
  if (!UUID.test(itemId)) return { error: OOPS };
  const typed = text(formData, "own_cost");
  const cost = typed === "" ? null : amount(typed);
  if (typed !== "" && cost === null) {
    return {
      error: "Type the cost as an amount, like 12.50. Leave it empty to use the usual one.",
    };
  }
  const { error } = await ctx.supabase.rpc("set_stock_item_own_cost", {
    p_tenant_id: ctx.tenant.id,
    p_item_id: itemId,
    p_cost: cost,
  });
  if (error) return { error: OOPS };
  done(slug);
  return {
    message:
      cost === null
        ? "Taken off. We're back to what your deliveries and your shop say."
        : "Saved. New suggestions and order lines use your figure.",
  };
}

/** The "Don't reorder" switch on one item, on or off. */
export async function setItemHidden(
  slug: string,
  itemId: string,
  hidden: boolean,
  _prev: StockState,
  _formData: FormData,
): Promise<StockState> {
  const ctx = await context(slug);
  if ("error" in ctx) return { error: ctx.error };
  if (!UUID.test(itemId)) return { error: OOPS };
  const { error } = await ctx.supabase.rpc("set_stock_items_hidden", {
    p_tenant_id: ctx.tenant.id,
    p_item_ids: [itemId],
    p_hidden: hidden,
  });
  if (error) return { error: OOPS };
  done(slug);
  return {
    message: hidden
      ? "Done. We won't suggest this one or put it on an order."
      : "It's back: we'll plan for this one again.",
  };
}

/**
 * One planning figure as typed into the table or the bar above it. `empty`
 * says what an empty box means: null clears the figure (back to the
 * supplier's own, or single units); for "spare" it means none.
 */
const FIGURES = {
  lead: {
    key: "lead_time_days",
    min: 0,
    max: 365,
    empty: null,
    bad: "Days to arrive is 0 to 365.",
  },
  cover: { key: "coverage_days", min: 1, max: 365, empty: null, bad: "Cover is 1 to 365 days." },
  spare: {
    key: "safety_stock",
    min: 0,
    max: 1_000_000,
    empty: 0,
    bad: "Spare stock can't be negative.",
  },
  moq: {
    key: "moq",
    min: 1,
    max: 1_000_000,
    empty: null,
    bad: "The smallest order is at least 1.",
  },
  case_pack: {
    key: "case_pack",
    min: 1,
    max: 100_000,
    empty: null,
    bad: "A case holds at least 1.",
  },
} as const;
export type FigureField = keyof typeof FIGURES | "cost" | "supplier_sku";
const isFigure = (value: string): value is keyof typeof FIGURES => value in FIGURES;

/** A typed whole number for one figure: `{ value }`, or `{ error }` in plain words. */
function figure(field: keyof typeof FIGURES, typed: string) {
  const rule = FIGURES[field];
  if (typed === "") return { value: rule.empty } as const;
  const n = Number(typed);
  if (!/^\d{1,7}$/.test(typed) || !(n >= rule.min && n <= rule.max)) {
    return { error: rule.bad } as const;
  }
  return { value: n } as const;
}

/**
 * One figure for one item, changed right in the table. An empty box clears
 * it. The page is read again afterwards, so every sum that depends on the
 * figure (runs out, order by, suggested) moves with it.
 */
export async function saveItemFigure(
  slug: string,
  itemId: string,
  field: FigureField,
  typed: string,
): Promise<StockState> {
  const ctx = await context(slug);
  if ("error" in ctx) return { error: ctx.error };
  if (!UUID.test(itemId)) return { error: OOPS };
  const value = String(typed ?? "").trim();
  let changes: Record<string, number | string | null>;
  if (field === "cost") {
    const cost = value === "" ? null : amount(value);
    if (value !== "" && cost === null) return { error: "Type the cost like 12.50." };
    changes = { own_cost: cost === null ? null : Number(cost) };
  } else if (field === "supplier_sku") {
    if (value.length > 120) return { error: "That code is too long." };
    changes = { supplier_sku: value === "" ? null : value };
  } else if (isFigure(field)) {
    const parsed = figure(field, value);
    if ("error" in parsed) return { error: parsed.error };
    changes = { [FIGURES[field].key]: parsed.value };
  } else {
    return { error: OOPS };
  }
  const { error } = await ctx.supabase.rpc("set_stock_items_planning", {
    p_tenant_id: ctx.tenant.id,
    p_item_ids: [itemId],
    p_changes: changes,
  });
  if (error) return { error: OOPS };
  done(slug);
  return { message: "Saved" };
}

/**
 * What the bar above the items grid does with the ticked rows. The button
 * pressed says which: draft orders, stop or restart reordering, or hand them
 * to a supplier.
 */
export async function bulkItems(
  slug: string,
  _prev: StockState,
  formData: FormData,
): Promise<StockState> {
  const ctx = await context(slug);
  if ("error" in ctx) return { error: ctx.error };
  const ids = [
    ...new Set(
      formData
        .getAll("item")
        .map(String)
        .filter((id) => UUID.test(id)),
    ),
  ].slice(0, 2000);
  if (ids.length === 0) return { error: "Tick the items first." };
  const what = text(formData, "do");

  if (what === "hide" || what === "unhide") {
    const { data, error } = await ctx.supabase.rpc("set_stock_items_hidden", {
      p_tenant_id: ctx.tenant.id,
      p_item_ids: ids,
      p_hidden: what === "hide",
    });
    if (error) return { error: OOPS };
    done(slug);
    const n = (data as number) ?? 0;
    if (what === "hide") {
      return {
        message: `${plural(n, "item")} hidden: out of sight and out of planning. You'll find ${n === 1 ? "it" : "them"} under “Hidden”.`,
      };
    }
    return {
      message:
        n === 0
          ? "Nothing changed: those are left out by your shop or by a rule in Settings, not by you."
          : `${plural(n, "item")} ${n === 1 ? "is" : "are"} back in planning.`,
    };
  }

  if (what === "pause" || what === "resume") {
    const { data, error } = await ctx.supabase.rpc("set_stock_items_reorder", {
      p_tenant_id: ctx.tenant.id,
      p_item_ids: ids,
      p_dont_reorder: what === "pause",
    });
    if (error) return { error: OOPS };
    done(slug);
    const n = (data as number) ?? 0;
    return {
      message:
        what === "pause"
          ? `${plural(n, "item")} won't be reordered. ${n === 1 ? "It stays" : "They stay"} in the list.`
          : n === 0
            ? "Nothing changed: none of those were set to “don't reorder”."
            : `${plural(n, "item")} ${n === 1 ? "is" : "are"} back in planning.`,
    };
  }

  if (what === "assign") {
    const supplier = text(formData, "supplier");
    if (supplier !== "" && !UUID.test(supplier)) return { error: "Pick a supplier." };
    const { data, error } = await ctx.supabase.rpc("assign_stock_supplier", {
      p_tenant_id: ctx.tenant.id,
      p_item_ids: ids,
      p_supplier_id: supplier || null,
    });
    if (error) return { error: OOPS };
    done(slug);
    return { message: `${plural((data as number) ?? 0, "item")} updated.` };
  }

  if (what === "plan") {
    // Only the boxes that were filled in change anything; an empty one leaves
    // that figure as it is on every ticked item (as TuftStock's bulk bar does).
    const changes: Record<string, number | null> = {};
    for (const field of Object.keys(FIGURES) as (keyof typeof FIGURES)[]) {
      const typed = text(formData, `set_${field}`);
      if (typed === "") continue;
      const parsed = figure(field, typed);
      if ("error" in parsed) return { error: parsed.error };
      changes[FIGURES[field].key] = parsed.value;
    }
    if (Object.keys(changes).length === 0) {
      return { error: "Fill in at least one figure to set for the ticked items." };
    }
    const { data, error } = await ctx.supabase.rpc("set_stock_items_planning", {
      p_tenant_id: ctx.tenant.id,
      p_item_ids: ids,
      p_changes: changes,
    });
    if (error) return { error: OOPS };
    done(slug);
    return { message: `${plural((data as number) ?? 0, "item")} updated.` };
  }

  if (what !== "draft") return { error: OOPS };
  // Quantities are worked out here, on the server, never trusted from the page.
  const { rows, today } = await loadStock(ctx.supabase, ctx.tenant);
  const picked = draftOrdersForItems(rows, ids, today);
  if (picked.orders.length === 0) {
    const why = [
      picked.noSupplier.length > 0 &&
        `${names(picked.noSupplier)} ${picked.noSupplier.length === 1 ? "has" : "have"} no supplier yet (give ${picked.noSupplier.length === 1 ? "it" : "them"} one first)`,
      picked.nothingToOrder.length > 0 &&
        `there's enough of ${names(picked.nothingToOrder)} for now`,
      picked.notPlanned.length > 0 &&
        `${names(picked.notPlanned)} ${picked.notPlanned.length === 1 ? "is" : "are"} set not to be reordered`,
    ].filter(Boolean);
    return {
      error: `No order was drafted: ${why.join("; ") || "nothing ticked needs ordering"}.`,
    };
  }
  const { data, error } = await ctx.supabase.rpc("draft_purchase_orders", {
    p_tenant_id: ctx.tenant.id,
    p_request_key: requestKey(formData),
    p_orders: picked.orders.map(orderPayload),
  });
  const numbers = (data as number[] | null) ?? [];
  if (error || numbers.length === 0) return { error: OOPS };
  done(slug);
  const left = new URLSearchParams();
  if (picked.noSupplier.length > 0) left.set("nosupplier", String(picked.noSupplier.length));
  if (picked.nothingToOrder.length > 0) left.set("enough", String(picked.nothingToOrder.length));
  if (picked.notPlanned.length > 0) left.set("off", String(picked.notPlanned.length));
  if (numbers.length === 1) {
    left.set("drafted", "1");
    redirect(`/w/${slug}/stock/orders/${numbers[0]}?${left}`);
  }
  left.set("new", numbers.join("-"));
  redirect(`/w/${slug}/stock/orders?${left}`);
}

/**
 * Starts a draft order for one supplier from what's due. The quantities are
 * worked out again here, on the server, rather than trusted from the page.
 */
export async function startSuggestedOrder(
  slug: string,
  supplierId: string,
  formData: FormData,
): Promise<void> {
  const ctx = await context(slug);
  if ("error" in ctx) return;
  const { rows, today } = await loadStock(ctx.supabase, ctx.tenant);
  const draft = draftOrders(rows, today).find((order) => order.supplier.id === supplierId);
  if (!draft) return;
  const { data, error } = await ctx.supabase.rpc("draft_purchase_orders", {
    p_tenant_id: ctx.tenant.id,
    p_request_key: requestKey(formData),
    p_orders: [orderPayload(draft)],
  });
  const numbers = (data as number[] | null) ?? [];
  if (error || numbers.length === 0) return;
  done(slug);
  redirect(`/w/${slug}/stock/orders/${numbers[0]}?drafted=1`);
}

/**
 * Starts the order that has to land before a supplier shuts: everything of
 * theirs that would run short before they are back, sized to last until then.
 * Worked out again here, on the server, like every other draft.
 */
export async function startClosureOrder(
  slug: string,
  supplierId: string,
  formData: FormData,
): Promise<void> {
  const ctx = await context(slug);
  if ("error" in ctx) return;
  const { rows, today } = await loadStock(ctx.supabase, ctx.tenant);
  const draft = closureOrders(rows, today).find((order) => order.supplier.id === supplierId);
  if (!draft) return;
  const { data, error } = await ctx.supabase.rpc("draft_purchase_orders", {
    p_tenant_id: ctx.tenant.id,
    p_request_key: requestKey(formData),
    p_orders: [orderPayload(draft)],
  });
  const numbers = (data as number[] | null) ?? [];
  if (error || numbers.length === 0) return;
  done(slug);
  redirect(`/w/${slug}/stock/orders/${numbers[0]}?drafted=1`);
}

/** Writes down a stretch when a supplier is shut. */
export async function saveSupplierClosure(
  slug: string,
  supplierId: string,
  _prev: StockState,
  formData: FormData,
): Promise<StockState> {
  const ctx = await context(slug);
  if ("error" in ctx) return { error: ctx.error };
  if (!UUID.test(supplierId)) return { error: OOPS };
  const name = text(formData, "name").slice(0, 80);
  const from = text(formData, "starts_on");
  const to = text(formData, "ends_on");
  if (!name) return { error: "Give it a name, like “Spring Festival”." };
  if (dayNumber(from) === null || dayNumber(to) === null) {
    return { error: "Pick the first and the last day they're shut." };
  }
  const length = daysApart(from, to);
  if (length < 0) return { error: "The last day can't be before the first." };
  if (length > 366) return { error: "That's more than a year. Check the dates." };
  const { error } = await ctx.supabase.rpc("save_supplier_closure", {
    p_tenant_id: ctx.tenant.id,
    p_supplier_id: supplierId,
    p_closure_id: null,
    p_name: name,
    p_starts_on: from,
    p_ends_on: to,
  });
  if (error) {
    return {
      error: error.message.includes("too_many_closures")
        ? "That's the most closures we keep for one supplier. Take an old one off first."
        : OOPS,
    };
  }
  done(slug);
  return { message: "Saved. Order-by dates for their items now work around it." };
}

export async function removeSupplierClosure(slug: string, closureId: string): Promise<void> {
  const ctx = await context(slug);
  if ("error" in ctx || !UUID.test(closureId)) return;
  const { error } = await ctx.supabase.rpc("remove_supplier_closure", { p_closure_id: closureId });
  if (!error) done(slug);
}

/** Starts an empty draft for a supplier, to fill in by hand. */
export async function startEmptyOrder(
  slug: string,
  _prev: StockState,
  formData: FormData,
): Promise<StockState> {
  const ctx = await context(slug);
  if ("error" in ctx) return { error: ctx.error };
  const supplier = text(formData, "supplier");
  if (!UUID.test(supplier)) return { error: "Pick who the order is for." };
  const { data, error } = await ctx.supabase.rpc("draft_purchase_orders", {
    p_tenant_id: ctx.tenant.id,
    p_request_key: requestKey(formData),
    p_orders: [{ supplier_id: supplier, expected_on: "", lines: [] }],
  });
  const numbers = (data as number[] | null) ?? [];
  if (error || numbers.length === 0) return { error: OOPS };
  done(slug);
  redirect(`/w/${slug}/stock/orders/${numbers[0]}`);
}

/**
 * Saves an order: quantities, costs, the supplier's codes and notes per line,
 * plus shipping, tax, adjustments, the note and the expected date. Works on a
 * draft and on an order that has gone out, until it is closed.
 */
export async function saveOrder(
  slug: string,
  orderId: string,
  _prev: StockState,
  formData: FormData,
): Promise<StockState> {
  const ctx = await context(slug);
  if ("error" in ctx) return { error: ctx.error };
  const BAD = "Check the quantities and costs: one of them isn't a number we can use.";
  type Line = {
    stock_item_id: string;
    qty: number;
    unit_cost: string;
    supplier_sku: string;
    note: string;
  };
  const lines: Line[] = [];
  for (const [key, value] of formData.entries()) {
    if (!key.startsWith("qty_")) continue;
    const id = key.slice(4);
    if (!UUID.test(id)) continue;
    const raw = String(value).trim();
    const qty = raw === "" ? 0 : Number(raw);
    const cost = amount(text(formData, `cost_${id}`));
    if (!Number.isInteger(qty) || !(qty >= 0 && qty <= 1_000_000) || cost === null) {
      return { error: BAD };
    }
    if (qty > 0) {
      lines.push({
        stock_item_id: id,
        qty,
        unit_cost: cost,
        supplier_sku: text(formData, `ssku_${id}`).slice(0, 120),
        note: text(formData, `note_${id}`).slice(0, 500),
      });
    }
  }

  const add = text(formData, "add_item");
  if (UUID.test(add) && !lines.some((line) => line.stock_item_id === add)) {
    const typedQty = whole(formData, "add_qty");
    const typedCost = text(formData, "add_cost");
    if (typedQty !== null && !(typedQty >= 1 && typedQty <= 1_000_000)) {
      return { error: "How many of the new item?" };
    }
    // Left empty, "how many" starts at what the sales history suggests.
    const { rows } = await loadStock(ctx.supabase, ctx.tenant);
    const row = rows.find((r) => r.item.id === add);
    if (!row) return { error: "That item isn't in your stock any more." };
    const cost = typedCost === "" ? row.unitCost.toFixed(2) : amount(typedCost);
    if (cost === null) return { error: BAD };
    lines.push({
      stock_item_id: add,
      qty: typedQty ?? startingQty(row.suggestedQty, row.casePack, row.minimum),
      unit_cost: cost,
      supplier_sku: row.item.supplier_sku ?? "",
      note: "",
    });
  }

  const shipping = amount(text(formData, "shipping"));
  const taxText = text(formData, "tax");
  const tax = taxText === "" ? 0 : Number(taxText);
  if (shipping === null) return { error: "Shipping needs to be an amount, like 25.00." };
  if (!/^\d{0,3}(\.\d{0,3})?$/.test(taxText) || !(tax >= 0 && tax <= 100)) {
    return { error: "Tax is a percentage between 0 and 100." };
  }
  const adjustments: { label: string; amount: string }[] = [];
  for (let i = 0; i < 12; i++) {
    const label = text(formData, `adj_label_${i}`).slice(0, 80);
    const typed = text(formData, `adj_amount_${i}`);
    if (!label && !typed) continue;
    const value = typed === "" ? null : amount(typed, { negative: true });
    if (!label || value === null) {
      return {
        error: "Each adjustment needs a name and an amount (use a minus for money off).",
      };
    }
    if (value !== "0.00") adjustments.push({ label, amount: value });
  }

  const expected = text(formData, "expected");
  const { error } = await ctx.supabase.rpc("save_purchase_order", {
    p_po_id: orderId,
    p_lines: lines,
    p_notes: text(formData, "notes"),
    p_expected_on: DAY.test(expected) ? expected : null,
    p_shipping_cost: shipping,
    p_tax_rate_pct: taxText === "" ? "0" : taxText,
    p_adjustments: adjustments,
  });
  if (error) {
    return {
      error: error.message.includes("finished")
        ? "This order is finished."
        : error.message.includes("Add something")
          ? "An order that has gone out needs at least one line. To call it off, cancel it instead."
          : OOPS,
    };
  }
  done(slug);
  return { message: "Saved." };
}

/**
 * Adds tracking numbers to an order that's on its way, or changes one. A new
 * entry can carry several numbers, one to a line (or with commas), pasted as
 * a batch: each becomes its own parcel with the same carrier, date and note.
 * One the order already has is left as it is and named, as in TuftStock.
 */
export async function saveShipment(
  slug: string,
  orderId: string,
  shipmentId: string | null,
  _prev: StockState,
  formData: FormData,
): Promise<StockState> {
  const ctx = await context(slug);
  if ("error" in ctx) return { error: ctx.error };
  const typed = text(formData, "tracking");
  const numbers = shipmentId
    ? [tidyTracking(typed)]
    : [
        ...new Set(
          typed
            .split(/[\n,;]+/)
            .map(tidyTracking)
            .filter(Boolean),
        ),
      ];
  if (numbers.length === 0 || numbers.some((n) => n.length < 4)) {
    return { error: "Type the tracking number, or paste several with one on each line." };
  }
  if (numbers.length > 40) return { error: "That's a lot at once. Add up to 40 at a time." };
  const expected = text(formData, "expected");
  const arrived = text(formData, "arrived");
  const carrier = text(formData, "carrier").slice(0, 60);
  let already: string[] = [];
  if (!shipmentId && numbers.length > 1) {
    const { data: existing } = await ctx.supabase
      .from("purchase_order_shipments")
      .select("tracking")
      .eq("tenant_id", ctx.tenant.id)
      .eq("po_id", orderId)
      .is("removed_at", null);
    const have = new Set((existing ?? []).map((row) => row.tracking as string));
    already = numbers.filter((n) => have.has(n));
  }
  let added = 0;
  for (const tracking of numbers) {
    if (already.includes(tracking)) continue;
    const { error } = await ctx.supabase.rpc("save_po_shipment", {
      p_po_id: orderId,
      p_shipment_id: shipmentId,
      p_carrier: carrier || (guessCarrier(tracking) ?? ""),
      p_tracking: tracking,
      p_expected_on: DAY.test(expected) ? expected : null,
      p_arrived_on: DAY.test(arrived) ? arrived : null,
      p_note: text(formData, "note").slice(0, 300),
    });
    if (error) {
      if (added > 0) done(slug);
      return {
        error:
          error.code === "23505"
            ? "That tracking number is already on this order."
            : error.message.includes("been sent")
              ? "Tracking is for orders you've sent."
              : numbers.length > 1
                ? `${tracking} couldn't be added${added > 0 ? ` (the ${plural(added, "number")} before it ${added === 1 ? "was" : "were"})` : ""}. Check it and try again.`
                : OOPS,
      };
    }
    added += 1;
  }
  done(slug);
  if (shipmentId) return { message: "Saved." };
  const skipped =
    already.length > 0
      ? ` ${already.join(", ")} ${already.length === 1 ? "was" : "were"} already on this order.`
      : "";
  return {
    message:
      numbers.length === 1
        ? "Tracking added."
        : `${plural(added, "tracking number")} added.${skipped} Say what's in each one below.`,
  };
}

/** Marks a parcel as here today (it still needs checking in), or takes the number off. */
export async function updateShipment(
  slug: string,
  orderId: string,
  shipmentId: string,
  what: "arrived" | "not_arrived" | "remove",
  _prev: StockState,
  _formData: FormData,
): Promise<StockState> {
  const ctx = await context(slug);
  if ("error" in ctx) return { error: ctx.error };
  if (what === "remove") {
    const { error } = await ctx.supabase.rpc("remove_po_shipment", { p_shipment_id: shipmentId });
    if (error) return { error: OOPS };
    done(slug);
    return {};
  }
  const { data: row } = await ctx.supabase
    .from("purchase_order_shipments")
    .select("carrier, tracking, expected_on, note")
    .eq("tenant_id", ctx.tenant.id)
    .eq("po_id", orderId)
    .eq("id", shipmentId)
    .is("removed_at", null)
    .maybeSingle();
  if (!row) return { error: OOPS };
  const { error } = await ctx.supabase.rpc("save_po_shipment", {
    p_po_id: orderId,
    p_shipment_id: shipmentId,
    p_carrier: row.carrier,
    p_tracking: row.tracking,
    p_expected_on: row.expected_on,
    p_arrived_on: what === "arrived" ? localDay(new Date(), ctx.tenant.timezone) : null,
    p_note: row.note,
  });
  if (error) return { error: OOPS };
  done(slug);
  return {};
}

/** "Check now": asks the worker to look one UPS parcel up at its next turn. */
export async function checkShipmentNow(
  slug: string,
  shipmentId: string,
  _prev: StockState,
  _formData: FormData,
): Promise<StockState> {
  const ctx = await context(slug);
  if ("error" in ctx) return { error: ctx.error };
  const { error } = await ctx.supabase.rpc("request_po_shipment_check", {
    p_shipment_id: shipmentId,
  });
  if (error) {
    const why = error.message;
    return {
      error: why.includes("too_soon")
        ? "We asked UPS about this one a few minutes ago. Give it a little while."
        : why.includes("no_ups")
          ? "Connect your own UPS account under Connections first."
          : why.includes("not_ups")
            ? "Only UPS numbers can be checked for you."
            : OOPS,
    };
  }
  done(slug);
  return { message: "Asking UPS now. Refresh in a minute to see what it says." };
}

/**
 * "Ask UPS about all of them": asks the worker to look every travelling UPS
 * parcel up at its next turn. Ones asked about in the last ten minutes are
 * left alone, as with "Check now".
 */
export async function checkAllShipments(
  slug: string,
  _prev: StockState,
  _formData: FormData,
): Promise<StockState> {
  const ctx = await context(slug);
  if ("error" in ctx) return { error: ctx.error };
  const { data } = await ctx.supabase
    .from("purchase_order_shipments")
    .select("id, tracking, purchase_orders!inner(status)")
    .eq("tenant_id", ctx.tenant.id)
    .is("removed_at", null)
    .is("arrived_on", null)
    .like("tracking", "1Z%")
    .in("purchase_orders.status", ["ordered", "partial"])
    .limit(100);
  let asked = 0;
  let noUps = false;
  for (const row of data ?? []) {
    const { error } = await ctx.supabase.rpc("request_po_shipment_check", {
      p_shipment_id: row.id as string,
    });
    if (!error) asked += 1;
    else if (error.message.includes("no_ups")) noUps = true;
  }
  if (noUps) return { error: "Connect your own UPS account under Connections first." };
  done(slug);
  return {
    message:
      asked > 0
        ? `Asking UPS about ${plural(asked, "parcel")}. Refresh in a minute to see what it says.`
        : "Nothing new to ask: UPS was asked about these a few minutes ago.",
  };
}

/** Says which of the order's lines are in a parcel, and how many of each. */
export async function saveShipmentItems(
  slug: string,
  shipmentId: string,
  _prev: StockState,
  formData: FormData,
): Promise<StockState> {
  const ctx = await context(slug);
  if ("error" in ctx) return { error: ctx.error };
  const items: { line_id: string; quantity: number }[] = [];
  for (const [name, value] of formData.entries()) {
    if (!name.startsWith("qty_")) continue;
    const lineId = name.slice(4);
    const typed = String(value).trim();
    if (typed === "" || typed === "0") continue;
    const quantity = Number.parseInt(typed, 10);
    if (!UUID.test(lineId) || !/^\d{1,7}$/.test(typed) || quantity < 1 || quantity > 1_000_000) {
      return { error: "Type how many of each are in this parcel, as whole numbers." };
    }
    items.push({ line_id: lineId, quantity });
  }
  const { error } = await ctx.supabase.rpc("set_po_shipment_items", {
    p_shipment_id: shipmentId,
    p_items: items,
  });
  if (error) return { error: OOPS };
  done(slug);
  return { message: items.length > 0 ? "Saved." : "Cleared." };
}

export async function setOrderStatus(
  slug: string,
  orderId: string,
  status: "ordered" | "closed" | "cancelled" | "draft",
  _prev: StockState,
  _formData: FormData,
): Promise<StockState> {
  const ctx = await context(slug);
  if ("error" in ctx) return { error: ctx.error };
  const { error } = await ctx.supabase.rpc("set_purchase_order_status", {
    p_po_id: orderId,
    p_status: status,
  });
  if (error) {
    return {
      error: error.message.includes("Add something")
        ? "Add at least one item before sending the order."
        : "That change isn't possible from here.",
    };
  }
  done(slug);
  return {};
}

/** Gives an order a name of your own in place of the one it was given. */
export async function renameOrder(
  slug: string,
  orderId: string,
  _prev: StockState,
  formData: FormData,
): Promise<StockState> {
  const ctx = await context(slug);
  if ("error" in ctx) return { error: ctx.error };
  const reference = text(formData, "reference").replace(/\s+/g, " ");
  if (reference.length < 3 || reference.length > 40) {
    return { error: "A reference is 3 to 40 characters." };
  }
  const { error } = await ctx.supabase.rpc("rename_purchase_order", {
    p_po_id: orderId,
    p_reference: reference,
  });
  if (error) {
    const why = error.message;
    return {
      error:
        error.code === "23505" || why.includes("reference_taken")
          ? "Another order already has that reference."
          : why.includes("bad_reference")
            ? "Use letters, numbers, spaces and . _ / # - only, starting with a letter or number."
            : why.includes("finished_order")
              ? "A finished order keeps the reference it had."
              : OOPS,
    };
  }
  done(slug);
  return { message: "Renamed." };
}

/** Puts a finished order (or an unused draft) away, or brings it back. */
export async function archiveOrder(
  slug: string,
  orderId: string,
  archived: boolean,
  _prev: StockState,
  _formData: FormData,
): Promise<StockState> {
  const ctx = await context(slug);
  if ("error" in ctx) return { error: ctx.error };
  const { error } = await ctx.supabase.rpc("archive_purchase_order", {
    p_po_id: orderId,
    p_archived: archived,
  });
  if (error) {
    return {
      error: error.message.includes("still_open")
        ? "This order is still on its way. Close or cancel it first, then put it away."
        : OOPS,
    };
  }
  done(slug);
  return {};
}

/** Deletes a draft that was never sent or emailed. There is no undo. */
export async function deleteDraftOrder(
  slug: string,
  orderId: string,
  _prev: StockState,
  _formData: FormData,
): Promise<StockState> {
  const ctx = await context(slug);
  if ("error" in ctx) return { error: ctx.error };
  const { error } = await ctx.supabase.rpc("delete_draft_purchase_order", { p_po_id: orderId });
  if (error) {
    const why = error.message;
    return {
      error: why.includes("has_history")
        ? "This draft has been emailed or had stock checked in, so it's kept. Cancel it or put it away instead."
        : why.includes("not_a_draft")
          ? "Only a draft can be deleted."
          : OOPS,
    };
  }
  done(slug);
  redirect(`/w/${slug}/stock/orders?gone=1`);
}

/**
 * Checks in what arrived. Anyone on the team can; each line's box says how
 * many. The whole delivery goes in one step under the page's request key, so
 * a second press of the button finds the first press's delivery instead of
 * counting the boxes twice.
 */
export async function receiveDelivery(
  slug: string,
  orderId: string,
  _prev: StockState,
  formData: FormData,
): Promise<StockState> {
  const ctx = await context(slug, false);
  if ("error" in ctx) return { error: ctx.error };
  if (!UUID.test(orderId)) return { error: OOPS };
  const arrived: { line_id: string; quantity: number }[] = [];
  for (const [key, value] of formData.entries()) {
    if (!key.startsWith("got_")) continue;
    const id = key.slice(4);
    const raw = String(value).trim();
    if (!UUID.test(id) || raw === "" || raw === "0") continue;
    const qty = Number(raw);
    if (!Number.isInteger(qty) || !(qty >= 1 && qty <= 1_000_000)) {
      return { error: "One of those amounts isn't right." };
    }
    arrived.push({ line_id: id, quantity: qty });
  }
  if (arrived.length === 0) return { error: "Type how many arrived next to at least one item." };
  const push = formData.get("push") === "on";
  const { data, error } = await ctx.supabase.rpc("receive_delivery", {
    p_po_id: orderId,
    p_request_key: requestKey(formData),
    p_lines: arrived,
    p_push: push,
  });
  if (error) {
    done(slug);
    return {
      error: error.message.includes("isn't waiting")
        ? "This order isn't waiting on a delivery any more."
        : "Nothing was checked in. Please look over the amounts and try again.",
    };
  }
  const result = (data as { units: number; repeated: boolean }[] | null)?.[0];
  const units = result?.units ?? 0;
  done(slug);
  if (result?.repeated) {
    return {
      message: `That delivery is already checked in (${plural(units, "unit")}), so nothing was counted twice.`,
    };
  }
  return {
    message: `${plural(units, "unit")} checked in.${push ? " Your shop's count will update in a minute." : ""}`,
  };
}

/**
 * "Try the shop again" for a delivery the shop turned down. Owners and admins
 * only. It queues one new try; the database refuses anything that is already
 * waiting, already in the shop, or that we can't be sure the shop didn't take.
 */
export async function retryShopCount(
  slug: string,
  receiptId: string,
  _prev: StockState,
  _formData: FormData,
): Promise<StockState> {
  const ctx = await context(slug);
  if ("error" in ctx) return { error: ctx.error };
  if (!UUID.test(receiptId)) return { error: OOPS };
  const { data: shop } = await ctx.supabase
    .from("connections")
    .select("status, scopes")
    .eq("tenant_id", ctx.tenant.id)
    .eq("provider", "shopify")
    .maybeSingle();
  if (shop?.status !== "active" || !canWriteShopifyStock(shop.scopes)) {
    return {
      error:
        "Your shop isn't letting us add to its count right now. Check Connections, or add this delivery in your shop by hand.",
    };
  }
  const { error } = await ctx.supabase.rpc("retry_stock_receipt", { p_receipt_id: receiptId });
  if (error) {
    done(slug);
    return {
      error: error.message.includes("can't tell")
        ? "We can't tell whether your shop added this one, so we won't send it again. Check the count in your shop and fix it there."
        : error.message.includes("another try")
          ? "This one is already on its way to your shop, or already there."
          : OOPS,
    };
  }
  done(slug);
  return { message: "We're asking your shop again. Give it a minute." };
}

export async function saveStockSettings(
  slug: string,
  _prev: StockState,
  formData: FormData,
): Promise<StockState> {
  const ctx = await context(slug);
  if ("error" in ctx) return { error: ctx.error };
  const parsed = stockSettingsSchema.safeParse({
    version: 1,
    default_lead_time_days: whole(formData, "lead"),
    default_coverage_days: whole(formData, "cover"),
    review_buffer_days: whole(formData, "review"),
    seasonality: formData.get("seasonality") === "on",
    push_to_shop: formData.get("push_to_shop") === "on",
    skip_words: [
      ...new Set(
        text(formData, "skip_words")
          .split(/[\n,]+/)
          .map((word) => word.trim().toLowerCase())
          .filter(Boolean),
      ),
    ],
    skip_tags: [
      ...new Set(
        text(formData, "skip_tags")
          .split(/[\n,]+/)
          .map((tag) => tag.trim().toLowerCase())
          .filter(Boolean),
      ),
    ],
  });
  if (!parsed.success) {
    return {
      error:
        "Check the numbers (each is a whole number of days), the words (up to 20, each 2 to 40 letters) and the tags (up to 20).",
    };
  }
  const { error } = await ctx.supabase.rpc("save_config", {
    p_tenant_id: ctx.tenant.id,
    p_module: STOCK_MODULE,
    p_key: STOCK_SETTINGS_KEY,
    p_body: parsed.data,
  });
  if (error) return { error: OOPS };
  done(slug);
  return { message: "Saved." };
}

async function readSavedViews(ctx: {
  supabase: Awaited<ReturnType<typeof createClient>>;
  tenant: { id: string };
}) {
  const { data } = await ctx.supabase
    .from("configs")
    .select("body")
    .eq("tenant_id", ctx.tenant.id)
    .eq("module", STOCK_MODULE)
    .eq("key", STOCK_VIEWS_KEY)
    .maybeSingle();
  return parseSavedViews(data?.body).views;
}

/**
 * Keeps the reorder list as it stands (view, search, order, columns) under a
 * name, for the whole workspace. The same name again replaces that view.
 */
export async function saveStockView(
  slug: string,
  _prev: StockState,
  formData: FormData,
): Promise<StockState> {
  const ctx = await context(slug);
  if ("error" in ctx) return { error: ctx.error };
  const name = text(formData, "name").slice(0, 40);
  if (!name) return { error: "Give the view a name." };
  const show = text(formData, "show");
  const sort = text(formData, "sort");
  const views = await readSavedViews(ctx);
  const same = views.find((view) => view.name.toLowerCase() === name.toLowerCase());
  if (!same && views.length >= MAX_SAVED_VIEWS) {
    return { error: `That's the most views we keep (${MAX_SAVED_VIEWS}). Take one off first.` };
  }
  const opensFirst = formData.get("opens_first") === "on";
  const id = same?.id ?? crypto.randomUUID().replace(/-/g, "").slice(0, 10);
  const parsed = savedViewsSchema.safeParse({
    version: 1,
    views: [
      ...views
        .filter((view) => view.id !== id)
        .map((view) => (opensFirst ? { ...view, opens_first: false } : view)),
      {
        id,
        name,
        view: isViewKey(show) ? show : "all",
        q: text(formData, "q").slice(0, 80),
        sort: isColumnKey(sort) ? sort : "orderBy",
        dir: text(formData, "dir") === "desc" ? "desc" : "asc",
        columns: text(formData, "columns").split(",").filter(isColumnKey),
        opens_first: opensFirst,
      },
    ],
  });
  if (!parsed.success) return { error: OOPS };
  const { error } = await ctx.supabase.rpc("save_config", {
    p_tenant_id: ctx.tenant.id,
    p_module: STOCK_MODULE,
    p_key: STOCK_VIEWS_KEY,
    p_body: parsed.data,
  });
  if (error) return { error: OOPS };
  done(slug);
  redirect(`/w/${slug}/stock/items?saved=${id}`);
}

/** Takes a saved view off the list. The items themselves are untouched. */
export async function removeStockView(slug: string, viewId: string): Promise<void> {
  const ctx = await context(slug);
  if ("error" in ctx) return;
  const views = await readSavedViews(ctx);
  if (!views.some((view) => view.id === viewId)) return;
  const { error } = await ctx.supabase.rpc("save_config", {
    p_tenant_id: ctx.tenant.id,
    p_module: STOCK_MODULE,
    p_key: STOCK_VIEWS_KEY,
    p_body: { version: 1, views: views.filter((view) => view.id !== viewId) },
  });
  if (error) return;
  done(slug);
  redirect(`/w/${slug}/stock/items?show=all`);
}

async function readSeasons(ctx: {
  supabase: Awaited<ReturnType<typeof createClient>>;
  tenant: { id: string };
}) {
  const { data } = await ctx.supabase
    .from("configs")
    .select("body")
    .eq("tenant_id", ctx.tenant.id)
    .eq("module", STOCK_MODULE)
    .eq("key", STOCK_SEASONS_KEY)
    .maybeSingle();
  return parseSeasons(data?.body).seasons;
}

async function writeSeasons(
  ctx: { supabase: Awaited<ReturnType<typeof createClient>>; tenant: { id: string } },
  seasons: SeasonConfig[],
) {
  const parsed = seasonsSchema.safeParse({ version: 1, seasons });
  if (!parsed.success) return false;
  const { error } = await ctx.supabase.rpc("save_config", {
    p_tenant_id: ctx.tenant.id,
    p_module: STOCK_MODULE,
    p_key: STOCK_SEASONS_KEY,
    p_body: parsed.data,
  });
  return !error;
}

/**
 * Adds a selling season to plan ahead for, or changes one: a name, the day
 * the stock should be on the shelf by, an optional lift and a note.
 */
export async function saveSeason(
  slug: string,
  seasonId: string | null,
  _prev: StockState,
  formData: FormData,
): Promise<StockState> {
  const ctx = await context(slug);
  if ("error" in ctx) return { error: ctx.error };
  const name = text(formData, "name").slice(0, 80);
  const day = text(formData, "in_stock_by");
  const typedLift = text(formData, "lift_pct");
  const lift = typedLift === "" ? 0 : Number(typedLift);
  if (!name) return { error: "Give the season a name, like “Holiday rush”." };
  if (dayNumber(day) === null) return { error: "Pick the day you want the stock on the shelf by." };
  if (!/^\d{0,3}$/.test(typedLift) || !(lift >= 0 && lift <= 500)) {
    return { error: "The lift is a whole percent from 0 to 500. Leave it empty for none." };
  }
  const seasons = await readSeasons(ctx);
  const existing = seasonId ? seasons.find((season) => season.id === seasonId) : undefined;
  if (seasonId && !existing) return { error: OOPS };
  if (!existing && seasons.length >= MAX_SEASONS) {
    return {
      error: `That's the most seasons we keep (${MAX_SEASONS}). Take a past one off first.`,
    };
  }
  const season: SeasonConfig = {
    id: existing?.id ?? crypto.randomUUID().replace(/-/g, "").slice(0, 10),
    name,
    in_stock_by: day,
    lift_pct: lift,
    note: text(formData, "note").slice(0, 300),
    card: existing?.card ?? "open",
  };
  const ok = await writeSeasons(ctx, [
    ...seasons.filter((entry) => entry.id !== season.id),
    season,
  ]);
  if (!ok) return { error: OOPS };
  done(slug);
  return {
    message: existing
      ? "Saved."
      : lift > 0
        ? "Added. Suggestions for that month are raised, and the order-by dates are on “To order”."
        : "Added. You'll find its order-by dates on “To order”.",
  };
}

/** Takes a season off. Suggestions go back to what the sales history says. */
export async function removeSeason(slug: string, seasonId: string): Promise<void> {
  const ctx = await context(slug);
  if ("error" in ctx) return;
  const seasons = await readSeasons(ctx);
  if (!seasons.some((season) => season.id === seasonId)) return;
  if (
    await writeSeasons(
      ctx,
      seasons.filter((season) => season.id !== seasonId),
    )
  )
    done(slug);
}

/**
 * Folds a season's card to one line, opens it again, or puts it away. Kept
 * with the season, so it looks the same on every device. "show_all" brings
 * back every card that was put away.
 */
export async function setSeasonCard(
  slug: string,
  seasonId: string | null,
  card: "open" | "folded" | "hidden" | "show_all",
): Promise<void> {
  const ctx = await context(slug);
  if ("error" in ctx) return;
  const seasons = await readSeasons(ctx);
  const next =
    card === "show_all"
      ? seasons.map((season) =>
          season.card === "hidden" ? { ...season, card: "open" as const } : season,
        )
      : seasons.map((season) => (season.id === seasonId ? { ...season, card } : season));
  if (await writeSeasons(ctx, next)) done(slug);
}

/**
 * Drafts one order for a supplier's items that share a lead time, from a
 * season's card. The amounts are today's suggestions, already raised for the
 * season, worked out again here on the server.
 */
export async function startSeasonOrder(
  slug: string,
  supplierId: string,
  leadDays: number,
  formData: FormData,
): Promise<void> {
  const ctx = await context(slug);
  if ("error" in ctx || !UUID.test(supplierId)) return;
  const { rows, today } = await loadStock(ctx.supabase, ctx.tenant);
  const items = seasonGroupItems(rows, supplierId, leadDays).map((row) => row.item.id);
  const picked = draftOrdersForItems(rows, items, today);
  if (picked.orders.length === 0) return;
  const { data, error } = await ctx.supabase.rpc("draft_purchase_orders", {
    p_tenant_id: ctx.tenant.id,
    p_request_key: requestKey(formData),
    p_orders: picked.orders.map(orderPayload),
  });
  const numbers = (data as number[] | null) ?? [];
  if (error || numbers.length === 0) return;
  done(slug);
  redirect(`/w/${slug}/stock/orders/${numbers[0]}?drafted=1`);
}
