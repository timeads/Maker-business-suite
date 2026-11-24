/**
 * The page a bought label is printed from when this computer prints through
 * the browser. A label opened as a bare picture prints at whatever size the
 * browser guesses (too big, over two stickers, with the browser's own date
 * and address around it). On this page the sheet is exactly 4 × 6 inches
 * with no margin, which also leaves the browser nowhere to put its header
 * and footer, and the picture is fitted to it whole and stood upright.
 *
 * Ported from the single-tenant help desk (`labelPage` in
 * `src/routes/shipping.ts`). Pure: no network, no database.
 */

export type PictureSize = { width: number; height: number };

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/**
 * A PNG's width and height in pixels, read from its header (the IHDR chunk
 * always comes first). Null when the bytes aren't a PNG we can read.
 */
export function pngSize(bytes: Uint8Array): PictureSize | null {
  if (bytes.length < 24) return null;
  if (PNG_SIGNATURE.some((byte, index) => bytes[index] !== byte)) return null;
  // Bytes 12-15 name the first chunk.
  if (String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15]) !== "IHDR") return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  if (width === 0 || height === 0 || width > 0x7fffffff || height > 0x7fffffff) return null;
  return { width, height };
}

/** A GIF's width and height in pixels, from its header. Null when the bytes aren't a GIF. */
export function gifSize(bytes: Uint8Array): PictureSize | null {
  if (bytes.length < 10) return null;
  const magic = String.fromCharCode(...bytes.subarray(0, 6));
  if (magic !== "GIF87a" && magic !== "GIF89a") return null;
  const width = bytes[6] | (bytes[7] << 8);
  const height = bytes[8] | (bytes[9] << 8);
  return width === 0 || height === 0 ? null : { width, height };
}

/**
 * The size of a label kept as base64, from its first bytes only (a label can
 * be megabytes; its header is a few dozen bytes).
 */
export function labelPictureSize(contentType: string, base64: string): PictureSize | null {
  let head: Uint8Array;
  try {
    head = Uint8Array.from(Buffer.from(base64.slice(0, 64), "base64"));
  } catch {
    return null;
  }
  if (contentType === "image/png") return pngSize(head);
  if (contentType === "image/gif") return gifSize(head);
  return null;
}

/** Lying on its side: wider than it is tall, so it is turned a quarter to stand on a 4 × 6. */
export const liesSideways = (size: PictureSize | null) => size !== null && size.width > size.height;

/** The one policy the print page runs under: its own picture, its own styles, and the one script named by `nonce`. */
export const labelPageCsp = (nonce: string) =>
  `default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none'`;

const NONCE = /^[A-Za-z0-9+/=_-]{16,}$/;
const ID = /^[0-9a-f-]{36}$/i;

/**
 * The page's one script, sent as it stands (so what runs is exactly what is
 * read here, whatever the build does to the rest of the code). It moves
 * nothing but the picture, and then asks the browser to print. `CROP` is
 * replaced by true or false.
 */
const LABEL_PAGE_SCRIPT = `(function () {
  var img = document.querySelector("img");
  var button = document.querySelector("button");
  function printNow() { window.print(); }
  if (button) button.addEventListener("click", printNow);
  if (!img) return;
  // Redo's pictures can sit inside wide white margins: fit what is printed, not the whole sheet.
  function fit() {
    var w = img.naturalWidth, h = img.naturalHeight;
    if (!w || !h || w * h > 40000000) return;
    var canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    var context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) return;
    context.fillStyle = "#fff";
    context.fillRect(0, 0, w, h);
    context.drawImage(img, 0, 0);
    var px = context.getImageData(0, 0, w, h).data;
    var x0 = w, y0 = h, x1 = -1, y1 = -1;
    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w; x++) {
        var i = (y * w + x) * 4;
        if (0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2] < 200) {
          if (x < x0) x0 = x;
          if (x > x1) x1 = x;
          if (y < y0) y0 = y;
          if (y > y1) y1 = y;
        }
      }
    }
    if (x1 < 0) return;
    var pad = 12;
    x0 = Math.max(0, x0 - pad);
    y0 = Math.max(0, y0 - pad);
    x1 = Math.min(w, x1 + 1 + pad);
    y1 = Math.min(h, y1 + 1 + pad);
    var cw = x1 - x0, ch = y1 - y0;
    // Nothing worth trimming: leave it exactly as the page laid it out.
    if (cw > w * 0.97 && ch > h * 0.97) return;
    // 4 x 6 inches in CSS pixels.
    var W = 384, H = 576, k, style = img.style;
    style.position = "absolute";
    style.objectFit = "fill";
    style.maxWidth = "none";
    style.transformOrigin = "0 0";
    if (cw > ch) {
      // Lying on its side: a quarter turn clockwise, as the Zebra path does.
      k = Math.min(H / cw, W / ch);
      style.width = w * k + "px";
      style.height = h * k + "px";
      style.left = (W - ch * k) / 2 + y1 * k + "px";
      style.top = (H - cw * k) / 2 - x0 * k + "px";
      style.transform = "rotate(90deg)";
    } else {
      k = Math.min(W / cw, H / ch);
      style.width = w * k + "px";
      style.height = h * k + "px";
      style.left = (W - cw * k) / 2 - x0 * k + "px";
      style.top = (H - ch * k) / 2 - y0 * k + "px";
      style.transform = "none";
    }
  }
  var started = false;
  function start() {
    if (started) return;
    started = true;
    if (CROP) {
      try { fit(); } catch (e) { /* Left as laid out: still a whole label on a 4 x 6 sheet. */ }
    }
    window.setTimeout(printNow, 300);
  }
  if (img.complete && img.naturalWidth > 0) start();
  else img.addEventListener("load", start);
})();`;

/**
 * The print page for one label kept as a picture. Nothing from the label goes
 * into the page but its own address (`id`, checked) and three yes/no facts.
 *
 * `sideways`: the picture is wider than tall (a UPS GIF always is), so it is
 * turned a quarter clockwise. `autoPrint` needs a `nonce` that the response's
 * policy names; without one the page has no script at all.
 */
export function labelPrintPage(input: {
  id: string;
  sideways: boolean;
  /** A UPS GIF fills the sheet edge to edge, as it always has; anything else is fitted whole. */
  stretch?: boolean;
  /** Trim wide white margins before fitting (Redo's pictures). */
  crop?: boolean;
  nonce?: string;
}): string {
  if (!ID.test(input.id)) throw new Error("Not a label");
  const nonce = input.nonce && NONCE.test(input.nonce) ? input.nonce : null;
  const fit = input.stretch ? "fill" : "contain";
  const picture = input.sideways
    ? `.label img { position: absolute; top: 0; left: 4in; width: 6in; height: 4in; object-fit: ${fit}; transform-origin: top left; transform: rotate(90deg) }`
    : `.label img { position: absolute; top: 0; left: 0; width: 4in; height: 6in; object-fit: ${fit} }`;
  const script = nonce
    ? `<script nonce="${nonce}">${LABEL_PAGE_SCRIPT.replace("CROP", input.crop ? "true" : "false")}</script>`
    : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Label</title><style>
@page { size: 4in 6in; margin: 0 }
html, body { margin: 0; padding: 0; background: #fff }
.label { width: 4in; height: 6in; position: relative; overflow: hidden; break-inside: avoid; page-break-inside: avoid }
${picture}
.bar { font: 14px system-ui, sans-serif; padding: 12px; display: flex; gap: 8px; align-items: center }
.bar button { font: inherit; padding: 6px 14px }
@media print { .bar { display: none } }
</style></head><body>${
    nonce
      ? `<div class="bar"><button type="button">Print</button><span>4 × 6 in label. If your browser asks: margins none, scale 100%.</span></div>`
      : ""
  }<div class="label"><img src="${input.id}?raw=1" alt="Postage label"></div>${script}</body></html>`;
}
