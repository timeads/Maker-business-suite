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

/**
 * Where a signature starts in someone's own words (-1 if none): the "-- "
 * line mail apps put above one, or a phone's "Sent from my …".
 */
export function signatureStart(text: string): number {
  const dashes = /(^|\n)-- ?\n/.exec(text);
  const phone = /(^|\n)(Sent from my |Get Outlook for )/.exec(text);
  const at = [dashes, phone]
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => m.index + m[1].length);
  return at.length > 0 ? Math.min(...at) : -1;
}

/** What someone wrote once their signature is set aside. */
const withoutSignature = (text: string) => {
  // The line a mail app writes above a forwarded email isn't the sender's own words.
  const plain = text.replace(
    /^(-{2,} ?Forwarded message ?-{2,}|Begin forwarded message:)[ \t]*$/gim,
    "",
  );
  const at = signatureStart(plain);
  return (at < 0 ? plain : plain.slice(0, at)).trim();
};

/**
 * A message's own words, and the quoted earlier email under them (if any).
 * When nothing of the sender's own is left above the quoted part (a forward,
 * or a note that is only a signature) nothing is folded: the whole email is
 * shown, so a message never looks like just a signature.
 */
export function splitQuote(text: string): { own: string; quoted: string | null } {
  const at = quoteStart(text);
  if (at < 0) return { own: text, quoted: null };
  const own = text.slice(0, at).trimEnd();
  if (!withoutSignature(own)) return { own: text, quoted: null };
  return { own, quoted: text.slice(at) };
}

export type BodyPiece = { kind: "text"; text: string } | { kind: "image"; id: string };

/**
 * A message's words cut where its set-in pictures stood. Mail apps leave a
 * mark in the plain text: "[cid:…]" (Outlook, and our own reading of an HTML
 * email) or "[image: name]" (Gmail). A mark that matches a kept picture
 * becomes that picture; the rest stay as the words they are. Returns the
 * pieces and which pictures found a place.
 */
export function placeInline(
  text: string,
  pictures: { id: string; contentId: string | null; name: string }[],
): { pieces: BodyPiece[]; placed: Set<string> } {
  const placed = new Set<string>();
  const pieces: BodyPiece[] = [];
  const mark = /\[cid:([^\]\s]{1,200})\]|\[image: ([^\]\n]{1,200})\]/g;
  let last = 0;
  for (let m = mark.exec(text); m !== null; m = mark.exec(text)) {
    const cid = m[1];
    const name = m[2]?.trim().toLowerCase();
    const hit = pictures.find(
      (p) =>
        !placed.has(p.id) &&
        (cid
          ? p.contentId === cid || (p.contentId?.split("@")[0] ?? "") === cid.split("@")[0]
          : p.name.toLowerCase() === name),
    );
    if (!hit) continue;
    if (m.index > last) pieces.push({ kind: "text", text: text.slice(last, m.index) });
    pieces.push({ kind: "image", id: hit.id });
    placed.add(hit.id);
    last = m.index + m[0].length;
  }
  if (last < text.length) pieces.push({ kind: "text", text: text.slice(last) });
  return {
    pieces: pieces
      .map((piece) =>
        piece.kind === "text" ? { ...piece, text: piece.text.replace(/^\n+|\n+$/g, "") } : piece,
      )
      .filter((piece) => piece.kind === "image" || piece.text.trim() !== ""),
    placed,
  };
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
