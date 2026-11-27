"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth";
import { loadRevenueSettings } from "@/lib/dashboard/data";
import {
  CLOSED_MONTHS,
  REVENUE_FIGURES,
  bookAccountChoiceSchema,
  REVENUE_KEY,
  REVENUE_MODULE,
  revenueSettingsSchema,
  type RevenueSettings,
} from "@/lib/dashboard/lines";
import { DASHBOARD_KEY, DASHBOARD_MODULE, dashboardSchema } from "@/lib/dashboard/schema";
import { isTemplateKey, templateConfig } from "@/lib/dashboard/templates";
import { getEntitlements } from "@/lib/entitlements";
import { createClient } from "@/lib/supabase/server";
import { canManage, getTenantContext } from "@/lib/tenants";
import { z } from "zod";

export type TemplateState = { error?: string };

/** Replaces the workspace's dashboard with one of the starting layouts. */
export async function applyTemplate(
  slug: string,
  _prev: TemplateState,
  formData: FormData,
): Promise<TemplateState> {
  const user = await requireUser(`/w/${slug}/dashboard`);
  const ctx = await getTenantContext(slug, user.id);
  if (!ctx || !canManage(ctx.role)) {
    return { error: "Only owners and admins can change the dashboard." };
  }
  const entitlements = await getEntitlements(ctx.tenant.id);
  if (!entitlements.canWrite || !entitlements.can("module.dashboard")) {
    return { error: "Your plan doesn't include changing the dashboard right now." };
  }
  const key = formData.get("template");
  if (!isTemplateKey(key)) return { error: "Pick a layout to use." };

  // Validated on the way in, exactly as it is on the way out.
  const body = dashboardSchema.parse(templateConfig(key));
  const supabase = await createClient();
  const { error } = await supabase.rpc("save_config", {
    p_tenant_id: ctx.tenant.id,
    p_module: DASHBOARD_MODULE,
    p_key: DASHBOARD_KEY,
    p_body: body,
  });
  if (error) return { error: "We couldn't save that layout. Try again in a moment." };
  revalidatePath(`/w/${slug}/dashboard`);
  return {};
}

export type RevenueState = { error?: string; message?: string };

/** Owners and admins, on a plan that can still change things. */
async function revenueContext(slug: string) {
  const user = await requireUser(`/w/${slug}/settings/money/lines`);
  const ctx = await getTenantContext(slug, user.id);
  if (!ctx || !canManage(ctx.role)) {
    return { error: "Only owners and admins can change how Money counts revenue." } as const;
  }
  const entitlements = await getEntitlements(ctx.tenant.id);
  if (!entitlements.canWrite || !entitlements.can("module.dashboard")) {
    return { error: "Your plan doesn't include changing Money right now." } as const;
  }
  const supabase = await createClient();
  return { tenant: ctx.tenant, supabase } as const;
}

/** Saves the whole revenue setting, each form having changed only its own part. */
async function saveRevenue(
  slug: string,
  change: (current: RevenueSettings) => unknown,
  done: string,
): Promise<RevenueState> {
  const ctx = await revenueContext(slug);
  if ("error" in ctx) return { error: ctx.error };
  const current = await loadRevenueSettings(ctx.supabase, ctx.tenant.id);
  const parsed = revenueSettingsSchema.safeParse(change(current));
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { error: issue?.message ?? "Something in there doesn't look right." };
  }
  const { error } = await ctx.supabase.rpc("save_config", {
    p_tenant_id: ctx.tenant.id,
    p_module: REVENUE_MODULE,
    p_key: REVENUE_KEY,
    p_body: parsed.data,
  });
  if (error) return { error: "We couldn't save that. Try again in a moment." };
  revalidatePath(`/w/${slug}/dashboard`);
  revalidatePath(`/w/${slug}/settings`, "layout");
  return { message: done };
}

/** Which figure counts as revenue, and whether classes count when they run. */
export async function saveRevenueFigure(
  slug: string,
  _prev: RevenueState,
  formData: FormData,
): Promise<RevenueState> {
  const figure = formData.get("figure");
  if (!(REVENUE_FIGURES as readonly unknown[]).includes(figure)) {
    return { error: "Choose which figure to count." };
  }
  return saveRevenue(
    slug,
    (current) => ({
      ...current,
      figure,
      by_class_date: formData.get("by_class_date") === "on",
    }),
    "Saved. Money counts it this way from now on, for every date range.",
  );
}

/** Where a complete month's revenue comes from: the shop's sales or the books' income. */
export async function saveClosedMonths(
  slug: string,
  _prev: RevenueState,
  formData: FormData,
): Promise<RevenueState> {
  const closed = formData.get("closed_months");
  if (!(CLOSED_MONTHS as readonly unknown[]).includes(closed)) {
    return { error: "Choose where a closed month's revenue comes from." };
  }
  return saveRevenue(
    slug,
    (current) => ({ ...current, closed_months: closed }),
    closed === "books"
      ? "Saved. Months that have ended now take their revenue from your books."
      : "Saved. Every month is your shop's sales again.",
  );
}

/** The business lines and their rules, handed over as one JSON field by the editor. */
export async function saveBusinessLines(
  slug: string,
  _prev: RevenueState,
  formData: FormData,
): Promise<RevenueState> {
  let body: { lines?: unknown; default_line?: unknown; rules?: unknown };
  try {
    body = JSON.parse(String(formData.get("body") ?? "{}"));
  } catch {
    return { error: "Something in there doesn't look right." };
  }
  return saveRevenue(
    slug,
    (current) => {
      // A line taken away takes the books' choices that pointed at it.
      const kept = new Set(
        Array.isArray(body.lines)
          ? body.lines.map((line) => (line as { id?: unknown })?.id).filter(Boolean)
          : [],
      );
      return {
        ...current,
        lines: body.lines,
        default_line: body.default_line ?? null,
        rules: body.rules,
        books: {
          ...current.books,
          other_income_line:
            current.books.other_income_line && kept.has(current.books.other_income_line)
              ? current.books.other_income_line
              : null,
          accounts: current.books.accounts.filter(
            (a) => !("line" in a.choice) || kept.has(a.choice.line),
          ),
          customers: current.books.customers.filter(
            (c) => !("line" in c.choice) || kept.has(c.choice.line),
          ),
        },
      };
    },
    "Saved. Every chart of your lines uses these from now on, for past sales too.",
  );
}

/**
 * Revenue from the books: whether paid invoices and other income count, and
 * what each income account's invoices count as. Handed over as one JSON field.
 */
export async function saveBooksRevenue(
  slug: string,
  _prev: RevenueState,
  formData: FormData,
): Promise<RevenueState> {
  let body: unknown;
  try {
    body = JSON.parse(String(formData.get("body") ?? "{}"));
  } catch {
    return { error: "Something in there doesn't look right." };
  }
  return saveRevenue(
    slug,
    // The customers' defaults are kept as they are: they're changed from the
    // invoice list, one customer at a time.
    (current) => ({
      ...current,
      books:
        body && typeof body === "object" && !Array.isArray(body)
          ? { ...body, customers: current.books.customers }
          : body,
    }),
    "Saved. Revenue by line and profit by line count your books this way from now on, for past months too.",
  );
}

const customerSchema = z.object({
  ref: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,60}$/)
    .nullable(),
  name: z.string().trim().min(1).max(200),
});

/**
 * "Always put this customer's invoices in…": a default for every invoice to
 * one customer of the books, by the books' id, else the exact name (null
 * takes it away). An invoice a person sorted by hand keeps its own choice.
 */
export async function saveInvoiceCustomer(
  slug: string,
  customer: unknown,
  choice: unknown,
): Promise<RevenueState> {
  const who = customerSchema.safeParse(customer);
  const how = choice === null ? null : bookAccountChoiceSchema.safeParse(choice);
  if (!who.success) return { error: "That invoice has no customer to choose for." };
  if (how && !how.success) return { error: "Choose where this customer's invoices go." };
  const key = (c: { ref: string | null; name: string }) =>
    c.ref ? `ref:${c.ref}` : `name:${c.name}`;
  // A choice made by name before the books gave an id is the same customer.
  const same = (c: { ref: string | null; name: string }) =>
    key(c) === key(who.data) || (c.ref === null && c.name === who.data.name);
  return saveRevenue(
    slug,
    (current) => ({
      ...current,
      books: {
        ...current.books,
        customers: [
          ...current.books.customers.filter((c) => !same(c)),
          ...(how ? [{ ...who.data, choice: how.data }] : []),
        ],
      },
    }),
    how
      ? `Saved. Invoices to ${who.data.name} go there from now on, past ones too, unless you sorted one yourself.`
      : `Saved. Invoices to ${who.data.name} follow their own choice or income account again.`,
  );
}

/** Takes one customer's default away, from Settings (the list there). */
export async function removeInvoiceCustomer(
  slug: string,
  _prev: RevenueState,
  formData: FormData,
): Promise<RevenueState> {
  const ref = String(formData.get("ref") ?? "");
  return saveInvoiceCustomer(
    slug,
    { ref: ref === "" ? null : ref, name: String(formData.get("name") ?? "") },
    null,
  );
}
