import type { Barcode } from "../code128";

/**
 * A drawn packing slip as printer dots: the parts of `slip-draw.ts` that are
 * plain arithmetic, so they can be tested without a browser. Ported from the
 * reference help desk's `slipToZpl`, with one addition: the barcode is laid
 * down again at whole dots, because bars squeezed through a picture's
 * rounding come out uneven and a scanner may not read them.
 */

/** Text and rules are thresholded a little dark, so thin strokes survive a thermal head. */
export const SLIP_THRESHOLD = 150;

/** RGBA pixels to one bit each: 1 where it prints. */
export function lumaBits(
  px: ArrayLike<number>,
  width: number,
  height: number,
  threshold: number = SLIP_THRESHOLD,
): Uint8Array {
  const bits = new Uint8Array(width * height);
  for (let i = 0; i < bits.length; i++) {
    const lum = 0.299 * px[i * 4] + 0.587 * px[i * 4 + 1] + 0.114 * px[i * 4 + 2];
    bits[i] = lum < threshold ? 1 : 0;
  }
  return bits;
}

/**
 * How many dots wide one bar module is: three at 203 dpi (as on the current
 * slips), scaled for a finer printer, and narrower only when the code is too
 * long for the label. Zero when even one dot per module won't fit.
 */
export function barModule(codeModules: number, roomDots: number, dpi: number): number {
  const most = Math.max(1, Math.round((3 * dpi) / 203));
  for (let dots = most; dots >= 1; dots--) if (codeModules * dots <= roomDots) return dots;
  return 0;
}

export type DotRect = { x: number; y: number; width: number; height: number };

/**
 * Clears the box the barcode was drawn in and lays the bars down again, each
 * module a whole number of dots, centred. Returns the module width used, or
 * 0 when the code can't fit (the drawn bars are then left as they were).
 */
export function stampBars(
  bits: Uint8Array,
  width: number,
  height: number,
  box: DotRect,
  code: Barcode,
  dpi: number,
): number {
  const x0 = Math.max(0, Math.floor(box.x));
  const y0 = Math.max(0, Math.floor(box.y));
  const x1 = Math.min(width, Math.ceil(box.x + box.width));
  const y1 = Math.min(height, Math.ceil(box.y + box.height));
  if (x1 <= x0 || y1 <= y0) return 0;
  const dots = barModule(code.width, x1 - x0, dpi);
  if (dots === 0) return 0;
  for (let y = y0; y < y1; y++) bits.fill(0, y * width + x0, y * width + x1);
  const left = x0 + Math.floor((x1 - x0 - code.width * dots) / 2);
  for (const bar of code.bars) {
    const from = left + bar.x * dots;
    const to = from + bar.width * dots;
    for (let y = y0; y < y1; y++) bits.fill(1, y * width + from, y * width + to);
  }
  return dots;
}

/** For each row of dots: 1 when nothing prints on it. */
export function blankRows(bits: Uint8Array, width: number, height: number): Uint8Array {
  const blank = new Uint8Array(height);
  for (let y = 0; y < height; y++) {
    let any = false;
    for (let x = 0, i = y * width; x < width; x++, i++) {
      if (bits[i]) {
        any = true;
        break;
      }
    }
    blank[y] = any ? 0 : 1;
  }
  return blank;
}

/** One label's worth of a tall slip: rows `from` up to `to`, printed `top` dots down the label. */
export type PageCut = { from: number; to: number; top: number };

/**
 * Where a slip longer than one label is cut: on a band of white near the
 * bottom of each label, so no line of text is sliced in half. The first
 * label starts at the very top (the sheet has its own margin); later ones
 * leave a margin and skip any white they start with.
 */
export function pageCuts(blank: Uint8Array, pageHeight: number, dpi: number): PageCut[] {
  const total = blank.length;
  const margin = Math.round(0.3 * dpi);
  const band = Math.max(3, Math.round(dpi / 50));
  const cuts: PageCut[] = [];
  for (let y = 0; y < total;) {
    // Rounding leftovers aren't worth a label.
    if (total - y < 8) break;
    const first = cuts.length === 0;
    const top = first ? 0 : margin;
    const room = pageHeight - top;
    let end = Math.min(total, y + room);
    if (end < total) {
      end = y + room - margin;
      for (let e = end; e > y + room * 0.4; e--) {
        let clear = true;
        for (let k = 0; k < band; k++) {
          if (!blank[e - 1 - k]) {
            clear = false;
            break;
          }
        }
        if (clear) {
          end = e - Math.floor(band / 2);
          break;
        }
      }
    }
    let from = y;
    if (!first) while (from < end && blank[from]) from++;
    if (from < end) cuts.push({ from, to: end, top });
    y = end;
  }
  return cuts;
}
