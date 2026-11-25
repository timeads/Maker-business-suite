import { z } from "zod";
import { TAG_PATTERN } from "./config";
import { outgoingText, type Outgoing } from "./outbound";
import { ReplyRefused, refusalWords } from "./reply";
import { richDocSchema } from "./rich";
import { refusalDetails, refusalWords as metaRefusalWords } from "./social/graph";

/**
 * Email waiting to go. "Undo send" is a short wait on the server: the email
 * is put in a queue with everything needed to send it, the worker sends it
 * when its time comes, and until then it can be taken back. Pure: the shape
 * of what is queued, and the words for how it went.
 */

const address = z.string().max(254);

export const sendPayloadSchema = z.object({
  kind: z.enum(["reply", "forward"]),
  to: z.array(address).min(1).max(10),
  cc: z.array(address).max(10).default([]),
  bcc: z.array(address).max(10).default([]),
  /** The person's words, always. */
  doc: richDocSchema,
  /** The same document when it carries formatting, to be kept on the message; null for plain words. */
  format: richDocSchema.nullable().default(null),
  /** Plain text under the person's words (the forwarded conversation). */
  appendix: z.string().max(40_000).optional(),
  then: z.enum(["pending", "open", "closed", "snoozed", "keep"]),
  snooze_until: z.string().datetime().nullable().default(null),
  files: z
    .array(
      z.object({
        name: z.string().max(300),
        type: z.string().max(120),
        size: z.number().int().nonnegative(),
        base64: z.string(),
      }),
    )
    .max(25)
    .default([]),
  add_tags: z.array(z.string().regex(TAG_PATTERN)).max(10).default([]),
  assign_to: z.string().uuid().nullable().default(null),
});
export type SendPayload = z.infer<typeof sendPayloadSchema>;

/** What the conversation shows while an email waits: no files, a few words. */
export function summaryOf(payload: SendPayload) {
  return {
    kind: payload.kind,
    to: payload.to,
    preview: outgoingText(payload.doc).replace(/\s+/g, " ").slice(0, 200),
  };
}

/** The queued email as the mail request's own input, for the worker. */
export function outgoingFrom(
  payload: SendPayload,
  where: {
    workspaceName: string;
    slug: string;
    domain: string;
    replyKey: string;
    subject: string;
    inReplyTo: string | null;
  },
): Outgoing {
  return {
    ...where,
    kind: payload.kind,
    to: payload.to,
    cc: payload.cc,
    bcc: payload.bcc,
    doc: payload.doc,
    appendix: payload.appendix,
    files: payload.files,
  };
}

/** The words kept as the message once it has gone. */
export const bodyOf = (payload: SendPayload): string =>
  outgoingText(payload.doc, payload.kind === "forward" ? undefined : payload.appendix) ||
  "(forwarded)";

/** How a refused send is written down: the service's numbers only, never its words. */
export const refusalCode = (err: ReplyRefused): string =>
  `postmark:${err.status}:${err.code ?? "none"}`;

export type OutboxRow = {
  id: string;
  state: "waiting" | "sending" | "failed" | "unsure";
  send_at: string;
  summary: { kind?: string; to?: string[]; preview?: string } | null;
  error: string | null;
  author_id: string | null;
  created_at: string;
  doc: unknown;
};

/** What to tell the team about an email that is waiting, or didn't go as planned. */
export function outboxWords(row: Pick<OutboxRow, "state" | "error" | "summary">): string {
  const to = (row.summary?.to ?? []).join(", ") || "the customer";
  const social = row.summary?.kind === "social";
  const an = row.summary?.kind === "forward" ? "A forward" : social ? "A message" : "An email";
  if (row.state === "waiting") return `${an} to ${to} is about to go.`;
  if (row.state === "sending") return `${an} to ${to} is going out now.`;
  if (row.state === "unsure") {
    return row.error === "sent_not_filed"
      ? `${an} to ${to} went out, but couldn't be filed in this conversation.`
      : `We never heard whether ${an.toLowerCase()} to ${to} went. It may have; check before writing again.`;
  }
  if (row.error === "author_left") {
    return `${an} to ${to} wasn't sent: the person who wrote it has left the workspace.`;
  }
  // An Instagram or Facebook reply: Meta's own reason, in plain words.
  if (social) {
    return /:partial:/.test(row.error ?? "")
      ? `About your message to ${to}: ${metaRefusalWords(row.error)}`
      : `${an} to ${to} wasn't sent. ${metaRefusalWords(row.error)}`;
  }
  const code = /^postmark:\d+:(\d+)$/.exec(row.error ?? "")?.[1];
  return `${an} to ${to} wasn't sent. ${refusalWords(code ? Number(code) : null)}`;
}

/**
 * Meta's own words for a message that wasn't sent, for a "Details" line under
 * ours. Null for an email, and when our words already quote them.
 */
export function outboxDetails(row: Pick<OutboxRow, "state" | "error" | "summary">): string | null {
  if (row.state !== "failed" || row.summary?.kind !== "social") return null;
  return refusalDetails(row.error);
}

/** Seconds left before a waiting email goes (never negative). */
export const secondsLeft = (sendAt: string, now: number): number =>
  Math.max(0, Math.ceil((Date.parse(sendAt) - now) / 1000));
