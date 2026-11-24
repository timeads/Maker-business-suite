import { GMAIL_READ_SCOPE } from "../../connections/providers/google-mail";
import { getProviderToken, type TokenDeps } from "../../connections/tokens";
import { ReconnectRequiredError } from "../../connections/types";
import { GmailReadError, gmailMailbox, type FetchedMessage, type Mailbox } from "./gmail";
import {
  claudeAllowanceLeft,
  intakeMessage,
  loadWorkspace,
  messageSeen,
  messagesLeftToday,
  noteUnread,
  recordTokens,
  type IntakeDeps,
  type IntakeResult,
  type Workspace,
} from "./intake";
import {
  MAX_FILES_PER_MESSAGE,
  MAX_FILE_BYTES,
  MAX_MESSAGES_PER_LOOK,
  MAX_MESSAGES_PER_SOURCE,
  fileKind,
  looksLike,
  messageKey,
  topMessage,
  type MailFile,
  type MailMessage,
} from "./message";
import type { Skipped } from "./plan";
import {
  CATCH_UP_DAYS,
  DAILY_LOOKBACK_DAYS,
  bankQuery,
  fileSkipped,
  payeeFor,
  senderAddress,
  senderMatches,
  subjectMatches,
  supplierQuery,
  type SourceMatch,
} from "./query";
import type { BankSource, SupplierSource } from "./config";
import { withTenant } from "../../supabase/admin";

/**
 * One look at a workspace's Gmail for mail from its listed senders. For each
 * source: search with that source's own query, leave out what was looked at
 * before, check the sender on every message, read it, file it. Everything is
 * capped, and a cap that was hit is said in the run's record.
 */

export type ClaimedRead = { id: string; tenant_id: string; source: string };

export type LookDeps = IntakeDeps & {
  tokenDeps: TokenDeps;
  /** For tests: the mailbox to read, instead of the workspace's own. */
  mailboxFor?: (tenantId: string) => Promise<Mailbox>;
};

export type LookCounts = {
  seen: number;
  read: number;
  filed: number;
  to_check: number;
  skipped: number;
  capped: boolean;
};

type Found = {
  id: string;
  threadId: string;
  source: { kind: "supplier"; source: SupplierSource } | { kind: "bank"; source: BankSource };
};

class LookStopped extends Error {}

/** The files of a message worth reading, with what was left out and why. */
export async function pickFiles(
  fetched: FetchedMessage,
  mailbox: Mailbox,
  skipWords: readonly string[],
): Promise<{ files: MailFile[]; notes: Skipped[] }> {
  const files: MailFile[] = [];
  const notes: Skipped[] = [];
  for (const att of fetched.attachments) {
    const name = att.name || "a file";
    const kind = fileKind(att.name, att.mimeType);
    if (!kind) continue; // signatures, logos, calendar files: not worth a line
    if (fileSkipped(att.name, skipWords)) {
      notes.push({ what: name, reason: "its name is on this source's “never read” list" });
      continue;
    }
    if (att.size > MAX_FILE_BYTES) {
      notes.push({ what: name, reason: "the file is over 5 MB — add it by hand" });
      continue;
    }
    if (files.length >= MAX_FILES_PER_MESSAGE) {
      notes.push({
        what: name,
        reason: `only the first ${MAX_FILES_PER_MESSAGE} files of a message are read`,
      });
      continue;
    }
    const bytes = await mailbox.attachment(fetched.id, att.attachmentId);
    if (bytes.length > MAX_FILE_BYTES) {
      notes.push({ what: name, reason: "the file is over 5 MB — add it by hand" });
      continue;
    }
    if (!looksLike(kind, bytes)) {
      notes.push({ what: name, reason: "the file isn't what its name says it is" });
      continue;
    }
    files.push({ name: att.name, kind, base64: Buffer.from(bytes).toString("base64") });
  }
  return { files, notes };
}

async function seenBefore(ws: Workspace, deps: LookDeps, ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  return withTenant(
    ws.tenantId,
    async (scope) => {
      const { data, error } = await scope
        .select("stock_email_messages", "gmail_id")
        .in("gmail_id", ids);
      if (error) throw new Error(`Could not read seen messages: ${error.message}`);
      return new Set(((data ?? []) as unknown as { gmail_id: string }[]).map((r) => r.gmail_id));
    },
    deps.admin,
  );
}

/**
 * Reads one found message. Returns null when it turned out not to be from
 * the source's sender (the business's own reply in the thread, say): such a
 * message is left alone and nothing about it is kept.
 */
export async function readFound(
  ws: Workspace,
  found: Found,
  mailbox: Mailbox,
  deps: LookDeps,
  opts: { readId?: string | null; confirm?: boolean } = {},
): Promise<IntakeResult | null> {
  const fetched = await mailbox.get(found.id);
  const { source } = found;
  if (
    !senderMatches(fetched.fromHeader, source.source.from) ||
    !subjectMatches(fetched.subject, source.source.subject_words)
  ) {
    return null;
  }
  const key = messageKey(fetched.rfcMessageId, `gmail:${fetched.id}`);
  const record = {
    messageKey: key,
    route: "gmail" as const,
    gmailId: found.id,
    threadId: found.threadId,
  };
  // The same message may have reached us already through the bills address.
  if (opts.confirm !== false && (await messageSeen(ws.tenantId, deps.admin, key))) return null;

  const text = topMessage(fetched.text);
  const head = {
    from: senderAddress(fetched.fromHeader),
    subject: fetched.subject,
    sentAt: fetched.sentAt,
  };

  let match: Extract<SourceMatch, { kind: "supplier" | "bank" }>;
  if (source.kind === "bank") {
    // Whose payment it is is worked out from the workspace's own words. A
    // notice about anyone else is never handed to the reader.
    const payee = payeeFor(source.source, fetched.subject, fetched.text);
    if (!("supplierId" in payee)) {
      if (opts.confirm === false) {
        return {
          outcome: "skipped",
          entries: [],
          results: [],
          skipped: [
            {
              what: fetched.subject || "a bank notice",
              reason:
                "several" in payee
                  ? "it matches more than one supplier's words"
                  : "not about a supplier you listed, so it wasn't read",
            },
          ],
          filed: 0,
          toCheck: 0,
          tokens: 0,
        };
      }
      if ("several" in payee) {
        await noteUnread(
          ws,
          record,
          head,
          {
            what: fetched.subject || "a bank notice",
            reason: "it matches more than one supplier's words — add the payment by hand",
          },
          deps,
          opts.readId ?? null,
        );
      }
      return null;
    }
    match = { kind: "bank", source: source.source, supplierId: payee.supplierId };
  } else {
    match = { kind: "supplier", source: source.source };
  }

  const wantsFiles = source.kind === "supplier" && source.source.reads !== "message";
  const wantsText = source.kind === "bank" || source.source.reads !== "attachments";
  const picked = wantsFiles
    ? await pickFiles(
        fetched,
        mailbox,
        source.kind === "supplier" ? source.source.skip_file_words : [],
      )
    : { files: [], notes: [] };
  if (!wantsText && picked.files.length === 0) {
    if (opts.confirm !== false) {
      await noteUnread(
        ws,
        record,
        head,
        picked.notes[0] ?? {
          what: fetched.subject || "a message",
          reason: "no file in it to read",
        },
        deps,
        opts.readId ?? null,
      );
    }
    return {
      outcome: "skipped",
      entries: [],
      results: [],
      skipped:
        picked.notes.length > 0
          ? picked.notes
          : [{ what: fetched.subject || "a message", reason: "no file in it to read" }],
      filed: 0,
      toCheck: 0,
      tokens: 0,
    };
  }
  const message: MailMessage = { ...head, text: wantsText ? text : "", files: picked.files };
  return intakeMessage(
    ws,
    { record, message, match, notes: picked.notes, readId: opts.readId, confirm: opts.confirm },
    deps,
  );
}

/** What a look would search for, source by source. */
export function looksFor(
  ws: Workspace,
  days: number,
): { query: string; source: Found["source"] }[] {
  return [
    ...ws.sources.suppliers.map((source) => ({
      query: supplierQuery(source, days),
      source: { kind: "supplier" as const, source },
    })),
    ...ws.sources.bank
      .filter((source) => source.payees.length > 0)
      .map((source) => ({
        query: bankQuery(source, days),
        source: { kind: "bank" as const, source },
      })),
  ];
}

export async function mailboxOf(tenantId: string, deps: LookDeps): Promise<Mailbox> {
  if (deps.mailboxFor) return deps.mailboxFor(tenantId);
  const stored = await getProviderToken(tenantId, "google_mail", deps.tokenDeps);
  return gmailMailbox(stored.token.access_token);
}

export const canReadGmail = (ws: Workspace) => ws.gmailScopes.includes(GMAIL_READ_SCOPE);

/** Runs one claimed look to its end and closes it. Never throws. */
export async function runClaimedRead(read: ClaimedRead, deps: LookDeps): Promise<string> {
  const { admin } = deps;
  const counts: LookCounts = { seen: 0, read: 0, filed: 0, to_check: 0, skipped: 0, capped: false };
  const skipped: Skipped[] = [];
  let status: "done" | "failed" = "done";
  let error: string | null = null;
  let tokens = 0;
  try {
    const ws = await loadWorkspace(read.tenant_id, admin);
    if (!ws) throw new LookStopped("That workspace is gone.");
    if (!ws.sources.enabled) throw new LookStopped("Reading supplier emails is switched off.");
    // Every read is gated on what Google really granted.
    if (!canReadGmail(ws)) {
      throw new LookStopped(
        "Gmail hasn't given permission to read. Connect Gmail again and choose to let it read your suppliers' emails.",
      );
    }
    let allowance = await claudeAllowanceLeft(read.tenant_id, admin, deps.now());
    if (allowance <= 0) {
      throw new LookStopped(
        "This month's Claude allowance is used up (or Stock isn't part of the plan), so nothing was read.",
      );
    }
    let left = Math.min(
      MAX_MESSAGES_PER_LOOK,
      await messagesLeftToday(read.tenant_id, admin, deps.now()),
    );
    const mailbox = await mailboxOf(read.tenant_id, deps);

    // The first look goes back further, to catch up; after that, ten days.
    const firstLook = await withTenant(
      read.tenant_id,
      async (scope) => {
        const { data } = await scope
          .select("stock_email_reads", "id")
          .eq("status", "done")
          .in("source", ["schedule", "manual"])
          .limit(1);
        return (data ?? []).length === 0;
      },
      admin,
    );
    const days = firstLook ? CATCH_UP_DAYS : DAILY_LOOKBACK_DAYS;

    const found: Found[] = [];
    const known = new Set<string>();
    for (const look of looksFor(ws, days)) {
      const page = await mailbox.list(look.query, MAX_MESSAGES_PER_SOURCE);
      if (page.more) {
        counts.capped = true;
        skipped.push({
          what: `mail from ${look.source.source.from}`,
          reason: `more than ${MAX_MESSAGES_PER_SOURCE} messages matched; the rest wait for the next read`,
        });
      }
      for (const m of page.found) {
        if (known.has(m.id)) continue;
        known.add(m.id);
        found.push({ ...m, source: look.source });
      }
    }
    counts.seen = found.length;
    const seen = await seenBefore(
      ws,
      deps,
      found.map((f) => f.id),
    );
    // Oldest first, so the ledger reads in the order things happened.
    const fresh = found.filter((f) => !seen.has(f.id)).reverse();

    for (const item of fresh) {
      if (left <= 0) {
        counts.capped = true;
        skipped.push({
          what: `${fresh.length - counts.read} more message${fresh.length - counts.read === 1 ? "" : "s"}`,
          reason: "today's limit on messages read was reached; they wait for the next read",
        });
        break;
      }
      if (allowance <= 0) {
        counts.capped = true;
        skipped.push({
          what: "the rest of this read",
          reason: "this month's Claude allowance ran out",
        });
        break;
      }
      const result = await readFound(ws, item, mailbox, deps, { readId: read.id });
      if (!result || result.outcome === "repeated") continue;
      if (result.tokens > 0) {
        counts.read += 1;
        left -= 1;
        allowance -= result.tokens;
        tokens += result.tokens;
        await recordTokens(admin, read.tenant_id, result.tokens);
      }
      counts.filed += result.filed;
      counts.to_check += result.toCheck;
      skipped.push(...result.skipped);
    }
  } catch (err) {
    status = "failed";
    if (err instanceof LookStopped || err instanceof GmailReadError) error = err.message;
    else if (err instanceof ReconnectRequiredError) {
      error = "Gmail needs reconnecting (under Connections) before it can be read.";
    } else {
      console.error(`email read ${read.id} failed`, err instanceof Error ? err.message : err);
      error = "Something went wrong during this read. The next one will try again.";
    }
  }
  counts.skipped = skipped.length;
  const { error: finishError } = await admin.rpc("finish_stock_email_read", {
    p_read_id: read.id,
    p_status: status,
    p_counts: counts,
    p_skipped: skipped.slice(0, 60),
    p_error: error,
  });
  if (finishError) console.error(`could not close email read ${read.id}: ${finishError.message}`);
  return `${status}: ${counts.read} read, ${counts.filed} filed, ${counts.to_check} to check, ${tokens} tokens`;
}
