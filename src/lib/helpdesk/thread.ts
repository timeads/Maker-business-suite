/**
 * Where the earlier thread starts in a plain-text reply. "On … wrote:" is
 * often wrapped over two lines, so it may span a line break (not a blank
 * line). Ported from the team's first help desk.
 */
const QUOTE_RE =
  /^(On (?:(?!\n\s*\n)[\s\S]){5,300}?wrote:[ \t]*$|-{2,} ?Original Message ?-{2,}|From: .+\n(?:Sent|Date): |_{10,}\s*\nFrom: )/m;

/** Index where the quoted earlier messages begin (-1 if none): the reply header, or else the first run of "> " lines. */
export function quoteStart(text: string): number {
  const i = text.search(QUOTE_RE);
  if (i > 0) return i;
  const run = /^(?:>.*\n){2,}/m.exec(text);
  return run && run.index > 0 ? run.index : -1;
}

/** A message's own words, and the quoted earlier email under them (if any). */
export function splitQuote(text: string): { own: string; quoted: string | null } {
  const at = quoteStart(text);
  if (at < 0) return { own: text, quoted: null };
  return { own: text.slice(0, at).trimEnd(), quoted: text.slice(at) };
}

/**
 * Long conversations open on their end: the first message and the last two
 * stay open, what lies between is folded behind "n earlier messages". Notes
 * and events travel with the messages around them. Three messages or fewer
 * are never folded.
 */
export function foldThread<T extends { kind: string }>(
  items: T[],
): { head: T[]; hidden: T[]; tail: T[]; hiddenMessages: number } {
  const messageAt = items
    .map((item, i) => (item.kind === "message" ? i : -1))
    .filter((i) => i >= 0);
  if (messageAt.length <= 3) return { head: [], hidden: [], tail: items, hiddenMessages: 0 };
  const cut = messageAt[messageAt.length - 2];
  const first = messageAt[0];
  const hidden = items.slice(first + 1, cut);
  return {
    head: items.slice(0, first + 1),
    hidden,
    tail: items.slice(cut),
    hiddenMessages: hidden.filter((item) => item.kind === "message").length,
  };
}
