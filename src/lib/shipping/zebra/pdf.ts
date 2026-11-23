import { drawnToZpl, trimmed } from "./zpl";

/**
 * A label that arrived as a PDF (Redo sends some this way), drawn for the
 * Zebra: each page is rendered with pdf.js at the printer's resolution,
 * cropped to what is printed and sent through the same picture-to-ZPL path
 * as any other label. Ported from the single-tenant help desk
 * (`public/js/pdf-labels.js`).
 *
 * pdf.js is only loaded here, the moment a PDF label is actually printed, so
 * no other page carries it.
 */

/** A PDF is measured in points: 72 to the inch. */
export const pdfScale = (dpi: number) => dpi / 72;

/** The most pages one label file is read for. A label is a page or two; anything longer isn't one. */
export const MAX_PDF_PAGES = 12;

/** No canvas side goes past this, whatever the page says about its own size. */
const MAX_SIDE = 4200;

/**
 * How big to draw a page of `widthPt` × `heightPt` points at `dpi`: its true
 * size at the printer's resolution (a 4 × 6 label at 203 dpi is 812 × 1218),
 * scaled down only when a page is so large the browser couldn't hold it.
 */
export function pdfPageSize(
  widthPt: number,
  heightPt: number,
  dpi: number,
): { scale: number; width: number; height: number } {
  if (!(widthPt > 0) || !(heightPt > 0)) throw new PdfLabelError();
  let scale = pdfScale(dpi);
  const longest = Math.max(widthPt, heightPt) * scale;
  if (longest > MAX_SIDE) scale *= MAX_SIDE / longest;
  return {
    scale,
    width: Math.max(1, Math.round(widthPt * scale)),
    height: Math.max(1, Math.round(heightPt * scale)),
  };
}

/** White kept around what is printed when a page is cropped: about a sixteenth of an inch. */
export const pdfTrimPad = (dpi: number) => Math.round(dpi * 0.06);

/** Which pages are drawn, in order: every one, up to the limit. */
export const pdfPageNumbers = (count: number): number[] =>
  Array.from(
    { length: Math.max(0, Math.min(Math.floor(count) || 0, MAX_PDF_PAGES)) },
    (_, i) => i + 1,
  );

/** `message` is written for the person at the packing bench. */
export class PdfLabelError extends Error {
  constructor() {
    super("We couldn't draw this label's PDF for the Zebra.");
    this.name = "PdfLabelError";
  }
}

const bytesOf = (base64: string) => {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
};

/** In the browser only. One 4 × 6 ZPL label for each page of a base64 PDF, in page order. */
export async function pdfToZpl(base64: string, dpi = 203): Promise<string[]> {
  try {
    const pdfjs = await import("pdfjs-dist");
    // pdf.js reads the file in a worker of its own, served beside the app's other scripts.
    pdfjs.GlobalWorkerOptions.workerSrc = new URL(
      "pdfjs-dist/build/pdf.worker.min.mjs",
      import.meta.url,
    ).toString();
    const task = pdfjs.getDocument({ data: bytesOf(base64) });
    const doc = await task.promise;
    try {
      const labels: string[] = [];
      for (const number of pdfPageNumbers(doc.numPages)) {
        const page = await doc.getPage(number);
        const natural = page.getViewport({ scale: 1 });
        const size = pdfPageSize(natural.width, natural.height, dpi);
        const viewport = page.getViewport({ scale: size.scale });
        const canvas = document.createElement("canvas");
        canvas.width = size.width;
        canvas.height = size.height;
        const context = canvas.getContext("2d", { willReadFrequently: true });
        if (!context) throw new PdfLabelError();
        context.fillStyle = "#fff";
        context.fillRect(0, 0, canvas.width, canvas.height);
        await page.render({ canvas: null, canvasContext: context, viewport }).promise;
        // The label can sit on a bigger page (a 4 × 6 label on letter paper) or inside wide
        // margins: cropped to what's printed, it fills the sticker instead of shrinking with
        // the page. A label lying on its side is stood upright as it is drawn.
        const cut = trimmed(canvas, pdfTrimPad(dpi));
        labels.push(await drawnToZpl(cut, cut.width, cut.height, dpi));
      }
      if (labels.length === 0) throw new PdfLabelError();
      return labels;
    } finally {
      await task.destroy().catch(() => undefined);
    }
  } catch {
    throw new PdfLabelError();
  }
}
