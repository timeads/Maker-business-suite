import { imageToZpl, zplFromBase64 } from "./zpl";

/** One box's label as the server hands it to this computer for the Zebra. */
export type PrintLabel = {
  /** Which box, counting from 1. */
  box: number;
  /** "zpl" goes to the printer as it is; a picture or a PDF is drawn for it first. */
  kind: "zpl" | "png" | "gif" | "pdf";
  /** Base64, as the carrier sent it. */
  data: string;
  /** Trim wide white margins before drawing (Redo's pictures can carry them). */
  crop?: boolean;
};

const KINDS: Record<string, PrintLabel["kind"]> = {
  "text/plain": "zpl",
  "image/png": "png",
  "image/gif": "gif",
  "application/pdf": "pdf",
};

/** How a kept label file goes to the Zebra, by what kind of file it is. Null for one that can't. */
export const printKind = (contentType: string): PrintLabel["kind"] | null =>
  Object.hasOwn(KINDS, contentType) ? KINDS[contentType] : null;

type Draw = (data: string, kind: "png" | "gif", dpi: number, crop: boolean) => Promise<string>;
type DrawPdf = (data: string, dpi: number) => Promise<string[]>;

/** pdf.js arrives only when a PDF label is really being printed. */
const lazyPdf: DrawPdf = async (data, dpi) => (await import("./pdf")).pdfToZpl(data, dpi);

/**
 * Every label as ZPL, in box order. ZPL is passed through untouched, a
 * picture is one label, and a PDF is one label per page, in page order.
 */
export async function labelsToZpl(
  labels: PrintLabel[],
  dpi: number,
  draw: Draw = imageToZpl,
  drawPdf: DrawPdf = lazyPdf,
): Promise<string[]> {
  const jobs: string[] = [];
  for (const label of [...labels].sort((a, b) => a.box - b.box)) {
    if (label.kind === "zpl") jobs.push(zplFromBase64(label.data).trim());
    else if (label.kind === "pdf") jobs.push(...(await drawPdf(label.data, dpi)));
    else jobs.push(await draw(label.data, label.kind, dpi, label.crop === true));
  }
  return jobs;
}
