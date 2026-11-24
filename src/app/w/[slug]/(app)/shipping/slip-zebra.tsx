"use client";

import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { SLIP_CSS } from "@/lib/shipping/slip-css";
import { slipZpl, type SlipData } from "@/lib/shipping/zebra/slip";
import { drawnSlipZpl } from "@/lib/shipping/zebra/slip-draw";
import { SlipSheet } from "./slip-sheet";

/**
 * Packing slips for the Zebra, drawn from the very sheet the screen and
 * paper use: each is laid out off-screen, turned into a picture at the
 * printer's resolution and sent as a graphic. If a slip can't be drawn (an
 * old browser, a canvas the browser won't read), that slip goes out the
 * plainer way, in the printer's own text, so the bench is never stuck.
 */

/** A Zebra's slip goes without item photos: nothing is fetched while the sheet is drawn. */
const withoutPhotos = (slip: SlipData): SlipData => ({
  ...slip,
  parts: slip.parts.map((part) => (part.kind === "items" ? { ...part, showPhoto: false } : part)),
});

/**
 * The logo as a `data:` picture, so it can sit inside the drawing: read from
 * our own storage, shrunk to what a label can show. Null when it can't be
 * read; the slip then prints the business's name instead.
 */
export async function logoForDrawing(url: string | null | undefined): Promise<string | null> {
  if (!url) return null;
  try {
    const response = await fetch(url, { credentials: "omit" });
    if (!response.ok) return null;
    const bitmap = await createImageBitmap(await response.blob());
    const scale = Math.min(1, 900 / bitmap.width);
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext("2d");
    if (!context) return null;
    // On white, so a see-through logo doesn't print as a black block.
    context.fillStyle = "#fff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/png");
  } catch {
    return null;
  }
}

export type ZebraSlips = {
  /** One or more `^XA…^XZ` labels per slip, in order. */
  zpl: string[];
  /** How many had to go out as plain printer text because they couldn't be drawn. */
  plain: number;
};

export async function slipsForZebra(
  slips: SlipData[],
  logoUrl: string | null | undefined,
  dpi: number,
): Promise<ZebraSlips> {
  const zpl: string[] = [];
  let plain = 0;
  const logo = slips.some((slip) => slip.header?.logo) ? await logoForDrawing(logoUrl) : null;
  const host = document.createElement("div");
  host.className = "slip-root";
  host.setAttribute("aria-hidden", "true");
  host.style.cssText = "position:fixed;left:-20000px;top:0;width:4in;pointer-events:none;";
  const style = document.createElement("style");
  style.textContent = SLIP_CSS;
  const mount = document.createElement("div");
  host.append(style, mount);
  document.body.append(host);
  const root = createRoot(mount);
  try {
    for (const slip of slips) {
      try {
        flushSync(() => root.render(<SlipSheet slip={withoutPhotos(slip)} logo={logo} />));
        zpl.push(await drawnSlipZpl(mount, dpi));
      } catch {
        zpl.push(slipZpl(slip, dpi));
        plain++;
      }
    }
  } finally {
    root.unmount();
    host.remove();
  }
  return { zpl, plain };
}
