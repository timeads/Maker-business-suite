/**
 * Code 128 (code set B) for the order number on a packing slip, so Scan & pack
 * can read it back. Each symbol is six bar/space widths (the stop has seven),
 * eleven modules wide; widths are from the Code 128 specification.
 */
const PATTERNS =
  "212222 222122 222221 121223 121322 131222 122213 122312 132212 221213 221312 231212 112232 122132 122231 113222 123122 123221 223211 221132 221231 213212 223112 312131 311222 321122 321221 312212 322112 322211 212123 212321 232121 111323 131123 131321 112313 132113 132311 211313 231113 231311 112133 112331 132131 113123 113321 133121 313121 211331 231131 213113 213311 213131 311123 311321 331121 312113 312311 332111 314111 221411 431111 111224 111422 121124 121421 141122 141221 112214 112412 122114 122411 142112 142211 241211 221114 413111 241112 134111 111242 121142 121241 114212 124112 124211 411212 421112 421211 212141 214121 412121 111143 111341 131141 114113 114311 411113 411311 113141 114131 311141 411131 211412 211214 211232 2331112".split(
    " ",
  );
const START_B = 104;
const STOP = 106;
/** Blank modules either side, so a scanner can find the edges. */
const QUIET = 10;

/** The symbol values for a text: start, one per character, check digit, stop. Null if it can't be encoded. */
export function code128Values(text: string): number[] | null {
  if (text.length === 0 || text.length > 40) return null;
  const data: number[] = [];
  for (const char of text) {
    const value = char.charCodeAt(0) - 32;
    if (char.length !== 1 || value < 0 || value > 94) return null;
    data.push(value);
  }
  const check = data.reduce((sum, value, index) => sum + value * (index + 1), START_B) % 103;
  return [START_B, ...data, check, STOP];
}

export type Barcode = {
  /** Total width in modules, quiet zones included. */
  width: number;
  /** The black bars, left to right, in modules. */
  bars: { x: number; width: number }[];
};

/** The bars to draw for a text, or null if it has characters Code 128 B can't carry. */
export function code128(text: string): Barcode | null {
  const values = code128Values(text);
  if (!values) return null;
  const bars: Barcode["bars"] = [];
  let x = QUIET;
  for (const value of values) {
    const widths = PATTERNS[value];
    for (let i = 0; i < widths.length; i++) {
      const width = Number(widths[i]);
      if (i % 2 === 0) bars.push({ x, width });
      x += width;
    }
  }
  return { width: x + QUIET, bars };
}
