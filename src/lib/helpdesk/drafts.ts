import { parseRichDoc, type RichDoc } from "./rich";

/**
 * Unsent drafts, kept per conversation in this browser only. Nothing here
 * reaches the server until a person presses send.
 */
export const COMPOSER_MODES = ["reply", "reply_all", "forward", "note"] as const;
export type ComposerMode = (typeof COMPOSER_MODES)[number];

export type StoredDraft = { mode: ComposerMode; doc: RichDoc; to?: string; cc?: string };

export const draftKey = (ticketId: string) => `mbs:helpdesk:draft:${ticketId}`;

/** A draft read back from storage, or null when it is missing or not one of ours. */
export function readDraft(raw: string | null): StoredDraft | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    const doc = parseRichDoc(value.doc);
    const mode = COMPOSER_MODES.find((one) => one === value.mode);
    if (!doc || !mode) return null;
    const text = (key: string) =>
      typeof value[key] === "string" ? (value[key] as string).slice(0, 1000) : undefined;
    return { mode, doc, to: text("to"), cc: text("cc") };
  } catch {
    return null;
  }
}
