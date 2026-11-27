"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { invoiceSortArgs, invoiceSortSchema } from "@/lib/dashboard/invoices";
import { getEntitlements } from "@/lib/entitlements";
import { createClient } from "@/lib/supabase/server";
import { canManage, getTenantContext } from "@/lib/tenants";

export type InvoiceActionState = { error?: string; message?: string };

const ids = z.array(z.string().uuid()).min(1).max(500);

const plural = (n: number, one: string, many: string) =>
  `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

/**
 * A person's choice for the ticked invoices (or one): a line, a split, "the
 * shop already counted this", left out, or back to its customer's or
 * account's choice. Owners and admins only; no sync changes it.
 */
export async function sortInvoices(
  slug: string,
  invoiceIds: string[],
  choice: unknown,
): Promise<InvoiceActionState> {
  const user = await requireUser(`/w/${slug}/dashboard/invoices`);
  const ctx = await getTenantContext(slug, user.id);
  if (!ctx || !canManage(ctx.role)) {
    return { error: "Only owners and admins can sort invoices." };
  }
  const entitlements = await getEntitlements(ctx.tenant.id);
  if (!entitlements.canWrite || !entitlements.can("module.dashboard")) {
    return { error: "Your plan doesn't include changing Money right now." };
  }
  const picked = ids.safeParse(invoiceIds);
  const how = invoiceSortSchema.safeParse(choice);
  if (!picked.success) return { error: "Tick between 1 and 500 invoices first." };
  if (!how.success) return { error: how.error.issues[0]?.message ?? "Choose where these go." };

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("sort_book_invoices", {
    p_tenant_id: ctx.tenant.id,
    p_ids: picked.data,
    ...invoiceSortArgs(how.data),
  });
  if (error) {
    return {
      error:
        error.code === "22023"
          ? "That line or split isn't one of yours any more. Reload the page and try again."
          : "We couldn't save that. Try again in a moment.",
    };
  }
  revalidatePath(`/w/${slug}/dashboard`, "layout");
  const n = Number(data ?? 0);
  if (n === 0) return { message: "Nothing changed: those invoices are as you chose already." };
  return {
    message:
      how.data.sort === "none"
        ? n === 1
          ? "That invoice follows its customer or income account again."
          : `${plural(n, "invoice", "invoices")} follow their customer or income account again.`
        : `Sorted ${plural(n, "invoice", "invoices")}.`,
  };
}
