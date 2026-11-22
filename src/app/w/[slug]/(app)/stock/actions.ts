"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { getEntitlements } from "@/lib/entitlements";
import { STOCK_MODULE, STOCK_SETTINGS_KEY, stockSettingsSchema } from "@/lib/stock/config";
import { draftOrders } from "@/lib/stock/plan";
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

/** Gives the ticked items a supplier (or takes it away). */
export async function assignSupplier(
  slug: string,
  _prev: StockState,
  formData: FormData,
): Promise<StockState> {
  const ctx = await context(slug);
  if ("error" in ctx) return { error: ctx.error };
  const ids = formData
    .getAll("item")
    .map(String)
    .filter((id) => UUID.test(id));
  const supplier = text(formData, "supplier");
  if (ids.length === 0) return { error: "Tick the items first." };
  if (supplier !== "" && !UUID.test(supplier)) return { error: "Pick a supplier." };
  const { data, error } = await ctx.supabase.rpc("assign_stock_supplier", {
    p_tenant_id: ctx.tenant.id,
    p_item_ids: ids,
    p_supplier_id: supplier || null,
  });
  if (error) return { error: OOPS };
  done(slug);
  const n = (data as number) ?? 0;
  return { message: `${n} item${n === 1 ? "" : "s"} updated.` };
}

/** Saves one item's own planning. Empty lead time or cover means "use the supplier's". */
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
  const supplier = text(formData, "supplier");
  if (lead !== null && !(lead >= 0 && lead <= 365)) return { error: "Lead time is 0 to 365 days." };
  if (cover !== null && !(cover >= 1 && cover <= 365)) return { error: "Cover is 1 to 365 days." };
  if (!(safety >= 0 && safety <= 1_000_000)) return { error: "Spare stock can't be negative." };
  const { error } = await ctx.supabase.rpc("plan_stock_items", {
    p_tenant_id: ctx.tenant.id,
    p_item_ids: [itemId],
    p_supplier_id: UUID.test(supplier) ? supplier : null,
    p_lead_time_days: lead,
    p_coverage_days: cover,
    p_safety_stock: safety,
    p_hidden: formData.get("hidden") === "on",
  });
  if (error) return { error: OOPS };
  done(slug);
  return { message: "Saved." };
}

/**
 * Starts a draft order for one supplier from what's due. The quantities are
 * worked out again here, on the server, rather than trusted from the page.
 */
export async function startSuggestedOrder(slug: string, supplierId: string): Promise<void> {
  const ctx = await context(slug);
  if ("error" in ctx) return;
  const { rows, today } = await loadStock(ctx.supabase, ctx.tenant);
  const draft = draftOrders(rows, today).find((order) => order.supplier.id === supplierId);
  if (!draft) return;
  const { data, error } = await ctx.supabase.rpc("create_purchase_order", {
    p_tenant_id: ctx.tenant.id,
    p_supplier_id: supplierId,
    p_lines: draft.lines.map((line) => ({
      stock_item_id: line.stock_item_id,
      qty: line.qty,
      unit_cost: line.unit_cost,
    })),
    p_notes: "",
  });
  if (error) return;
  const { data: created } = await ctx.supabase
    .from("purchase_orders")
    .select("id")
    .eq("tenant_id", ctx.tenant.id)
    .eq("number", data as number)
    .maybeSingle();
  if (created) {
    await ctx.supabase.rpc("update_purchase_order", {
      p_po_id: created.id,
      p_lines: draft.lines.map((line) => ({
        stock_item_id: line.stock_item_id,
        qty: line.qty,
        unit_cost: line.unit_cost,
      })),
      p_notes: "",
      p_expected_on: draft.expectedOn,
    });
  }
  done(slug);
  redirect(`/w/${slug}/stock/orders/${data as number}`);
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
  const { data, error } = await ctx.supabase.rpc("create_purchase_order", {
    p_tenant_id: ctx.tenant.id,
    p_supplier_id: supplier,
    p_lines: [],
    p_notes: "",
  });
  if (error) return { error: OOPS };
  done(slug);
  redirect(`/w/${slug}/stock/orders/${data as number}`);
}

/** Saves a draft's quantities and costs, plus the note and expected date. */
export async function saveOrder(
  slug: string,
  orderId: string,
  _prev: StockState,
  formData: FormData,
): Promise<StockState> {
  const ctx = await context(slug);
  if ("error" in ctx) return { error: ctx.error };
  const lines: { stock_item_id: string; qty: number; unit_cost: number }[] = [];
  for (const [key, value] of formData.entries()) {
    if (!key.startsWith("qty_")) continue;
    const id = key.slice(4);
    const qty = Number.parseInt(String(value) || "0", 10);
    const cost = Number.parseFloat(text(formData, `cost_${id}`) || "0");
    if (!UUID.test(id)) continue;
    if (!(qty >= 0 && qty <= 1_000_000) || !(cost >= 0 && cost <= 10_000_000)) {
      return { error: "Check the quantities and costs: one of them isn't a number we can use." };
    }
    if (qty > 0) lines.push({ stock_item_id: id, qty, unit_cost: cost });
  }
  const add = text(formData, "add_item");
  const addQty = whole(formData, "add_qty");
  if (UUID.test(add)) {
    if (!(addQty !== null && addQty >= 1 && addQty <= 1_000_000)) {
      return { error: "How many of the new item?" };
    }
    if (!lines.some((line) => line.stock_item_id === add)) {
      lines.push({
        stock_item_id: add,
        qty: addQty,
        unit_cost: Number.parseFloat(text(formData, "add_cost") || "0") || 0,
      });
    }
  }
  const expected = text(formData, "expected");
  const { error } = await ctx.supabase.rpc("update_purchase_order", {
    p_po_id: orderId,
    p_lines: lines,
    p_notes: text(formData, "notes"),
    p_expected_on: /^\d{4}-\d{2}-\d{2}$/.test(expected) ? expected : null,
  });
  if (error)
    return { error: error.message.includes("finished") ? "This order is finished." : OOPS };
  done(slug);
  return { message: "Saved." };
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
  });
  if (!parsed.success)
    return { error: "Check the numbers: each needs to be a whole number of days." };
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
