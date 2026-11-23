"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { getEntitlements } from "@/lib/entitlements";
import { localDay } from "@/lib/bookings/slots";
import { guessCarrier, tidyTracking } from "@/lib/shipping/carriers";
import { Money } from "@/lib/stock/balance/money";
import { STOCK_MODULE, STOCK_SETTINGS_KEY, stockSettingsSchema } from "@/lib/stock/config";
import { startingQty } from "@/lib/stock/engine";
import { draftOrders, draftOrdersForItems, type DraftOrder, type StockRow } from "@/lib/stock/plan";
import { createClient } from "@/lib/supabase/server";
import { canManage, getTenantContext } from "@/lib/tenants";
import { loadStock } from "./data";

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
  if (lead === null || !(lead >= 0 && lead <= 365)) {
    return { error: "How many days from ordering to arriving? (0 to 365)" };
  }
  if (cover === null || !(cover >= 1 && cover <= 365)) {
    return { error: "How many days of sales should one order cover? (1 to 365)" };
  }
  if (!(moq >= 1 && moq <= 1_000_000)) return { error: "The smallest order is at least 1." };
  const { error } = await ctx.supabase.rpc("save_supplier", {
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
  done(slug);
  return { message: supplierId ? "Saved." : `${name} is added.` };
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
        message: `${plural(n, "item")} won't be reordered. You'll find ${n === 1 ? "it" : "them"} under “Not reordering”.`,
      };
    }
    return {
      message:
        n === 0
          ? "Nothing changed: those are left out by your shop or by a rule in Settings, not by you."
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

/** Adds a tracking number to an order that's on its way, or changes one. */
export async function saveShipment(
  slug: string,
  orderId: string,
  shipmentId: string | null,
  _prev: StockState,
  formData: FormData,
): Promise<StockState> {
  const ctx = await context(slug);
  if ("error" in ctx) return { error: ctx.error };
  const tracking = tidyTracking(text(formData, "tracking"));
  if (tracking.length < 4) return { error: "Type the tracking number." };
  const expected = text(formData, "expected");
  const arrived = text(formData, "arrived");
  const { error } = await ctx.supabase.rpc("save_po_shipment", {
    p_po_id: orderId,
    p_shipment_id: shipmentId,
    p_carrier: text(formData, "carrier").slice(0, 60) || (guessCarrier(tracking) ?? ""),
    p_tracking: tracking,
    p_expected_on: DAY.test(expected) ? expected : null,
    p_arrived_on: DAY.test(arrived) ? arrived : null,
    p_note: text(formData, "note").slice(0, 300),
  });
  if (error) {
    return {
      error:
        error.code === "23505"
          ? "That tracking number is already on this order."
          : error.message.includes("been sent")
            ? "Tracking is for orders you've sent."
            : OOPS,
    };
  }
  done(slug);
  return { message: shipmentId ? "Saved." : "Tracking added." };
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

/** Checks in what arrived. Anyone on the team can; each line's box says how many. */
export async function receiveDelivery(
  slug: string,
  orderId: string,
  _prev: StockState,
  formData: FormData,
): Promise<StockState> {
  const ctx = await context(slug, false);
  if ("error" in ctx) return { error: ctx.error };
  const { data: lines } = await ctx.supabase
    .from("purchase_order_lines")
    .select("id, qty_ordered, qty_received")
    .eq("po_id", orderId)
    .eq("tenant_id", ctx.tenant.id);
  const push = formData.get("push") === "on";
  let boxes = 0;
  let units = 0;
  for (const line of lines ?? []) {
    const qty = whole(formData, `got_${line.id}`);
    if (qty === null || qty === 0) continue;
    if (!(qty >= 1 && qty <= 1_000_000)) return { error: "One of those amounts isn't right." };
    const { error } = await ctx.supabase.rpc("receive_po_line", {
      p_line_id: line.id,
      p_quantity: qty,
      p_push: push,
    });
    if (error) {
      done(slug);
      return {
        error: `${units ? `${units} units were checked in, then something went wrong. ` : ""}Please look over the order and try the rest again.`,
      };
    }
    boxes += 1;
    units += qty;
  }
  if (boxes === 0) return { error: "Type how many arrived next to at least one item." };
  done(slug);
  return {
    message: `${units} unit${units === 1 ? "" : "s"} checked in.${push ? " Your shop's count will update in a minute." : ""}`,
  };
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
  });
  if (!parsed.success) {
    return {
      error:
        "Check the numbers (each is a whole number of days) and the words: up to 20, each 2 to 40 letters.",
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
