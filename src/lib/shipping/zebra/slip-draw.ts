import { code128 } from "../code128";
import { SLIP_CSS } from "../slip-css";
import { blankRows, lumaBits, pageCuts, stampBars } from "./raster";
import { bitsToGfaZ64 } from "./zpl";

/**
 * In the browser only: a packing slip that is already laid out on the page
 * (the same `SlipSheet` the screen and paper use) turned into ZPL for the
 * Zebra. The sheet is drawn as a picture at the printer's own resolution,
 * made black and white, and its barcode laid down again at whole dots.
 * Ported from the reference help desk's `slipToZpl`.
 *
 * The picture is made from the sheet's own markup and stylesheet and nothing
 * else: nothing is fetched while it is drawn, so the only picture on it is
 * the logo, which arrives as a `data:` address.
 */

const loadImage = (src: string) =>
  new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("The packing slip couldn't be drawn."));
    img.src = src;
  });

/** 4 inches in CSS pixels: how wide the sheet is laid out. */
const SHEET_PX = 384;

/**
 * @param host an element on the page holding one laid-out `.slip` (4 × 6)
 * @param dpi  203 for most Zebras, 300 for the finer ones
 * @returns one `^XA…^XZ` label, or several when the slip is longer than a label
 */
export async function drawnSlipZpl(host: HTMLElement, dpi: number = 203): Promise<string> {
  const slip = host.querySelector<HTMLElement>(".slip");
  if (!slip) throw new Error("The packing slip couldn't be drawn.");
  await Promise.all(
    [...slip.querySelectorAll("img")].map((img) =>
      img.complete
        ? null
        : new Promise((done) => {
            img.onload = img.onerror = done;
          }),
    ),
  );
  const scale = dpi / 96;
  const W = Math.round(4 * dpi);
  const pageH = Math.round(6 * dpi);
  const frame = slip.getBoundingClientRect();
  const heightPx = Math.ceil(frame.height);
  const fullH = Math.ceil(heightPx * scale);
  // Where each barcode sits, so its bars can be laid down again at whole dots.
  const codes = [...slip.querySelectorAll<HTMLElement>("[data-slip-code]")].map((element) => {
    const box = element.getBoundingClientRect();
    return {
      text: element.dataset.slipCode ?? "",
      box: {
        x: (box.left - frame.left) * scale,
        y: (box.top - frame.top) * scale,
        width: box.width * scale,
        height: box.height * scale,
      },
    };
  });

  // The sheet inside an SVG, drawn at the printer's resolution.
  const doc = document.implementation.createHTMLDocument("");
  const root = doc.createElement("div");
  root.setAttribute("class", "slip-root");
  const style = doc.createElement("style");
  style.textContent = SLIP_CSS;
  root.append(style, doc.importNode(slip, true));
  const xhtml = new XMLSerializer().serializeToString(root);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${fullH}" viewBox="0 0 ${SHEET_PX} ${heightPx}"><foreignObject x="0" y="0" width="${SHEET_PX}" height="${heightPx}">${xhtml}</foreignObject></svg>`;
  const picture = await loadImage(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`);
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = fullH;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("This browser can't draw the packing slip for the printer.");
  context.fillStyle = "#fff";
  context.fillRect(0, 0, W, fullH);
  context.drawImage(picture, 0, 0, W, fullH);
  const bits = lumaBits(context.getImageData(0, 0, W, fullH).data, W, fullH);
  // A sheet that came out blank means the browser wouldn't draw it: say so, and the plain slip prints instead.
  if (!bits.includes(1)) throw new Error("The packing slip came out blank.");

  for (const { text, box } of codes) {
    const code = code128(text);
    if (code) stampBars(bits, W, fullH, box, code, dpi);
  }

  const labels: string[] = [];
  for (const cut of pageCuts(blankRows(bits, W, fullH), pageH, dpi)) {
    const graphic = await bitsToGfaZ64(
      bits.subarray(cut.from * W, cut.to * W),
      W,
      cut.to - cut.from,
    );
    labels.push(`^XA^PW${W}^LL${pageH}^LH0,0${graphic.replace("^FO0,0", `^FO0,${cut.top}`)}^XZ`);
  }
  if (labels.length === 0) throw new Error("The packing slip came out blank.");
  return labels.join("\n");
}
