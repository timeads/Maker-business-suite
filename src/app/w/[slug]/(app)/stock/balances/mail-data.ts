import type { SupabaseClient } from "@supabase/supabase-js";
import { GMAIL_READ_SCOPE, googleMailConfigured } from "@/lib/connections/providers/google-mail";
import { inboundDomain } from "@/lib/helpdesk/addresses";
import { STOCK_MODULE } from "@/lib/stock/config";
import {
  STOCK_EMAIL_SOURCES_KEY,
  parseEmailSources,
  type EmailSources,
} from "@/lib/stock/mail/config";
import { parseStoredDocuments, type ReadDocument } from "@/lib/stock/mail/extract";
import { billsAddress } from "@/lib/stock/mail/forward";
import type { Skipped } from "@/lib/stock/mail/plan";

/** One look, forwarded message or uploaded file, as the pages show it. */
export type MailRead = {
  id: string;
  status: "queued" | "running" | "done" | "failed";
  source: "schedule" | "manual" | "forward" | "upload";
  at: string;
  counts: { seen: number; read: number; filed: number; toCheck: number; capped: boolean };
  skipped: Skipped[];
  error: string | null;
};

export type PendingMail = {
  id: string;
  messageKey: string;
  sentDay: string;
  sender: string;
  subject: string;
  documents: ReadDocument[];
};

/** Everything the Balances pages show about entries arriving by email. */
export type MailFacts = {
  sources: EmailSources;
  /** When the sources were last saved (ISO), if ever. */
  sourcesSavedAt: string | null;
  /** This deployment has a Google app, so Gmail can be connected at all. */
  gmailOffered: boolean;
  gmail: "none" | "send_only" | "can_read" | "needs_reconnect";
  /** Reading Gmail is on: switched on, and the permission given. */
  readingOn: boolean;
  /** This deployment receives mail, so a bills address can be made. */
  forwardingOffered: boolean;
  /** The workspace's bills address, when "Bills by email" is on. */
  bills: {
    address: string;
    lastReceivedAt: string | null;
    confirm: {
      code: string | null;
      link: string | null;
      account: string | null;
      at: string;
    } | null;
  } | null;
  /** Newest first, the last few weeks. */
  reads: MailRead[];
  pending: PendingMail[];
};

const number = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? value : 0;

/**
 * Read as the signed-in member. Only owners and admins get anything back
 * from these tables, so a page checks the role first. Each query is allowed
 * to fail: the balances themselves never depend on this.
 */
export async function loadMailFacts(
  supabase: SupabaseClient,
  tenant: { id: string },
): Promise<MailFacts> {
  const since = new Date(Date.now() - 21 * 24 * 60 * 60 * 1000).toISOString();
  const [config, connection, reads, pending, address] = await Promise.all([
    supabase
      .from("configs")
      .select("body, updated_at")
      .eq("tenant_id", tenant.id)
      .eq("module", STOCK_MODULE)
      .eq("key", STOCK_EMAIL_SOURCES_KEY)
      .maybeSingle(),
    // Named columns only: members can't read the whole row.
    supabase
      .from("connections")
      .select("status, scopes")
      .eq("tenant_id", tenant.id)
      .eq("provider", "google_mail")
      .maybeSingle(),
    supabase
      .from("stock_email_reads")
      .select("id, status, source, created_at, finished_at, counts, skipped, error")
      .eq("tenant_id", tenant.id)
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .limit(60),
    supabase
      .from("stock_email_pending")
      .select("id, message_key, sent_day, sender, subject, documents")
      .eq("tenant_id", tenant.id)
      .order("created_at", { ascending: false })
      .limit(50),
    supabase
      .from("stock_bills_addresses")
      .select("token, last_received_at, confirm_code, confirm_link, confirm_for, confirm_at")
      .eq("tenant_id", tenant.id)
      .maybeSingle(),
  ]);

  const sources = parseEmailSources(config.data?.body);
  const scopes = (connection.data?.scopes as string[] | null) ?? [];
  const status = connection.data?.status as string | undefined;
  const gmail: MailFacts["gmail"] =
    status === "needs_reconnect"
      ? "needs_reconnect"
      : status !== "active"
        ? "none"
        : scopes.includes(GMAIL_READ_SCOPE)
          ? "can_read"
          : "send_only";
  const domain = inboundDomain();
  const row = address.data as {
    token: string;
    last_received_at: string | null;
    confirm_code: string | null;
    confirm_link: string | null;
    confirm_for: string | null;
    confirm_at: string | null;
  } | null;

  return {
    sources,
    sourcesSavedAt: (config.data?.updated_at as string | undefined) ?? null,
    gmailOffered: googleMailConfigured(),
    gmail,
    readingOn: sources.enabled && gmail === "can_read",
    forwardingOffered: domain !== null,
    bills:
      row && domain
        ? {
            address: billsAddress(row.token, domain),
            lastReceivedAt: row.last_received_at,
            confirm: row.confirm_at
              ? {
                  code: row.confirm_code,
                  link: row.confirm_link,
                  account: row.confirm_for,
                  at: row.confirm_at,
                }
              : null,
          }
        : null,
    reads: ((reads.data ?? []) as Record<string, unknown>[]).map((r) => {
      const counts = (r.counts ?? {}) as Record<string, unknown>;
      return {
        id: String(r.id),
        status: r.status as MailRead["status"],
        source: r.source as MailRead["source"],
        at: String(r.finished_at ?? r.created_at),
        counts: {
          seen: number(counts.seen),
          read: number(counts.read),
          filed: number(counts.filed),
          toCheck: number(counts.to_check),
          capped: counts.capped === true,
        },
        skipped: Array.isArray(r.skipped)
          ? (r.skipped as Record<string, unknown>[])
              .filter((s) => typeof s?.what === "string" && typeof s?.reason === "string")
              .map((s) => ({ what: String(s.what), reason: String(s.reason) }))
          : [],
        error: typeof r.error === "string" ? r.error : null,
      };
    }),
    pending: ((pending.data ?? []) as Record<string, unknown>[]).map((p) => ({
      id: String(p.id),
      messageKey: String(p.message_key),
      sentDay: String(p.sent_day).slice(0, 10),
      sender: String(p.sender ?? ""),
      subject: String(p.subject ?? ""),
      documents: parseStoredDocuments(p.documents),
    })),
  };
}

/** The newest look at Gmail that finished well, and the newest that failed. */
export function lookFacts(reads: MailRead[]) {
  const looks = reads.filter((r) => r.source === "schedule" || r.source === "manual");
  const good = looks.find((r) => r.status === "done") ?? null;
  const newest = looks.find((r) => r.status === "done" || r.status === "failed") ?? null;
  return {
    lastGood: good,
    lastFailed:
      newest?.status === "failed"
        ? { at: newest.at, error: newest.error ?? "It didn't finish." }
        : null,
    underway: looks.some((r) => r.status === "queued" || r.status === "running"),
  };
}

/** What recent reads left out, newest first, without repeats. */
export function recentSkipped(reads: MailRead[], max = 30): (Skipped & { at: string })[] {
  const seen = new Set<string>();
  const out: (Skipped & { at: string })[] = [];
  for (const read of reads) {
    for (const s of read.skipped) {
      const key = `${s.what}|${s.reason}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ ...s, at: read.at });
      if (out.length >= max) return out;
    }
  }
  return out;
}
