"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth";
import { BUDGET_KEY, budgetSettingsSchema } from "@/lib/bookings/budget";
import { BOOKINGS_MODULE } from "@/lib/bookings/config";
import { getEntitlements } from "@/lib/entitlements";
import { createClient } from "@/lib/supabase/server";
import { canManage, getTenantContext } from "@/lib/tenants";
import type { BookingsState } from "./actions";

/**
 * Classroom supplies, vendors and the budget: every change is an owner's or
 * admin's, through the database's own functions, which check that again.
 */

const NO_ACCESS = "Bookings aren't part of this workspace's plan right now.";
const NOT_ALLOWED = "Only owners and admins can change this.";
const READ_ONLY =
  "This workspace is read-only because its plan has ended. Pick a plan to make changes.";
const OOPS = "That didn't save. Please try again.";

async function context(slug: string) {
  const user = await requireUser(`/w/${slug}/bookings/supplies`);
  const ctx = await getTenantContext(slug, user.id);
  if (!ctx) return { error: NO_ACCESS } as const;
  const entitlements = await getEntitlements(ctx.tenant.id);
  if (!entitlements.can("module.bookings")) return { error: NO_ACCESS } as const;
  if (!entitlements.canWrite) return { error: READ_ONLY } as const;
  if (!canManage(ctx.role)) return { error: NOT_ALLOWED } as const;
  return { tenant: ctx.tenant, supabase: await createClient() } as const;
}

const text = (formData: FormData, name: string, max = 2000) =>
  String(formData.get(name) ?? "")
    .trim()
    .slice(0, max);
/** A plain number from a box, or null when it isn't one. */
const num = (formData: FormData, name: string): number | null => {
  const raw = text(formData, name).replace(/,/g, "");
  if (raw === "") return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
};
/** "$12.50" or "12.5" as whole cents, or null. */
const cents = (formData: FormData, name: string): number | null => {
  const raw = text(formData, name).replace(/[$,\s]/g, "");
  if (raw === "") return null;
  if (!/^\d+(\.\d{0,2})?$/.test(raw)) return null;
  return Math.round(Number(raw) * 100);
};
const day = (formData: FormData, name: string) => {
  const value = text(formData, name);
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
};
const month = (formData: FormData, name: string) => {
  const value = text(formData, name);
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(value) ? `${value}-01` : null;
};

function done(slug: string, message: string): BookingsState {
  revalidatePath(`/w/${slug}/bookings`, "layout");
  return { message };
}

// ---------------------------------------------------------------------------
// Vendors
// ---------------------------------------------------------------------------

export async function saveVendor(
  slug: string,
  vendorId: string | null,
  _prev: BookingsState,
  formData: FormData,
): Promise<BookingsState> {
  const ctx = await context(slug);
  if ("error" in ctx) return { error: ctx.error };
  const name = text(formData, "name", 120);
  const website = text(formData, "website", 300);
  if (!name) return { error: "Give the vendor a name." };
  if (website && !/^https:\/\//.test(website)) {
    return { error: "A website needs to start with https://." };
  }
  const { error } = await ctx.supabase.rpc("save_class_vendor", {
    p_tenant_id: ctx.tenant.id,
    p_id: vendorId,
    p_name: name,
    p_email: text(formData, "email", 200),
    p_website: website,
    p_note: text(formData, "note"),
  });
  if (error) {
    return {
      error: error.message.includes("duplicate")
        ? "There's already a vendor with that name."
        : OOPS,
    };
  }
  return done(slug, vendorId ? "Saved." : `${name} is added.`);
}

export async function deleteVendor(
  slug: string,
  vendorId: string,
  _prev: BookingsState,
  _formData: FormData,
): Promise<BookingsState> {
  const ctx = await context(slug);
  if ("error" in ctx) return { error: ctx.error };
  const { error } = await ctx.supabase.rpc("delete_class_vendor", {
    p_tenant_id: ctx.tenant.id,
    p_id: vendorId,
  });
  if (error) return { error: OOPS };
  return done(slug, "Removed. Its supplies are kept, with no vendor.");
}

// ---------------------------------------------------------------------------
// Supplies
// ---------------------------------------------------------------------------

export async function saveSupply(
  slug: string,
  supplyId: string | null,
  _prev: BookingsState,
  formData: FormData,
): Promise<BookingsState> {
  const ctx = await context(slug);
  if ("error" in ctx) return { error: ctx.error };
  const name = text(formData, "name", 120);
  if (!name) return { error: "Give the supply a name." };
  const perStudent = num(formData, "per_student");
  const lead = num(formData, "lead_time_days");
  const safety = num(formData, "safety_stock");
  const coverage = num(formData, "coverage_days");
  const unitCost = cents(formData, "unit_cost");
  const count = num(formData, "count");
  if (perStudent === null || perStudent < 0) return { error: "Say how much one person uses." };
  if (lead === null || lead < 0 || lead > 365 || !Number.isInteger(lead)) {
    return { error: "The lead time is a whole number of days, up to 365." };
  }
  if (coverage === null || coverage < 1 || coverage > 730 || !Number.isInteger(coverage)) {
    return { error: "How long an order should last is a whole number of days, 1 to 730." };
  }
  if (safety === null || safety < 0) return { error: "The buffer can't be less than nothing." };
  if (text(formData, "unit_cost") && unitCost === null) {
    return { error: "Write the unit cost as an amount, like 4.50." };
  }
  if (!supplyId && count !== null && count < 0) return { error: "Count can't be below nothing." };
  const { error } = await ctx.supabase.rpc("save_class_supply", {
    p_tenant_id: ctx.tenant.id,
    p_id: supplyId,
    p_fields: {
      name,
      vendor_id: text(formData, "vendor_id") || null,
      per_student: perStudent,
      lead_time_days: lead,
      safety_stock: safety,
      coverage_days: coverage,
      unit_cost_cents: unitCost ?? 0,
      unit: text(formData, "unit", 30),
      notes: text(formData, "notes"),
      active: supplyId ? formData.get("active") === "on" : true,
    },
    p_service_ids: formData.getAll("service").map(String),
    p_count: supplyId ? null : (count ?? 0),
  });
  if (error) return { error: OOPS };
  return done(slug, supplyId ? "Saved." : `${name} is added.`);
}

export async function addSupplyEntry(
  slug: string,
  supplyId: string,
  _prev: BookingsState,
  formData: FormData,
): Promise<BookingsState> {
  const ctx = await context(slug);
  if ("error" in ctx) return { error: ctx.error };
  const kind = text(formData, "kind");
  const qty = num(formData, "qty");
  if (!["count", "received", "adjustment"].includes(kind)) return { error: OOPS };
  if (qty === null || (kind !== "adjustment" && qty < 0) || (kind === "adjustment" && qty === 0)) {
    return {
      error:
        kind === "adjustment"
          ? "Write how many more (or, with a minus, fewer) there are."
          : "Write how many.",
    };
  }
  const { error } = await ctx.supabase.rpc("add_class_supply_entry", {
    p_supply_id: supplyId,
    p_kind: kind,
    p_qty: qty,
    p_note: text(formData, "note", 500),
  });
  if (error) return { error: OOPS };
  return done(
    slug,
    kind === "count"
      ? "Counted. Classes from now on are taken off this."
      : kind === "received"
        ? "Added to what's on hand."
        : "Corrected.",
  );
}

export async function placeSupplyOrder(
  slug: string,
  supplyId: string,
  _prev: BookingsState,
  formData: FormData,
): Promise<BookingsState> {
  const ctx = await context(slug);
  if ("error" in ctx) return { error: ctx.error };
  const qty = num(formData, "qty");
  const expected = day(formData, "expected_on");
  if (qty === null || qty <= 0) return { error: "Write how many you ordered." };
  if (!expected) return { error: "Pick the day you expect it." };
  const { error } = await ctx.supabase.rpc("place_class_supply_order", {
    p_supply_id: supplyId,
    p_qty: qty,
    p_expected_on: expected,
    p_note: text(formData, "note", 500),
  });
  if (error) return { error: OOPS };
  return done(slug, "Noted. It counts as on its way until you mark it received.");
}

export async function receiveSupplyOrder(
  slug: string,
  orderId: string,
  _prev: BookingsState,
  formData: FormData,
): Promise<BookingsState> {
  const ctx = await context(slug);
  if ("error" in ctx) return { error: ctx.error };
  const qty = num(formData, "qty");
  const { data, error } = await ctx.supabase.rpc("receive_class_supply_order", {
    p_order_id: orderId,
    p_qty: qty !== null && qty >= 0 ? qty : null,
  });
  if (error) return { error: OOPS };
  return done(slug, data === "already" ? "That order was already received." : "Received.");
}

export async function cancelSupplyOrder(
  slug: string,
  orderId: string,
  _prev: BookingsState,
  _formData: FormData,
): Promise<BookingsState> {
  const ctx = await context(slug);
  if ("error" in ctx) return { error: ctx.error };
  const { error } = await ctx.supabase.rpc("cancel_class_supply_order", { p_order_id: orderId });
  if (error) return { error: OOPS };
  return done(slug, "Cancelled.");
}

// ---------------------------------------------------------------------------
// The budget
// ---------------------------------------------------------------------------

export async function saveFixedCost(
  slug: string,
  costId: string | null,
  _prev: BookingsState,
  formData: FormData,
): Promise<BookingsState> {
  const ctx = await context(slug);
  if ("error" in ctx) return { error: ctx.error };
  const name = text(formData, "name", 120);
  const amount = cents(formData, "amount");
  const from = text(formData, "from") ? month(formData, "from") : "2000-01-01";
  const to = text(formData, "to") ? month(formData, "to") : null;
  if (!name) return { error: "Give it a name." };
  if (amount === null) return { error: "Write the monthly amount, like 1200." };
  if (!from || (text(formData, "to") && !to) || (to && to < from)) {
    return { error: "Pick the months it runs from and to (the end can be left open)." };
  }
  const { error } = await ctx.supabase.rpc("save_budget_fixed_cost", {
    p_tenant_id: ctx.tenant.id,
    p_id: costId,
    p_name: name,
    p_monthly_cents: amount,
    p_from_month: from,
    p_to_month: to,
    p_active: costId ? formData.get("active") === "on" : true,
  });
  if (error) return { error: OOPS };
  return done(slug, "Saved.");
}

export async function saveMaterialRate(
  slug: string,
  rateId: string | null,
  _prev: BookingsState,
  formData: FormData,
): Promise<BookingsState> {
  const ctx = await context(slug);
  if ("error" in ctx) return { error: ctx.error };
  const name = text(formData, "name", 120);
  const raw = text(formData, "rate").replace(/[$\s]/g, "");
  if (!name) return { error: "Give the material a name." };
  // Dollars a square foot, to four places: kept as hundredths of a cent.
  if (!/^\d+(\.\d{0,4})?$/.test(raw)) return { error: "Write the cost a square foot, like 0.45." };
  const { error } = await ctx.supabase.rpc("save_budget_material_rate", {
    p_tenant_id: ctx.tenant.id,
    p_id: rateId,
    p_name: name,
    p_centi_cents_per_sqft: Math.round(Number(raw) * 10000),
    p_active: rateId ? formData.get("active") === "on" : true,
  });
  if (error) return { error: OOPS };
  return done(slug, "Saved.");
}

export async function saveOtherIncome(
  slug: string,
  incomeId: string | null,
  _prev: BookingsState,
  formData: FormData,
): Promise<BookingsState> {
  const ctx = await context(slug);
  if ("error" in ctx) return { error: ctx.error };
  const label = text(formData, "label", 120);
  const amount = cents(formData, "amount");
  const received = day(formData, "received_on");
  if (!label) return { error: "Say what it was." };
  if (amount === null) return { error: "Write the amount, like 300." };
  if (!received) return { error: "Pick the day it came in." };
  const { error } = await ctx.supabase.rpc("save_budget_other_income", {
    p_tenant_id: ctx.tenant.id,
    p_id: incomeId,
    p_label: label,
    p_amount_cents: amount,
    p_received_on: received,
  });
  if (error) return { error: OOPS };
  return done(slug, "Saved.");
}

export async function deleteBudgetRow(
  slug: string,
  kind: "fixed" | "material" | "income",
  id: string,
  _prev: BookingsState,
  _formData: FormData,
): Promise<BookingsState> {
  const ctx = await context(slug);
  if ("error" in ctx) return { error: ctx.error };
  const { error } = await ctx.supabase.rpc("delete_budget_row", {
    p_tenant_id: ctx.tenant.id,
    p_kind: kind,
    p_id: id,
  });
  if (error) return { error: OOPS };
  return done(slug, "Removed.");
}

/**
 * Who taught a date and, if it was a flat fee, how much. `sessionIds` can
 * hold the classes that started together, so one teacher covers them all.
 */
export async function setSessionCosts(
  slug: string,
  sessionIds: string[],
  _prev: BookingsState,
  formData: FormData,
): Promise<BookingsState> {
  const ctx = await context(slug);
  if ("error" in ctx) return { error: ctx.error };
  const teacher = text(formData, "teacher");
  const fee = cents(formData, "fee");
  if (text(formData, "fee") && fee === null) return { error: "Write the fee as an amount." };
  if (!/^[a-z0-9-]{1,20}$/.test(teacher)) return { error: OOPS };
  const together = formData.get("together") === "on";
  const ids = together ? sessionIds : sessionIds.slice(0, 1);
  const { error } = await ctx.supabase.rpc("set_session_costs", {
    p_tenant_id: ctx.tenant.id,
    p_session_ids: ids,
    p_changes: { teacher, teaching_cents: fee },
  });
  if (error) return { error: OOPS };
  return done(slug, ids.length > 1 ? `Saved for ${ids.length} classes.` : "Saved.");
}

export async function setServiceFrame(
  slug: string,
  serviceId: string,
  _prev: BookingsState,
  formData: FormData,
): Promise<BookingsState> {
  const ctx = await context(slug);
  if ("error" in ctx) return { error: ctx.error };
  const width = num(formData, "width") ?? 0;
  const height = num(formData, "height") ?? 0;
  if (width < 0 || height < 0 || width > 1000 || height > 1000) {
    return { error: "Write the size in inches." };
  }
  const { error } = await ctx.supabase.rpc("set_service_frame", {
    p_service_id: serviceId,
    p_width: width,
    p_height: height,
  });
  if (error) return { error: OOPS };
  return done(slug, "Saved.");
}

/** Settings → Bookings → Budget: who teaches at what rate, prep time and waste. */
export async function saveBudgetSettings(
  slug: string,
  _prev: BookingsState,
  formData: FormData,
): Promise<BookingsState> {
  const ctx = await context(slug);
  if ("error" in ctx) return { error: ctx.error };
  const teachers = [];
  for (let i = 0; i < 10; i += 1) {
    const name = text(formData, `teacher_${i}_name`, 60);
    const id = text(formData, `teacher_${i}_id`, 20);
    if (!name) continue;
    const rate = cents(formData, `teacher_${i}_rate`);
    if (rate === null && text(formData, `teacher_${i}_rate`)) {
      return { error: `Write ${name}'s hourly rate as an amount, like 25.` };
    }
    teachers.push({
      id: /^[a-z0-9-]{1,20}$/.test(id) ? id : `t-${i}-${Date.now().toString(36).slice(-6)}`,
      name,
      hourly_cents: rate ?? 0,
    });
  }
  const parsed = budgetSettingsSchema.safeParse({
    version: 1,
    teachers,
    overhead_hours: num(formData, "overhead_hours") ?? 0,
    waste_percent: Math.round(num(formData, "waste_percent") ?? 0),
  });
  if (!parsed.success) {
    return {
      error:
        "Name at least one teacher. Prep and clean-up is up to 24 hours, and waste up to 100%.",
    };
  }
  const { error } = await ctx.supabase.rpc("save_config", {
    p_tenant_id: ctx.tenant.id,
    p_module: BOOKINGS_MODULE,
    p_key: BUDGET_KEY,
    p_body: parsed.data,
  });
  if (error) return { error: OOPS };
  revalidatePath(`/w/${slug}/settings`, "layout");
  return done(slug, "Saved.");
}
