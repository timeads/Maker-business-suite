import type { SupabaseClient } from "@supabase/supabase-js";
import {
  GRANT_COLUMNS,
  SUMMARY_COLUMNS,
  resolveEntitlements,
  type PlanGrant,
} from "../../entitlements";
import { withTenant } from "../../supabase/admin";
import { STOCK_MODULE } from "../config";
import { STOCK_EMAIL_SOURCES_KEY, parseEmailSources, type EmailSources } from "./config";
import type { ReadDocument } from "./extract";
import { MAX_MESSAGES_PER_DAY, dayIn, type MailMessage } from "./message";
import { planDocuments, type Candidate, type PlanContext, type Skipped } from "./plan";
import type { SourceMatch } from "./query";
import type { ReadHint, ReadResult } from "./reader";

/**
 * The one road every bill takes once it is in hand, whichever way it came
 * (read from Gmail, forwarded to the bills address, uploaded): read it, check
 * the answer, plan the entries, and file them through `file_email_entries`.
 * Tenant data is only touched through `withTenant` or a function that names
 * the workspace. The message's text and files are not kept.
 */

export type Workspace = {
  tenantId: string;
  timezone: string;
  currency: string;
  sources: EmailSources;
  /** The workspace's suppliers, so a source pointing at one that's gone is ignored. */
  supplierIds: Set<string>;
  /** What Google granted the Gmail connection, if there is one that works. */
  gmailScopes: string[];
};

export type Reader = (message: MailMessage, hint: ReadHint) => Promise<ReadResult>;

export type IntakeDeps = {
  admin: SupabaseClient;
  read: Reader;
  now(): Date;
};

export async function loadWorkspace(
  tenantId: string,
  admin: SupabaseClient,
): Promise<Workspace | null> {
  const { data: tenants } = await admin
    .from("tenants")
    .select("timezone, currency")
    .eq("id", tenantId);
  const tenant = (tenants as { timezone: string; currency: string }[] | null)?.[0];
  if (!tenant) return null;
  return withTenant(
    tenantId,
    async (scope) => {
      const [{ data: config }, { data: suppliers }, { data: connection }] = await Promise.all([
        scope
          .select("configs", "body")
          .eq("module", STOCK_MODULE)
          .eq("key", STOCK_EMAIL_SOURCES_KEY)
          .maybeSingle(),
        scope.select("suppliers", "id").limit(1000),
        scope.select("connections", "scopes, status").eq("provider", "google_mail").maybeSingle(),
      ]);
      const supplierIds = new Set(
        ((suppliers ?? []) as unknown as { id: string }[]).map((s) => s.id),
      );
      const sources = parseEmailSources((config as { body?: unknown } | null)?.body);
      const conn = connection as { scopes: string[] | null; status: string } | null;
      return {
        tenantId,
        timezone: tenant.timezone,
        currency: tenant.currency,
        // A source for a supplier that has since been deleted matches nothing.
        sources: {
          ...sources,
          suppliers: sources.suppliers.filter((s) => supplierIds.has(s.supplier_id)),
          bank: sources.bank.map((b) => ({
            ...b,
            payees: b.payees.filter((p) => supplierIds.has(p.supplier_id)),
          })),
        },
        supplierIds,
        gmailScopes: conn?.status === "active" ? (conn.scopes ?? []) : [],
      };
    },
    admin,
  );
}

/**
 * How much of this month's Claude allowance the workspace has left, worked
 * out the way the drafting tools do: the plan's `ai_credits` (through the one
 * resolver, CLAUDE.md rule 7) less the tokens used since the month began.
 * Zero also when Stock isn't part of the plan or the workspace is read-only.
 */
export async function claudeAllowanceLeft(
  tenantId: string,
  admin: SupabaseClient,
  now: Date = new Date(),
): Promise<number> {
  const monthStart = new Date(now);
  monthStart.setUTCDate(1);
  monthStart.setUTCHours(0, 0, 0, 0);
  return withTenant(
    tenantId,
    async (scope) => {
      const [{ data }, grant, { data: usage }] = await Promise.all([
        scope.select("subscriptions", SUMMARY_COLUMNS).maybeSingle(),
        scope.select("plan_grants", GRANT_COLUMNS).maybeSingle(),
        scope
          .select("usage_events", "quantity")
          .eq("type", "ai_tokens")
          .gte("occurred_at", monthStart.toISOString())
          .limit(5000),
      ]);
      const entitlements = resolveEntitlements(
        data as never,
        grant.error ? null : (grant.data as PlanGrant | null),
      );
      if (!entitlements.canWrite || !entitlements.can("module.stock")) return 0;
      const used = ((usage ?? []) as unknown as { quantity: number | string }[]).reduce(
        (sum, row) => sum + Number(row.quantity),
        0,
      );
      return Math.max(0, entitlements.limit("ai_credits") - used);
    },
    admin,
  );
}

/** How many more messages may be read for the workspace in this 24 hours. */
export async function messagesLeftToday(
  tenantId: string,
  admin: SupabaseClient,
  now: Date = new Date(),
): Promise<number> {
  const since = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
  const count = await withTenant(
    tenantId,
    async (scope) => {
      const { data, error } = await scope
        .select("stock_email_messages", "id")
        .gte("created_at", since)
        .limit(MAX_MESSAGES_PER_DAY + 1);
      if (error) throw new Error(`Could not count messages: ${error.message}`);
      return (data ?? []).length;
    },
    admin,
  );
  return Math.max(0, MAX_MESSAGES_PER_DAY - count);
}

/** Has this message been looked at before, by any road? */
export async function messageSeen(
  tenantId: string,
  admin: SupabaseClient,
  key: string,
): Promise<boolean> {
  return withTenant(
    tenantId,
    async (scope) => {
      const { data, error } = await scope
        .select("stock_email_messages", "id")
        .eq("message_key", key)
        .limit(1);
      if (error) throw new Error(`Could not read seen messages: ${error.message}`);
      return (data ?? []).length > 0;
    },
    admin,
  );
}

/** How many reads today were turned away at a limit: past a few, nothing more is written. */
export async function turnedAwayToday(
  tenantId: string,
  admin: SupabaseClient,
  now: Date = new Date(),
): Promise<number> {
  const since = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
  return withTenant(
    tenantId,
    async (scope) => {
      const { data } = await scope
        .select("stock_email_reads", "id")
        .eq("source", "forward")
        .gte("created_at", since)
        .contains("counts", { capped: true })
        .limit(10);
      return (data ?? []).length;
    },
    admin,
  );
}

export type FiledResult = {
  external_key: string;
  outcome:
    | "added"
    | "changed"
    | "flagged"
    | "same"
    | "covered"
    | "older_statement"
    | "have_already"
    | "taken_off";
  detail: string | null;
  id: string | null;
};

const what = (entry: Candidate) =>
  entry.type === "invoice"
    ? `invoice ${entry.reference}`
    : entry.type === "statement"
      ? `statement of ${entry.entry_date}`
      : `payment of ${entry.amount} on ${entry.entry_date}`;

/** Why the account didn't take an entry, in words. Null when it did, or already had it. */
export function leftOutReason(entry: Candidate, result: FiledResult): Skipped | null {
  switch (result.outcome) {
    case "covered":
      return {
        what: what(entry),
        reason: `dated ${entry.entry_date}, already in the statement of ${result.detail}`,
      };
    case "older_statement":
      return { what: what(entry), reason: `older than the statement of ${result.detail} on file` };
    case "have_already":
      return { what: what(entry), reason: "that payment is on the account already" };
    case "taken_off":
      return { what: what(entry), reason: "you removed it before, so it stays off" };
    default:
      return null;
  }
}

export type MessageRecord = {
  messageKey: string;
  route: "gmail" | "forward";
  gmailId: string | null;
  threadId: string | null;
};

export type IntakeResult = {
  /** How the message ended: what `stock_email_messages.outcome` says, or "repeated". */
  outcome: "filed" | "to_check" | "unassigned" | "skipped" | "repeated";
  entries: Candidate[];
  results: FiledResult[];
  skipped: Skipped[];
  filed: number;
  toCheck: number;
  tokens: number;
};

async function file(
  admin: SupabaseClient,
  args: {
    tenantId: string;
    message: Record<string, unknown> | null;
    entries: Candidate[];
    readId?: string | null;
    pendingId?: string | null;
    confirm?: boolean;
    actor?: string | null;
  },
): Promise<{ repeated: boolean; outcome: IntakeResult["outcome"] | null; results: FiledResult[] }> {
  const { data, error } = await admin.rpc("file_email_entries", {
    p_tenant_id: args.tenantId,
    p_message: args.message,
    p_entries: args.entries,
    p_read_id: args.readId ?? null,
    p_pending_id: args.pendingId ?? null,
    p_confirm: args.confirm ?? true,
    p_actor: args.actor ?? null,
  });
  if (error) throw new Error(`file_email_entries failed: ${error.message}`);
  return data as { repeated: boolean; outcome: IntakeResult["outcome"]; results: FiledResult[] };
}

function tally(entries: Candidate[], results: FiledResult[], skipped: Skipped[]) {
  let filed = 0;
  let toCheck = 0;
  const byKey = new Map(entries.map((e) => [e.external_key, e]));
  for (const result of results) {
    const entry = byKey.get(result.external_key);
    if (!entry) continue;
    if (result.outcome === "added" || result.outcome === "changed") filed += 1;
    if (
      result.outcome === "changed" ||
      result.outcome === "flagged" ||
      (result.outcome === "added" && entry.needs_review)
    ) {
      toCheck += 1;
    }
    const reason = leftOutReason(entry, result);
    if (reason) skipped.push(reason);
  }
  return { filed, toCheck };
}

/**
 * Reads one message and files what it holds. `match` says whose it is; with
 * no match (a forwarded message nobody could place) what was read waits for
 * a manager to give it a supplier. `confirm: false` is "Try it": the whole
 * thing is done and undone, and the answer says what would have happened.
 */
export async function intakeMessage(
  ws: Workspace,
  input: {
    record: MessageRecord;
    message: MailMessage;
    /** Whose it is; a function when that needs the reader's "originally from". */
    match:
      | Extract<SourceMatch, { kind: "supplier" | "bank" }>
      | null
      | ((
          originalSender: string | null,
        ) => Extract<SourceMatch, { kind: "supplier" | "bank" }> | null);
    /** Things already left out before reading (a file over the size cap…). */
    notes?: Skipped[];
    readId?: string | null;
    confirm?: boolean;
  },
  deps: IntakeDeps,
): Promise<IntakeResult> {
  const skipped: Skipped[] = [...(input.notes ?? [])];
  const { record, message } = input;
  const fixed = typeof input.match === "function" ? null : input.match;
  const read = await deps.read(message, {
    currency: ws.currency,
    kind:
      fixed?.kind === "bank"
        ? "a bank's notice of a payment sent"
        : fixed?.kind === "supplier" && fixed.source.kind !== "mixed"
          ? `${fixed.source.kind}s`
          : "invoices, statements or payments (decide per document)",
  });
  let documents: ReadDocument[] = [];
  let originalSender: string | null = null;
  if (read.ok) {
    documents = read.documents;
    originalSender = read.originalSender;
  } else {
    skipped.push({
      what: message.subject || "a message",
      reason:
        read.reason === "declined"
          ? "the reader declined to read it — add it by hand"
          : "the reader's answer couldn't be used — add it by hand",
    });
  }
  const match = typeof input.match === "function" ? input.match(originalSender) : input.match;
  const day = dayIn(message.sentAt, ws.timezone);
  const base = {
    message_key: record.messageKey,
    route: record.route,
    gmail_id: record.gmailId,
    thread_id: record.threadId,
    sent_at: message.sentAt.toISOString(),
    sender: message.from.slice(0, 200),
    subject: message.subject.slice(0, 300),
  };

  let entries: Candidate[] = [];
  let pending: { sent_day: string; documents: ReadDocument[] } | undefined;
  if (match) {
    const ctx: PlanContext = {
      supplierId: match.kind === "bank" ? match.supplierId : match.source.supplier_id,
      kind: match.kind === "bank" ? "bank" : match.source.kind,
      alwaysCheck: match.kind === "supplier" && match.source.always_check,
      currency: ws.currency,
      messageId: record.messageKey,
      day,
    };
    const plan = planDocuments(documents, ctx);
    entries = plan.entries;
    skipped.push(...plan.skipped);
  } else {
    const useful = documents.filter((d) => d.kind !== "other" && d.kind !== "estimate");
    if (useful.length > 0) pending = { sent_day: day, documents: useful };
    else if (read.ok) {
      skipped.push({
        what: message.subject || "a message",
        reason: "nothing in it to file",
      });
    }
  }

  const filedAnswer = await file(deps.admin, {
    tenantId: ws.tenantId,
    message: {
      ...base,
      supplier_id: match
        ? match.kind === "bank"
          ? match.supplierId
          : match.source.supplier_id
        : null,
      notes: skipped.slice(0, 30),
      ...(pending ? { pending } : {}),
    },
    entries,
    readId: input.readId,
    confirm: input.confirm,
  });
  if (filedAnswer.repeated) {
    return {
      outcome: "repeated",
      entries: [],
      results: [],
      skipped: [],
      filed: 0,
      toCheck: 0,
      tokens: read.tokens,
    };
  }
  const counts = tally(entries, filedAnswer.results, skipped);
  return {
    outcome: filedAnswer.outcome ?? "skipped",
    entries,
    results: filedAnswer.results,
    skipped,
    ...counts,
    toCheck: counts.toCheck + (pending ? 1 : 0),
    tokens: read.tokens,
  };
}

/** Notes a message that was looked at and left unread (over a cap, say), so it isn't met again. */
export async function noteUnread(
  ws: Workspace,
  record: MessageRecord,
  message: Pick<MailMessage, "from" | "subject" | "sentAt">,
  reason: Skipped,
  deps: Pick<IntakeDeps, "admin">,
  readId: string | null = null,
): Promise<void> {
  await file(deps.admin, {
    tenantId: ws.tenantId,
    message: {
      message_key: record.messageKey,
      route: record.route,
      gmail_id: record.gmailId,
      thread_id: record.threadId,
      sent_at: message.sentAt.toISOString(),
      sender: message.from.slice(0, 200),
      subject: message.subject.slice(0, 300),
      supplier_id: null,
      notes: [reason],
    },
    entries: [],
    readId,
  });
}

/** Files the entries planned for a waiting message once a manager has said whose it is. */
export async function filePending(
  admin: SupabaseClient,
  args: {
    tenantId: string;
    pendingId: string;
    messageKey: string;
    supplierId: string;
    entries: Candidate[];
    actor: string;
  },
): Promise<{ results: FiledResult[]; filed: number; toCheck: number; skipped: Skipped[] }> {
  const answer = await file(admin, {
    tenantId: args.tenantId,
    // Only the key and the route matter here: the message is already on record.
    message: { message_key: args.messageKey, route: "forward", supplier_id: args.supplierId },
    entries: args.entries,
    pendingId: args.pendingId,
    actor: args.actor,
  });
  const skipped: Skipped[] = [];
  return { results: answer.results, ...tally(args.entries, answer.results, skipped), skipped };
}

/** Files what was read out of an uploaded file. */
export async function fileUpload(
  admin: SupabaseClient,
  args: { tenantId: string; entries: Candidate[]; actor: string; confirm?: boolean },
): Promise<{ results: FiledResult[]; filed: number; toCheck: number; skipped: Skipped[] }> {
  const answer = await file(admin, {
    tenantId: args.tenantId,
    message: null,
    entries: args.entries,
    actor: args.actor,
    confirm: args.confirm,
  });
  const skipped: Skipped[] = [];
  return { results: answer.results, ...tally(args.entries, answer.results, skipped), skipped };
}

/** Counts Claude's tokens against the workspace's allowance. Never throws. */
export async function recordTokens(admin: SupabaseClient, tenantId: string, tokens: number) {
  if (tokens <= 0) return;
  const { error } = await admin.rpc("record_usage", {
    p_tenant_id: tenantId,
    p_type: "ai_tokens",
    p_quantity: tokens,
  });
  if (error) console.error(`Could not record AI usage: ${error.message}`);
}
