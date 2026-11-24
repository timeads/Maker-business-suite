import type { Fetch } from "../../connections/types";
import { MAX_FILE_BYTES, htmlToText } from "./message";

/**
 * Reading a mailbox through Gmail's REST API with plain `fetch`, like the
 * send path. Three calls only: search with a source's own query, fetch one
 * message, fetch one attached file. Nothing is changed in the mailbox (the
 * permission is read-only) and nothing fetched here is stored: the caller
 * keeps ids, the sender, the subject and the facts read.
 *
 * The access token goes in the Authorization header and nowhere else.
 */

const BASE = "https://gmail.googleapis.com/gmail/v1/users/me";
const TIMEOUT_MS = 30_000;

export type FoundMessage = { id: string; threadId: string };

export type FetchedMessage = {
  id: string;
  threadId: string;
  /** The message's own Message-ID header. */
  rfcMessageId: string | null;
  fromHeader: string;
  subject: string;
  sentAt: Date;
  /** Its words as plain text (the plain part, else the HTML part flattened). */
  text: string;
  attachments: { name: string; mimeType: string; size: number; attachmentId: string }[];
};

export interface Mailbox {
  /** One page of ids for a search, newest first. `more` when Gmail had another page. */
  list(query: string, max: number): Promise<{ found: FoundMessage[]; more: boolean }>;
  get(id: string): Promise<FetchedMessage>;
  /** One attached file's bytes. Refuses anything over the size cap. */
  attachment(messageId: string, attachmentId: string): Promise<Uint8Array>;
}

export class GmailReadError extends Error {
  constructor(
    message: string,
    /** `permission`: reading wasn't granted. `stale`: sign-in refused. `busy`: try later. */
    public kind: "permission" | "stale" | "busy" | "other",
  ) {
    super(message);
    this.name = "GmailReadError";
  }
}

type Part = {
  mimeType?: string;
  filename?: string;
  headers?: { name?: string; value?: string }[];
  body?: { data?: string; size?: number; attachmentId?: string };
  parts?: Part[];
};

const fromBase64Url = (data: string) => Buffer.from(data, "base64url");
const HEX_ID = /^[0-9a-f]{8,32}$/i;

function walk(part: Part | undefined, visit: (part: Part) => void) {
  if (!part) return;
  visit(part);
  for (const child of part.parts ?? []) walk(child, visit);
}

/** Pulls what we use out of Gmail's `format=full` answer. Exported for tests. */
export function parseGmailMessage(data: {
  id?: string;
  threadId?: string;
  internalDate?: string;
  payload?: Part;
}): FetchedMessage {
  const header = (name: string) =>
    data.payload?.headers?.find((h) => h.name?.toLowerCase() === name)?.value?.trim() ?? "";
  let plain = "";
  let html = "";
  const attachments: FetchedMessage["attachments"] = [];
  walk(data.payload, (part) => {
    const type = (part.mimeType ?? "").toLowerCase();
    if (part.filename && part.body?.attachmentId) {
      attachments.push({
        name: part.filename.slice(0, 300),
        mimeType: type,
        size: Number(part.body.size ?? 0),
        attachmentId: part.body.attachmentId,
      });
      return;
    }
    if (!part.body?.data) return;
    if (type === "text/plain" && !plain) plain = fromBase64Url(part.body.data).toString("utf8");
    if (type === "text/html" && !html) html = fromBase64Url(part.body.data).toString("utf8");
  });
  const sent = Number(data.internalDate);
  return {
    id: data.id ?? "",
    threadId: data.threadId ?? data.id ?? "",
    rfcMessageId: header("message-id") || null,
    fromHeader: header("from"),
    subject: header("subject").replace(/\s+/g, " ").slice(0, 300),
    sentAt: Number.isFinite(sent) && sent > 0 ? new Date(sent) : new Date(),
    text: (plain.trim() || htmlToText(html)).slice(0, 200_000),
    attachments,
  };
}

export function gmailMailbox(accessToken: string, fetchImpl: Fetch = fetch): Mailbox {
  const call = async <T>(path: string): Promise<T> => {
    let response: Response;
    try {
      response = await fetchImpl(`${BASE}${path}`, {
        headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      // Deliberately not passing the cause along: it can carry the request.
      throw new GmailReadError("We didn't hear back from Gmail.", "busy");
    }
    if (response.ok) return (await response.json()) as T;
    const data = (await response.json().catch(() => ({}))) as { error?: { message?: unknown } };
    const said = typeof data.error?.message === "string" ? data.error.message : "";
    if (response.status === 401) {
      throw new GmailReadError("Gmail didn't accept the saved permission.", "stale");
    }
    if (response.status === 403 && /scope|permission/i.test(said)) {
      throw new GmailReadError(
        "Gmail hasn't given permission to read. Connect Gmail again and choose to let it read your suppliers' emails.",
        "permission",
      );
    }
    if (response.status === 403 && /has not been used|is disabled|not enabled/i.test(said)) {
      throw new GmailReadError(
        "Reading Gmail isn't switched on for this app yet (the Gmail API is off in its Google Cloud project).",
        "other",
      );
    }
    if (response.status === 429 || response.status >= 500) {
      throw new GmailReadError("Gmail is busy just now.", "busy");
    }
    throw new GmailReadError("Gmail wouldn't answer that.", "other");
  };

  return {
    async list(query, max) {
      const params = new URLSearchParams({
        q: query,
        maxResults: String(Math.max(1, Math.min(max, 100))),
      });
      const data = await call<{
        messages?: { id?: string; threadId?: string }[];
        nextPageToken?: string;
      }>(`/messages?${params.toString()}`);
      const found = (data.messages ?? [])
        .filter((m): m is { id: string; threadId?: string } => HEX_ID.test(m.id ?? ""))
        .map((m) => ({ id: m.id.toLowerCase(), threadId: (m.threadId ?? m.id).toLowerCase() }));
      return { found, more: Boolean(data.nextPageToken) };
    },
    async get(id) {
      if (!HEX_ID.test(id)) throw new GmailReadError("That isn't a message id.", "other");
      return parseGmailMessage(await call(`/messages/${id}?format=full`));
    },
    async attachment(messageId, attachmentId) {
      if (!HEX_ID.test(messageId) || !/^[\w-]{1,2000}$/.test(attachmentId)) {
        throw new GmailReadError("That isn't an attachment id.", "other");
      }
      const data = await call<{ data?: string; size?: number }>(
        `/messages/${messageId}/attachments/${attachmentId}`,
      );
      const bytes = fromBase64Url(data.data ?? "");
      if (bytes.length > MAX_FILE_BYTES) {
        throw new GmailReadError("That file is over the size limit.", "other");
      }
      return new Uint8Array(bytes);
    },
  };
}
