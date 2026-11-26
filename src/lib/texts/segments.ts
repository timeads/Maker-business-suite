/**
 * How long a text is, the way phone networks count it. A text goes in
 * "segments": with only the plain GSM characters, 160 fit in one, or 153 a
 * segment once it is split; with anything else (an emoji, curly quotes, most
 * accents), the whole text is sent as UCS-2 and 70 fit in one, or 67 a
 * segment once split. Text services charge per segment, so the editor shows
 * the count as the words are typed. Pure.
 */

// The GSM 03.38 basic set, as one string, and the extension set, whose
// characters take two places each.
const BASIC =
  "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?" +
  "¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà";
const EXTENDED = "^{}\\[~]|€\f";
const basic = new Set([...BASIC]);
const extended = new Set([...EXTENDED]);

export type TextLength = {
  /** gsm: plain characters only. unicode: something outside them, so fewer fit. */
  encoding: "gsm" | "unicode";
  /** The places the text takes: GSM septets, or UTF-16 code units. */
  units: number;
  segments: number;
  /** What fits in one segment of this text's kind before it splits. */
  perSegment: number;
  /** The characters that made it "unicode", once each, so a person can change them. */
  unusual: string[];
};

export function textLength(text: string): TextLength {
  let septets = 0;
  const unusual = new Set<string>();
  for (const char of text) {
    if (basic.has(char)) septets += 1;
    else if (extended.has(char)) septets += 2;
    else unusual.add(char);
  }
  if (unusual.size === 0) {
    return {
      encoding: "gsm",
      units: septets,
      segments: septets === 0 ? 0 : septets <= 160 ? 1 : Math.ceil(septets / 153),
      perSegment: septets <= 160 ? 160 : 153,
      unusual: [],
    };
  }
  // UCS-2 counts UTF-16 code units: an emoji takes two.
  const units = text.length;
  return {
    encoding: "unicode",
    units,
    segments: units <= 70 ? 1 : Math.ceil(units / 67),
    perSegment: units <= 70 ? 70 : 67,
    unusual: [...unusual],
  };
}

/** Plain words for the editor: "1 text (96 of 160 characters)". */
export function lengthWords(length: TextLength): string {
  if (length.segments === 0) return "Empty";
  const parts = length.segments === 1 ? "1 text" : `${length.segments} texts`;
  const kind =
    length.encoding === "unicode"
      ? ` Some characters (${length.unusual.slice(0, 5).join(" ")}) mean fewer fit in each text.`
      : "";
  return length.segments === 1
    ? `${parts} (${length.units} of ${length.perSegment} characters).${kind}`
    : `Sent as ${parts} joined together (${length.units} characters, ${length.perSegment} a text).${kind}`;
}
