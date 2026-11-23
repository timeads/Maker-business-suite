import { describe, expect, it } from "vitest";
import {
  MAX_PDF_PAGES,
  PdfLabelError,
  pdfPageNumbers,
  pdfPageSize,
  pdfScale,
  pdfTrimPad,
  pdfToZpl,
} from "./pdf";

describe("a PDF label's pages", () => {
  it("are drawn at the printer's own resolution: 72 points to the inch", () => {
    expect(pdfScale(72)).toBe(1);
    expect(pdfScale(203)).toBeCloseTo(2.8194, 3);
    // A 4 × 6 inch page is exactly the label, dot for dot.
    expect(pdfPageSize(288, 432, 203)).toMatchObject({ width: 812, height: 1218 });
    expect(pdfPageSize(288, 432, 300)).toMatchObject({ width: 1200, height: 1800 });
    // A label lying on its side keeps its shape; it is stood upright when drawn.
    expect(pdfPageSize(432, 288, 203)).toMatchObject({ width: 1218, height: 812 });
    // A label on letter paper is drawn whole, then cropped to what's printed.
    expect(pdfPageSize(612, 792, 300)).toMatchObject({ width: 2550, height: 3300 });
  });

  it("never asks the browser for a canvas too big to hold, and keeps the page's shape", () => {
    const poster = pdfPageSize(2000, 4000, 300);
    expect(poster.height).toBe(4200);
    expect(poster.width).toBe(2100);
    expect(poster.scale).toBeLessThan(pdfScale(300));
    expect(pdfPageSize(0.1, 0.1, 203)).toMatchObject({ width: 1, height: 1 });
    for (const bad of [0, -5, Number.NaN]) {
      expect(() => pdfPageSize(bad, 432, 203)).toThrow(PdfLabelError);
      expect(() => pdfPageSize(288, bad, 203)).toThrow(PdfLabelError);
    }
  });

  it("keeps about a sixteenth of an inch of white around what's printed", () => {
    expect(pdfTrimPad(203)).toBe(12);
    expect(pdfTrimPad(300)).toBe(18);
  });

  it("print in page order, every one, up to a sensible limit", () => {
    expect(pdfPageNumbers(1)).toEqual([1]);
    expect(pdfPageNumbers(3)).toEqual([1, 2, 3]);
    expect(pdfPageNumbers(0)).toEqual([]);
    expect(pdfPageNumbers(Number.NaN)).toEqual([]);
    expect(pdfPageNumbers(500)).toHaveLength(MAX_PDF_PAGES);
    expect(pdfPageNumbers(500).at(-1)).toBe(MAX_PDF_PAGES);
  });

  it("fail with words for the person packing, whatever went wrong underneath", async () => {
    // No browser here: there is nothing to draw on, which is one more way to fail.
    const err = await pdfToZpl("not a pdf").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PdfLabelError);
    expect((err as Error).message).toBe("We couldn't draw this label's PDF for the Zebra.");
  });
});
