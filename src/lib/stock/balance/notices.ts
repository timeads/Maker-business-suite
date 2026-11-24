/**
 * The notices on a supplier's balance page, and hiding them. A notice's key
 * carries its facts ("stale:<supplier>:2026-08-06"), so once the facts change
 * (a newer statement, another payment) the key is new and the notice shows
 * again. Hidden keys are a workspace setting, so a notice hidden on one
 * device is hidden on every device. After TuftStock's accounts page.
 */

export type NoticeKind = "stale" | "unreflected" | "drift";

export type NoticeFacts = {
  supplierId: string;
  /** The date of the statement the balance stands on (YYYY-MM-DD), if there is one. */
  anchorDate: string | null;
  stale: boolean;
  /** Ids of payments that may not be in the supplier's statement yet. */
  unreflectedIds: string[];
  /** Statements that don't add up: their date and by how much. */
  drifted: { toDate: string; delta: string }[];
};

export type Notice = { kind: NoticeKind; key: string; hidden: boolean };

/** Notices can't outgrow this: old keys never match again, so the oldest go first. */
export const MAX_HIDDEN_NOTICES = 200;

/** The notices that apply right now, each with its key and whether it has been hidden. */
export function balanceNotices(facts: NoticeFacts, hiddenKeys: readonly string[]): Notice[] {
  const hidden = new Set(hiddenKeys);
  const out: Notice[] = [];
  const add = (kind: NoticeKind, rest: string) => {
    const key = `${kind}:${facts.supplierId}:${rest}`.slice(0, 300);
    out.push({ kind, key, hidden: hidden.has(key) });
  };
  if (facts.stale) add("stale", facts.anchorDate?.slice(0, 10) ?? "none");
  if (facts.unreflectedIds.length > 0)
    add("unreflected", [...facts.unreflectedIds].sort().join(","));
  if (facts.drifted.length > 0) {
    add("drift", facts.drifted.map((d) => `${d.toDate.slice(0, 10)}=${d.delta}`).join(","));
  }
  return out;
}

/** The list after hiding one more key: no repeats, newest last, capped. */
export function hideNotice(hiddenKeys: readonly string[], key: string): string[] {
  return [...hiddenKeys.filter((k) => k !== key), key].slice(-MAX_HIDDEN_NOTICES);
}
