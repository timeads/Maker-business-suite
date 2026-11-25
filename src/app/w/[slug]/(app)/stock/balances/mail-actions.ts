"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth";
import { getAdapter } from "@/lib/connections/registry";
import { vaultTokenStore, type TokenDeps } from "@/lib/connections/tokens";
import { ReconnectRequiredError } from "@/lib/connections/types";
import { getEntitlements } from "@/lib/entitlements";
import { inboundDomain } from "@/lib/helpdesk/addresses";
import { STOCK_MODULE } from "@/lib/stock/config";
import { STOCK_EMAIL_SOURCES_KEY, emailSourcesSchema } from "@/lib/stock/mail/config";
import { parseStoredDocuments } from "@/lib/stock/mail/extract";
import { GmailReadError } from "@/lib/stock/mail/gmail";
import { canReadGmail, looksFor, mailboxOf, readFound } from "@/lib/stock/mail/gmail-run";
import {
  fileUpload,
  filePending,
  loadWorkspace,
  recordTokens,
  type IntakeDeps,
} from "@/lib/stock/mail/intake";
import {
  MAX_FILE_BYTES,
  MAX_MESSAGES_PER_TRY,
  dayIn,
  fileKind,
  looksLike,
  uploadKey,
} from "@/lib/stock/mail/message";
import { planDocuments, type Candidate, type Skipped } from "@/lib/stock/mail/plan";
import { CATCH_UP_DAYS } from "@/lib/stock/mail/query";
import { readMail } from "@/lib/stock/mail/reader";
import { getAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { canManage, getTenantContext } from "@/lib/tenants";

export type MailState = {
  error?: string;
  message?: string;
  /** "Try it" and an upload: what was (or would be) filed, and what was left out. */
  lines?: string[];
  skipped?: Skipped[];
};

const NO_ACCESS = "Stock isn't part of this workspace's plan right now.";
const NOT_ALLOWED = "Only owners and admins can do that.";
const READ_ONLY =
  "This workspace is read-only because its plan has ended. Pick a plan to make changes.";
const OOPS = "That didn't work. Please try again.";
const NO_CLAUDE = "This month's Claude allowance is used up. You can still add it by hand.";
const UUID = /^[0-9a-f-]{36}$/i;

/** Everything here is for the people who run the business: owners and admins. */
async function context(slug: string) {
  const user = await requireUser(`/w/${slug}/stock/balances`);
  const ctx = await getTenantContext(slug, user.id);
  if (!ctx) return { error: NO_ACCESS } as const;
  const entitlements = await getEntitlements(ctx.tenant.id);
  if (!entitlements.can("module.stock")) return { error: NO_ACCESS } as const;
  if (!entitlements.canWrite) return { error: READ_ONLY } as const;
  if (!canManage(ctx.role)) return { error: NOT_ALLOWED } as const;
  return { user, tenant: ctx.tenant, entitlements, supabase: await createClient() } as const;
}
type Ctx = Extract<Awaited<ReturnType<typeof context>>, { tenant: unknown }>;

const done = (slug: string) => {
  revalidatePath(`/w/${slug}/stock`, "layout");
  // This tool's settings screens live under workspace Settings.
  revalidatePath(`/w/${slug}/settings`, "layout");
};

/** Is there Claude allowance left this month? The same sum the drafting tools do. */
async function claudeLeft(ctx: Ctx): Promise<boolean> {
  const monthStart = new Date();
  monthStart.setUTCDate(1);
  monthStart.setUTCHours(0, 0, 0, 0);
  const { data: usage } = await ctx.supabase
    .from("usage_events")
    .select("quantity")
    .eq("tenant_id", ctx.tenant.id)
    .eq("type", "ai_tokens")
    .gte("occurred_at", monthStart.toISOString());
  const used = (usage ?? []).reduce((sum, row) => sum + Number(row.quantity), 0);
  return used < ctx.entitlements.limit("ai_credits");
}

const intakeDeps = (): IntakeDeps => ({
  admin: getAdminClient(),
  read: (message, hint) => readMail(message, hint),
  now: () => new Date(),
});

function describe(entries: Candidate[], results: { external_key: string; outcome: string }[]) {
  const byKey = new Map(entries.map((e) => [e.external_key, e]));
  const lines: string[] = [];
  for (const result of results) {
    const entry = byKey.get(result.external_key);
    if (!entry) continue;
    const what =
      entry.type === "invoice"
        ? `Invoice ${entry.reference} · ${entry.amount} · dated ${entry.entry_date}`
        : entry.type === "statement"
          ? `Statement balance ${entry.stated_balance} · as of ${entry.entry_date}`
          : `Payment ${entry.amount} · ${entry.entry_date}`;
    if (result.outcome === "added") {
      lines.push(`${what}${entry.needs_review ? " · to check" : ""}`);
    } else if (result.outcome === "changed" || result.outcome === "flagged") {
      lines.push(`${what} · differs from what's on the account, so it's marked to check`);
    } else if (result.outcome === "same") {
      lines.push(`${what} · already on the account`);
    }
  }
  return lines;
}

/** A manager's "Read now": asks the worker for a look at Gmail. */
export async function readMailNow(slug: string): Promise<MailState> {
  const ctx = await context(slug);
  if ("error" in ctx) return { error: ctx.error };
  const { error } = await ctx.supabase.rpc("request_stock_email_read", {
    p_tenant_id: ctx.tenant.id,
  });
  if (error) {
    if (error.message.includes("not_on")) {
      return { error: "Reading Gmail isn't switched on yet. Set it up under Bills by email." };
    }
    if (error.message.includes("too_soon")) {
      return { error: "It was read a few minutes ago. Give it ten minutes between reads." };
    }
    if (error.message.includes("too_many")) {
      return { error: "That's six reads by hand today. The next one is tomorrow's own." };
    }
    return { error: error.code === "42501" ? NOT_ALLOWED : OOPS };
  }
  done(slug);
  return { message: "Reading now. This page shows what came in once it's done." };
}

/** "Looks right": an entry that was marked to check has been checked. */
export async function settleReview(slug: string, entryId: string): Promise<MailState> {
  const ctx = await context(slug);
  if ("error" in ctx) return { error: ctx.error };
  if (!UUID.test(entryId)) return { error: OOPS };
  const { error } = await ctx.supabase.rpc("settle_ledger_review", {
    p_tenant_id: ctx.tenant.id,
    p_entry_id: entryId,
  });
  if (error) return { error: error.code === "P0002" ? "That entry is already gone." : OOPS };
  done(slug);
  return {};
}

/** Says whose a waiting message is, and files what was read from it on their account. */
export async function assignPendingMail(
  slug: string,
  pendingId: string,
  _prev: MailState,
  formData: FormData,
): Promise<MailState> {
  const ctx = await context(slug);
  if ("error" in ctx) return { error: ctx.error };
  const supplierId = String(formData.get("supplier") ?? "");
  if (!UUID.test(pendingId) || !UUID.test(supplierId)) return { error: "Pick the supplier." };
  // Read as the member: only a manager of this workspace gets the row back.
  const [{ data: pending }, { data: supplier }] = await Promise.all([
    ctx.supabase
      .from("stock_email_pending")
      .select("id, message_key, sent_day, documents")
      .eq("tenant_id", ctx.tenant.id)
      .eq("id", pendingId)
      .maybeSingle(),
    ctx.supabase
      .from("suppliers")
      .select("id")
      .eq("tenant_id", ctx.tenant.id)
      .eq("id", supplierId)
      .maybeSingle(),
  ]);
  if (!pending) return { error: "That message isn't waiting any more." };
  if (!supplier) return { error: "We couldn't find that supplier." };
  const plan = planDocuments(parseStoredDocuments(pending.documents), {
    supplierId,
    kind: "mixed",
    alwaysCheck: false,
    currency: ctx.tenant.currency,
    messageId: String(pending.message_key),
    day: String(pending.sent_day).slice(0, 10),
  });
  if (plan.entries.length === 0) {
    return {
      error: `Nothing in it could be filed (${plan.skipped[0]?.reason ?? "nothing readable"}). Put it away and add it by hand.`,
    };
  }
  try {
    const result = await filePending(getAdminClient(), {
      tenantId: ctx.tenant.id,
      pendingId,
      messageKey: String(pending.message_key),
      supplierId,
      entries: plan.entries,
      actor: ctx.user.id,
    });
    done(slug);
    const left = [...plan.skipped, ...result.skipped];
    return {
      message:
        result.filed > 0
          ? `Filed ${result.filed} entr${result.filed === 1 ? "y" : "ies"}.`
          : "Nothing new: it was on the account already.",
      skipped: left,
    };
  } catch (err) {
    console.error("could not file a waiting message", err instanceof Error ? err.message : err);
    return { error: OOPS };
  }
}

/** Puts a waiting message away without filing anything. */
export async function discardPendingMail(slug: string, pendingId: string): Promise<MailState> {
  const ctx = await context(slug);
  if ("error" in ctx) return { error: ctx.error };
  if (!UUID.test(pendingId)) return { error: OOPS };
  const { error } = await ctx.supabase.rpc("discard_email_pending", {
    p_tenant_id: ctx.tenant.id,
    p_pending_id: pendingId,
  });
  if (error) return { error: error.code === "P0002" ? "That message is already gone." : OOPS };
  done(slug);
  return {};
}

/**
 * A manager uploads an invoice or statement for one supplier. The file is
 * read here, in the request, handed to the same reader and filed by the same
 * function as an emailed one. It is never stored.
 */
export async function uploadBill(
  slug: string,
  supplierId: string,
  _prev: MailState,
  formData: FormData,
): Promise<MailState> {
  const ctx = await context(slug);
  if ("error" in ctx) return { error: ctx.error };
  if (!UUID.test(supplierId)) return { error: OOPS };
  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) return { error: "Choose a file first." };
  if (file.size > MAX_FILE_BYTES) return { error: "Files can be up to 5 MB." };
  const kind = fileKind(file.name, file.type);
  if (!kind) return { error: "Upload a PDF, PNG or JPEG." };
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!looksLike(kind, bytes)) return { error: "That file isn't a real PDF, PNG or JPEG." };
  const { data: supplier } = await ctx.supabase
    .from("suppliers")
    .select("id")
    .eq("tenant_id", ctx.tenant.id)
    .eq("id", supplierId)
    .maybeSingle();
  if (!supplier) return { error: "We couldn't find that supplier." };
  if (!(await claudeLeft(ctx))) return { error: NO_CLAUDE };

  const admin = getAdminClient();
  const now = new Date();
  try {
    const read = await readMail(
      {
        from: "",
        subject: "",
        sentAt: now,
        text: "",
        files: [
          { name: file.name.slice(0, 200), kind, base64: Buffer.from(bytes).toString("base64") },
        ],
      },
      {
        currency: ctx.tenant.currency,
        kind: "invoices, statements or payments (decide per document)",
      },
    );
    await recordTokens(admin, ctx.tenant.id, read.tokens);
    if (!read.ok) {
      return { error: "Claude couldn't read that file. Try a clearer copy, or add it by hand." };
    }
    const plan = planDocuments(read.documents, {
      supplierId,
      kind: "mixed",
      alwaysCheck: false,
      currency: ctx.tenant.currency,
      messageId: null,
      uploadKey: uploadKey(bytes),
      day: dayIn(now, ctx.tenant.timezone),
    });
    const result =
      plan.entries.length > 0
        ? await fileUpload(admin, {
            tenantId: ctx.tenant.id,
            entries: plan.entries,
            actor: ctx.user.id,
          })
        : { results: [], filed: 0, toCheck: 0, skipped: [] };
    const skipped = [...plan.skipped, ...result.skipped];
    const { error: recordError } = await admin.rpc("record_stock_email_read", {
      p_tenant_id: ctx.tenant.id,
      p_source: "upload",
      p_counts: {
        seen: 1,
        read: 1,
        filed: result.filed,
        to_check: result.toCheck,
        skipped: skipped.length,
        capped: false,
      },
      p_skipped: skipped.slice(0, 60),
      p_actor: ctx.user.id,
    });
    if (recordError) console.error(`could not record an upload: ${recordError.message}`);
    done(slug);
    if (plan.entries.length === 0) {
      return {
        error: `Nothing in that file could be filed${skipped[0] ? `: ${skipped[0].reason}` : ""}.`,
        skipped,
      };
    }
    return {
      message:
        result.filed > 0
          ? `Filed ${result.filed} entr${result.filed === 1 ? "y" : "ies"}${result.toCheck > 0 ? `, ${result.toCheck} to check` : ""}.`
          : "Nothing new was filed.",
      lines: describe(plan.entries, result.results),
      skipped,
    };
  } catch (err) {
    console.error("could not read an uploaded bill", err instanceof Error ? err.message : err);
    return { error: OOPS };
  }
}

/** Saves which emails are read. The whole list at once, checked against the schema. */
export async function saveEmailSources(
  slug: string,
  _prev: MailState,
  formData: FormData,
): Promise<MailState> {
  const ctx = await context(slug);
  if ("error" in ctx) return { error: ctx.error };
  let body: unknown;
  try {
    body = JSON.parse(String(formData.get("body") ?? ""));
  } catch {
    return { error: OOPS };
  }
  const parsed = emailSourcesSchema.safeParse(body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue?.path.includes("from")
      ? "Check who the mail is from: an address or a domain, like billing@mill.example."
      : issue?.path.includes("words") || issue?.path.includes("subject_words")
        ? "Words can only be letters, numbers and spaces (two characters or more)."
        : issue?.path.includes("supplier_id")
          ? "Pick a supplier for every source."
          : "Something in the list isn't right. Check each source and try again.";
    return { error: where };
  }
  // Every source must name one of this workspace's own suppliers.
  const wanted = new Set([
    ...parsed.data.suppliers.map((s) => s.supplier_id),
    ...parsed.data.bank.flatMap((b) => b.payees.map((p) => p.supplier_id)),
  ]);
  if (wanted.size > 0) {
    const { data: mine } = await ctx.supabase
      .from("suppliers")
      .select("id")
      .eq("tenant_id", ctx.tenant.id)
      .in("id", [...wanted]);
    if ((mine ?? []).length !== wanted.size) return { error: "Pick a supplier for every source." };
  }
  const { error } = await ctx.supabase.rpc("save_config", {
    p_tenant_id: ctx.tenant.id,
    p_module: STOCK_MODULE,
    p_key: STOCK_EMAIL_SOURCES_KEY,
    p_body: parsed.data,
  });
  if (error) return { error: error.code === "42501" ? NOT_ALLOWED : OOPS };
  done(slug);
  return { message: "Saved." };
}

/**
 * "Try it": looks in Gmail for one saved source's latest few messages, reads
 * them and says what WOULD be filed. Nothing is filed and nothing is noted as
 * seen, so the real read still finds them.
 */
export async function tryMailSource(slug: string, sourceId: string): Promise<MailState> {
  const ctx = await context(slug);
  if ("error" in ctx) return { error: ctx.error };
  if (!/^[a-z0-9]{6,16}$/.test(sourceId)) return { error: OOPS };
  if (!(await claudeLeft(ctx))) return { error: NO_CLAUDE };
  const admin = getAdminClient();
  const ws = await loadWorkspace(ctx.tenant.id, admin);
  if (!ws) return { error: OOPS };
  if (!canReadGmail(ws)) {
    return {
      error:
        "Gmail hasn't given permission to read yet. Connect Gmail and choose to let it read your suppliers' emails.",
    };
  }
  const look = looksFor(ws, CATCH_UP_DAYS).find((l) => l.source.source.id === sourceId);
  if (!look) return { error: "Save this source first, then try it." };
  const tokenDeps: TokenDeps = {
    store: vaultTokenStore(admin),
    adapter: getAdapter,
    now: Date.now,
    wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
  const deps = { ...intakeDeps(), admin, tokenDeps };
  const lines: string[] = [];
  const skipped: Skipped[] = [];
  let read = 0;
  try {
    const mailbox = await mailboxOf(ctx.tenant.id, deps);
    const page = await mailbox.list(look.query, 10);
    if (page.found.length === 0) {
      return {
        message: `Nothing from ${look.source.source.from} in the last ${CATCH_UP_DAYS} days matches this source.`,
      };
    }
    for (const found of page.found) {
      if (read >= MAX_MESSAGES_PER_TRY) break;
      const result = await readFound(ws, { ...found, source: look.source }, mailbox, deps, {
        confirm: false,
      });
      if (!result) continue;
      if (result.tokens > 0) {
        read += 1;
        await recordTokens(admin, ctx.tenant.id, result.tokens);
      }
      lines.push(...describe(result.entries, result.results));
      skipped.push(...result.skipped);
    }
  } catch (err) {
    if (err instanceof GmailReadError) return { error: err.message };
    if (err instanceof ReconnectRequiredError) {
      return { error: "Gmail needs reconnecting (under Connections) before it can be read." };
    }
    console.error("try-it failed", err instanceof Error ? err.message : err);
    return { error: OOPS };
  }
  return {
    message:
      lines.length > 0
        ? `Looked at the latest ${read} message${read === 1 ? "" : "s"}. This is what would be filed (nothing was):`
        : `Looked at ${read} message${read === 1 ? "" : "s"}: nothing in ${read === 1 ? "it" : "them"} would be filed.`,
    lines,
    skipped,
  };
}

/** Switches "Bills by email" on, or makes a new address (the old one stops working). */
export async function makeBillsAddress(slug: string): Promise<MailState> {
  const ctx = await context(slug);
  if ("error" in ctx) return { error: ctx.error };
  if (!inboundDomain()) return { error: "Receiving email isn't set up on this site yet." };
  const { error } = await ctx.supabase.rpc("make_bills_address", { p_tenant_id: ctx.tenant.id });
  if (error) return { error: error.code === "42501" ? NOT_ALLOWED : OOPS };
  done(slug);
  return { message: "Here's your address. Anything sent to an earlier one is no longer read." };
}

/** Switches "Bills by email" off: the address stops working. */
export async function removeBillsAddress(slug: string): Promise<MailState> {
  const ctx = await context(slug);
  if ("error" in ctx) return { error: ctx.error };
  const { error } = await ctx.supabase.rpc("remove_bills_address", { p_tenant_id: ctx.tenant.id });
  if (error) return { error: error.code === "42501" ? NOT_ALLOWED : OOPS };
  done(slug);
  return { message: "Switched off. Mail to the old address is no longer read." };
}

/** Puts Gmail's "confirm this address" note away once it's been dealt with. */
export async function clearBillsConfirmation(slug: string): Promise<void> {
  const ctx = await context(slug);
  if ("error" in ctx) return;
  const { error } = await ctx.supabase.rpc("clear_bills_confirmation", {
    p_tenant_id: ctx.tenant.id,
  });
  if (!error) done(slug);
}
