"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth";
import { getEntitlements } from "@/lib/entitlements";
import { hideNotice } from "@/lib/stock/balance/notices";
import {
  STOCK_HIDDEN_NOTICES_KEY,
  STOCK_MODULE,
  hiddenNoticesSchema,
  parseHiddenNotices,
} from "@/lib/stock/config";
import { createClient } from "@/lib/supabase/server";
import { canManage, getTenantContext } from "@/lib/tenants";
import type { StockState } from "../actions";

const NO_ACCESS = "Stock isn't part of this workspace's plan right now.";
const NOT_ALLOWED = "Only owners and admins can do that.";
const READ_ONLY =
  "This workspace is read-only because its plan has ended. Pick a plan to make changes.";
const OOPS = "That didn't save. Please try again.";
const UUID = /^[0-9a-f-]{36}$/i;
const MAX_CENTS = 100_000_000 * 100;

/** Everything here is for the people who run the business: owners and admins. */
async function context(slug: string) {
  const user = await requireUser(`/w/${slug}/stock/balances`);
  const ctx = await getTenantContext(slug, user.id);
  if (!ctx) return { error: NO_ACCESS } as const;
  const entitlements = await getEntitlements(ctx.tenant.id);
  if (!entitlements.can("module.stock")) return { error: NO_ACCESS } as const;
  if (!entitlements.canWrite) return { error: READ_ONLY } as const;
  if (!canManage(ctx.role)) return { error: NOT_ALLOWED } as const;
  return { tenant: ctx.tenant, supabase: await createClient() } as const;
}

const text = (formData: FormData, name: string) => String(formData.get(name) ?? "").trim();
const done = (slug: string) => revalidatePath(`/w/${slug}/stock`, "layout");

/**
 * What someone typed as money ("1,234.5", "$80", "-12.00") as a plain decimal
 * string with two places, or null when it isn't an amount. Text in, text out:
 * it never passes through a floating-point number.
 */
function parseAmount(raw: string): { value: string; cents: number } | null {
  const cleaned = raw.replace(/[\s,$€£]/g, "").replace(/^−/, "-");
  const match = /^(-)?(\d{0,9})(?:\.(\d{0,2}))?$/.exec(cleaned);
  if (!match || (!match[2] && !match[3])) return null;
  const whole = match[2].replace(/^0+(?=\d)/, "") || "0";
  const fraction = (match[3] ?? "").padEnd(2, "0");
  const cents = Number(whole) * 100 + Number(fraction);
  if (cents > MAX_CENTS) return null;
  const negative = Boolean(match[1]) && cents !== 0;
  return { value: `${negative ? "-" : ""}${whole}.${fraction}`, cents: negative ? -cents : cents };
}

function realDay(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

const KINDS = {
  invoice: { type: "invoice", saved: "Invoice saved." },
  payment: { type: "payment", saved: "Payment saved." },
  statement: { type: "statement", saved: "Statement balance saved." },
  credit: { type: "adjustment", saved: "Credit saved." },
} as const;

/** Writes an invoice, payment, statement balance or credit onto a supplier's account. */
export async function addLedgerEntry(
  slug: string,
  supplierId: string,
  _prev: StockState,
  formData: FormData,
): Promise<StockState> {
  const ctx = await context(slug);
  if ("error" in ctx) return { error: ctx.error };
  if (!UUID.test(supplierId)) return { error: OOPS };
  const kindName = text(formData, "kind");
  if (!Object.hasOwn(KINDS, kindName)) return { error: "Pick what you're adding." };
  const kind = KINDS[kindName as keyof typeof KINDS];
  const date = text(formData, "date");
  if (!realDay(date)) return { error: "Pick the date." };
  const reference = text(formData, "reference");
  const note = text(formData, "note");
  if (reference.length > 80)
    return { error: "That reference is too long (80 characters at most)." };
  if (note.length > 500) return { error: "That note is too long (500 characters at most)." };

  const amount = parseAmount(text(formData, "amount"));
  if (!amount) {
    return {
      error:
        kindName === "statement"
          ? "Type the balance as a number, like 1250.00."
          : "Type the amount as a number, like 1250.00.",
    };
  }
  if (kindName !== "statement") {
    if (amount.cents < 0) {
      return {
        error:
          kindName === "credit"
            ? "Type the credit without a minus sign. We know it lowers what you owe."
            : "Leave out the minus sign. If they've given you money back, add it as a credit.",
      };
    }
    if (amount.cents === 0) return { error: "How much was it? The amount can't be zero." };
  }

  const { error } = await ctx.supabase.rpc("save_ledger_entry", {
    p_tenant_id: ctx.tenant.id,
    p_supplier_id: supplierId,
    p_type: kind.type,
    p_entry_date: date,
    // A credit is an adjustment in the business's favour: stored negative.
    p_amount:
      kindName === "statement" ? "0" : kindName === "credit" ? `-${amount.value}` : amount.value,
    p_stated_balance: kindName === "statement" ? amount.value : null,
    p_reference: reference || null,
    p_description: note,
  });
  if (error) {
    if (error.message.includes("amount_needed")) {
      return { error: "How much was it? The amount can't be zero." };
    }
    if (error.code === "22023") {
      return { error: "Check the date: it can't be before 2000 or more than a year from now." };
    }
    if (error.code === "P0002") return { error: "We couldn't find that supplier." };
    if (error.code === "42501") return { error: NOT_ALLOWED };
    return { error: OOPS };
  }
  done(slug);
  return { message: kind.saved };
}

/**
 * Corrects an invoice or payment from its own page: a new date, amount or
 * note under the same number. It goes through `save_ledger_entry`, which
 * corrects the entry carrying that number rather than adding a second one,
 * so the "Paid" tick and where the entry came from are left as they were.
 */
export async function correctLedgerEntry(
  slug: string,
  entryId: string,
  _prev: StockState,
  formData: FormData,
): Promise<StockState> {
  const ctx = await context(slug);
  if ("error" in ctx) return { error: ctx.error };
  if (!UUID.test(entryId)) return { error: OOPS };
  const { data: entry } = await ctx.supabase
    .from("supplier_ledger")
    .select("id, supplier_id, type, reference, source")
    .eq("tenant_id", ctx.tenant.id)
    .eq("id", entryId)
    .maybeSingle();
  if (!entry) return { error: "That entry is already gone." };
  const reference = ((entry.reference as string | null) ?? "").trim();
  if ((entry.type !== "invoice" && entry.type !== "payment") || !reference) {
    return { error: "This entry has no number to correct it by. Remove it and add it again." };
  }
  if (entry.source === "books") {
    return { error: "This came from your books. Change it there and it follows here." };
  }
  // The same number on two entries would correct both: refuse rather than guess.
  const { data: twins, error: twinsError } = await ctx.supabase
    .from("supplier_ledger")
    .select("id")
    .eq("tenant_id", ctx.tenant.id)
    .eq("supplier_id", entry.supplier_id)
    .eq("type", entry.type)
    .ilike("reference", reference.replace(/[\\%_]/g, "\\$&"))
    .limit(3);
  if (twinsError) return { error: OOPS };
  if ((twins ?? []).length !== 1) {
    return {
      error: "Two entries share this number. Remove the one that's wrong and add it again.",
    };
  }
  const date = text(formData, "date");
  if (!realDay(date)) return { error: "Pick the date." };
  const note = text(formData, "note");
  if (note.length > 500) return { error: "That note is too long (500 characters at most)." };
  const amount = parseAmount(text(formData, "amount"));
  if (!amount) return { error: "Type the amount as a number, like 1250.00." };
  if (amount.cents <= 0)
    return { error: "The amount has to be more than zero, with no minus sign." };

  const { data: saved, error } = await ctx.supabase.rpc("save_ledger_entry", {
    p_tenant_id: ctx.tenant.id,
    p_supplier_id: entry.supplier_id,
    p_type: entry.type,
    p_entry_date: date,
    p_amount: amount.value,
    p_stated_balance: null,
    p_reference: reference,
    p_description: note,
  });
  if (error) {
    if (error.code === "22023") {
      return { error: "Check the date: it can't be before 2000 or more than a year from now." };
    }
    if (error.code === "42501") return { error: NOT_ALLOWED };
    return { error: OOPS };
  }
  if (saved !== entryId) return { error: OOPS };
  // A person has now set the figures themselves: nothing is left to check.
  await ctx.supabase.rpc("settle_ledger_review", {
    p_tenant_id: ctx.tenant.id,
    p_entry_id: entryId,
  });
  done(slug);
  return { message: "Saved." };
}

/** Takes an entry off the account, to undo a mistake. */
export async function removeLedgerEntry(slug: string, entryId: string): Promise<StockState> {
  const ctx = await context(slug);
  if ("error" in ctx) return { error: ctx.error };
  if (!UUID.test(entryId)) return { error: OOPS };
  const { error } = await ctx.supabase.rpc("remove_ledger_entry", {
    p_tenant_id: ctx.tenant.id,
    p_entry_id: entryId,
  });
  if (error) {
    done(slug);
    return { error: error.code === "P0002" ? "That entry is already gone." : OOPS };
  }
  done(slug);
  return {};
}

/** Ticks a bill as paid (the money has been sent), or unticks it. */
export async function markBillPaid(
  slug: string,
  entryId: string,
  paid: boolean,
): Promise<StockState> {
  const ctx = await context(slug);
  if ("error" in ctx) return { error: ctx.error };
  if (!UUID.test(entryId)) return { error: OOPS };
  const { error } = await ctx.supabase.rpc("mark_bill_paid", {
    p_tenant_id: ctx.tenant.id,
    p_entry_id: entryId,
    p_paid: paid === true,
  });
  if (error) return { error: "That didn't save. Please try again." };
  done(slug);
  return {};
}

/** How many days after an invoice's date this supplier wants paying. */
export async function setSupplierTerms(
  slug: string,
  supplierId: string,
  _prev: StockState,
  formData: FormData,
): Promise<StockState> {
  const ctx = await context(slug);
  if ("error" in ctx) return { error: ctx.error };
  if (!UUID.test(supplierId)) return { error: OOPS };
  const raw = text(formData, "days");
  const days = /^\d{1,3}$/.test(raw) ? Number.parseInt(raw, 10) : null;
  if (days === null || days > 365) {
    return { error: "How many days do they give you to pay? (0 to 365)" };
  }
  const { error } = await ctx.supabase.rpc("set_supplier_terms", {
    p_tenant_id: ctx.tenant.id,
    p_supplier_id: supplierId,
    p_days: days,
  });
  if (error) return { error: OOPS };
  done(slug);
  return { message: "Saved." };
}

/**
 * Hides one notice on the Balances tab, or (with no key) shows them all
 * again. Kept with the workspace, so it holds on every device; a notice comes
 * back by itself when its facts change, because its key changes with them.
 */
export async function setBalanceNotice(slug: string, key: string | null): Promise<void> {
  const ctx = await context(slug);
  if ("error" in ctx) return;
  if (key !== null && (key.length < 1 || key.length > 300)) return;
  const { data } = await ctx.supabase
    .from("configs")
    .select("body")
    .eq("tenant_id", ctx.tenant.id)
    .eq("module", STOCK_MODULE)
    .eq("key", STOCK_HIDDEN_NOTICES_KEY)
    .maybeSingle();
  const now = parseHiddenNotices(data?.body).keys;
  const parsed = hiddenNoticesSchema.safeParse({
    version: 1,
    keys: key === null ? [] : hideNotice(now, key),
  });
  if (!parsed.success) return;
  const { error } = await ctx.supabase.rpc("save_config", {
    p_tenant_id: ctx.tenant.id,
    p_module: STOCK_MODULE,
    p_key: STOCK_HIDDEN_NOTICES_KEY,
    p_body: parsed.data,
  });
  if (!error) done(slug);
}
