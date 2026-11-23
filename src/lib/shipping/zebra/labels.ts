import { imageToZpl, zplFromBase64 } from "./zpl";

/** One box's label as the server hands it to this computer for the Zebra. */
export type PrintLabel = {
  /** Which box, counting from 1. */
  box: number;
  /** "zpl" goes to the printer as it is; a picture is drawn for it first. */
  kind: "zpl" | "png" | "gif";
  /** Base64, as the carrier sent it. */
  data: string;
  /** Trim wide white margins before drawing (Redo's pictures can carry them). */
  crop?: boolean;
};

type Draw = (data: string, kind: "png" | "gif", dpi: number, crop: boolean) => Promise<string>;

/** Every label as ZPL, in box order. ZPL is passed through untouched. */
export async function labelsToZpl(
  labels: PrintLabel[],
  dpi: number,
  draw: Draw = imageToZpl,
): Promise<string[]> {
  const jobs: string[] = [];
  for (const label of [...labels].sort((a, b) => a.box - b.box)) {
    jobs.push(
      label.kind === "zpl"
        ? zplFromBase64(label.data).trim()
        : await draw(label.data, label.kind, dpi, label.crop === true),
    );
  }
  return jobs;
}
