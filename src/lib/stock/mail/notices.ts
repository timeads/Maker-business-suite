/**
 * The two notices about reading email, as general rules. Pure. Like the other
 * notices on Balances, a key carries the notice's facts, so one that was
 * hidden comes back when the facts change (lib/stock/balance/notices.ts).
 *
 *  - "The automatic read isn't running": reading is switched on, and the last
 *    read that finished is more than two days old, or there has never been
 *    one, or the latest one failed. TuftStock says the same of its morning
 *    script after two quiet days.
 *  - "Payments to X have stopped arriving": the workspace asked to be told
 *    (a number of days against that supplier in its bank source), money is
 *    still owed, and no payment has been filed on the account for that long.
 */

export const READ_STOPPED_AFTER_DAYS = 2;

export type MailNotice =
  | {
      kind: "mail-stopped";
      key: string;
      hidden: boolean;
      lastAt: string | null;
      error: string | null;
    }
  | {
      kind: "payments-quiet";
      key: string;
      hidden: boolean;
      supplierId: string;
      days: number;
      lastPayment: string | null;
    };

export type MailNoticeFacts = {
  /** Reading is switched on and Gmail has given the permission. */
  on: boolean;
  /** When the workspace switched reading on or last changed its sources (ISO), if known. */
  since: string | null;
  /** When the last read that finished well ended (ISO). */
  lastGoodAt: string | null;
  /** The newest read, when it failed. */
  lastFailed: { at: string; error: string } | null;
  now: Date;
  /** The workspace's calendar day, YYYY-MM-DD. */
  today: string;
  quiet: {
    supplierId: string;
    quietDays: number;
    /** The date of the newest payment on the account, however it got there. */
    lastPayment: string | null;
    /** The first entry on the account: an account can't be quiet before it starts. */
    firstEntry: string | null;
    owes: boolean;
  }[];
};

const DAY_MS = 86_400_000;

export function mailNotices(facts: MailNoticeFacts, hiddenKeys: readonly string[]): MailNotice[] {
  const hidden = new Set(hiddenKeys);
  const out: MailNotice[] = [];
  if (!facts.on) return out;

  const age = (iso: string) => Math.floor((facts.now.getTime() - Date.parse(iso)) / DAY_MS);
  // A workspace that switched reading on today hasn't missed anything yet.
  const fresh = facts.lastGoodAt === null && facts.since !== null && age(facts.since) <= 1;
  const failedLast =
    facts.lastFailed !== null && (!facts.lastGoodAt || facts.lastFailed.at > facts.lastGoodAt);
  const stale =
    facts.lastGoodAt === null ? !fresh : age(facts.lastGoodAt) > READ_STOPPED_AFTER_DAYS;
  if (stale || failedLast) {
    const key =
      `mail-stopped:${facts.lastGoodAt?.slice(0, 10) ?? "never"}:${failedLast ? facts.lastFailed!.at.slice(0, 10) : ""}`.slice(
        0,
        300,
      );
    out.push({
      kind: "mail-stopped",
      key,
      hidden: hidden.has(key),
      lastAt: facts.lastGoodAt,
      error: failedLast ? facts.lastFailed!.error : null,
    });
  }

  for (const q of facts.quiet) {
    if (!q.owes) continue;
    const from = q.lastPayment ?? q.firstEntry;
    if (!from) continue;
    const days = Math.round((Date.parse(facts.today) - Date.parse(from.slice(0, 10))) / DAY_MS);
    if (days <= q.quietDays) continue;
    const key = `payments-quiet:${q.supplierId}:${q.lastPayment?.slice(0, 10) ?? "none"}`;
    out.push({
      kind: "payments-quiet",
      key,
      hidden: hidden.has(key),
      supplierId: q.supplierId,
      days,
      lastPayment: q.lastPayment,
    });
  }
  return out;
}
