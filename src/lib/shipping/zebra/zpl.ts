/**
 * ZPL, the Zebra's own language: the small pieces shared by everything that
 * prints. The graphic encoders are ported from the single-tenant help desk
 * (`public/js/zpl.js`) with their tests.
 */

/** Text for a `^FH^FD…^FS` field: anything ZPL would trip on goes as `_XX` hex (UTF-8, with `^CI28`). */
export function zplText(value: string): string {
  let out = "";
  for (const byte of new TextEncoder().encode(value.replace(/\s+/g, " ").trim())) {
    const plain = byte >= 0x20 && byte <= 0x7e && byte !== 0x5e && byte !== 0x7e && byte !== 0x5f;
    out += plain ? String.fromCharCode(byte) : `_${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return out;
}

/** Words onto lines of at most `max` characters; a word longer than a line is cut. */
export function wrapText(value: string, max: number): string[] {
  const width = Math.max(1, Math.floor(max));
  const lines: string[] = [];
  for (const paragraph of value.split(/\r?\n/)) {
    let line = "";
    for (let word of paragraph.split(/\s+/).filter(Boolean)) {
      while (word.length > width) {
        if (line) {
          lines.push(line);
          line = "";
        }
        lines.push(word.slice(0, width));
        word = word.slice(width);
      }
      if (!line) line = word;
      else if (line.length + 1 + word.length <= width) line += ` ${word}`;
      else {
        lines.push(line);
        line = word;
      }
    }
    if (line) lines.push(line);
  }
  return lines;
}

/** A small label that says the printer is set up. Nothing on it comes from an order. */
export function testLabelZpl(workspaceName: string): string {
  return [
    "^XA^CI28",
    `^CF0,40^FO40,60^FH^FD${zplText(workspaceName).slice(0, 120) || "Test label"}^FS`,
    "^CF0,30^FO40,120^FDZebra test label OK^FS",
    "^FO40,180^BY3^BCN,100,Y,N,N^FDTEST-1234^FS",
    "^XZ",
  ].join("");
}

/** Base64 of a ZPL file, as a carrier sends it, back to its text. */
export function zplFromBase64(data: string): string {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

// ---------------------------------------------------------------------------
// Pictures as ZPL graphics (^GFA)
// ---------------------------------------------------------------------------

function runCode(count: number): string {
  if (count === 1) return "";
  let n = count;
  let code = "";
  while (n > 400) {
    code += "z";
    n -= 400;
  }
  if (n >= 20) {
    code += String.fromCharCode("g".charCodeAt(0) + Math.floor(n / 20) - 1);
    n %= 20;
  }
  if (n > 0) code += String.fromCharCode("G".charCodeAt(0) + n - 1);
  return code;
}

/** ZPL's ASCII compression for one row of hex: runs become count letters, trailing zeros ",". */
export function compressRow(hex: string, previous: string | null): string {
  if (previous !== null && hex === previous) return ":";
  const kept = hex.replace(/0+$/, "");
  let out = "";
  for (let i = 0; i < kept.length; ) {
    const ch = kept[i];
    let n = 1;
    while (kept[i + n] === ch) n++;
    i += n;
    out += runCode(n) + ch;
  }
  return kept.length < hex.length ? `${out},` : out;
}

/** The inverse of `compressRow`, so the tests can check the encoding round-trips. */
export function expandRows(data: string, bytesPerRow: number): string[] {
  const width = bytesPerRow * 2;
  const rows: string[] = [];
  let row = "";
  let count = 0;
  const flush = () => {
    rows.push(row.padEnd(width, "0").slice(0, width));
    row = "";
  };
  for (const ch of data) {
    if (ch === ":") {
      if (row) flush();
      rows.push(rows[rows.length - 1]);
    } else if (ch === ",") {
      flush();
    } else if (ch === "!") {
      rows.push(row.padEnd(width, "F"));
      row = "";
    } else if (ch >= "G" && ch <= "Y") {
      count += ch.charCodeAt(0) - 70;
    } else if (ch >= "g" && ch <= "z") {
      count += (ch.charCodeAt(0) - 102) * 20;
    } else {
      row += ch.repeat(count || 1);
      count = 0;
      if (row.length >= width) flush();
    }
  }
  if (row) flush();
  return rows;
}

/** One-bit pixels (1 is black) as a ZPL ^GFA field at the label's top left. */
export function bitsToGfa(bits: Uint8Array, width: number, height: number): string {
  const bytesPerRow = Math.ceil(width / 8);
  let previous: string | null = null;
  const parts: string[] = [];
  for (let y = 0; y < height; y++) {
    let hex = "";
    for (let b = 0; b < bytesPerRow; b++) {
      let value = 0;
      for (let k = 0; k < 8; k++) {
        const x = b * 8 + k;
        if (x < width && bits[y * width + x]) value |= 0x80 >> k;
      }
      hex += value.toString(16).toUpperCase().padStart(2, "0");
    }
    parts.push(compressRow(hex, previous));
    previous = hex;
  }
  const total = bytesPerRow * height;
  return `^FO0,0^GFA,${total},${total},${bytesPerRow},${parts.join("")}^FS`;
}

/** CRC-16/XMODEM over the Z64 text, as ZPL expects after ":Z64:…:". */
export function crc16(text: string): string {
  let crc = 0;
  for (let i = 0; i < text.length; i++) {
    crc ^= text.charCodeAt(i) << 8;
    for (let k = 0; k < 8; k++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, "0");
}

/**
 * One-bit pixels as ^GFA using Z64 (zlib and base64): several times smaller
 * than the ASCII form, which keeps Browser Print happy. Falls back to ASCII
 * where the browser can't compress.
 */
export async function bitsToGfaZ64(
  bits: Uint8Array,
  width: number,
  height: number,
): Promise<string> {
  if (typeof CompressionStream === "undefined") return bitsToGfa(bits, width, height);
  const bytesPerRow = Math.ceil(width / 8);
  const raw = new Uint8Array(bytesPerRow * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (bits[y * width + x]) raw[y * bytesPerRow + (x >> 3)] |= 0x80 >> (x & 7);
    }
  }
  const zipped = new Uint8Array(
    await new Response(
      new Blob([raw]).stream().pipeThrough(new CompressionStream("deflate")),
    ).arrayBuffer(),
  );
  let binary = "";
  for (let i = 0; i < zipped.length; i += 0x8000) {
    binary += String.fromCharCode(...zipped.subarray(i, i + 0x8000));
  }
  const b64 = btoa(binary);
  return `^FO0,0^GFA,${raw.length},${raw.length},${bytesPerRow},:Z64:${b64}:${crc16(b64)}^FS`;
}

/** Where the dark-enough pixels are in RGBA data, or null when there are none. */
export function contentBox(
  px: ArrayLike<number>,
  width: number,
  height: number,
  threshold = 200,
): { x0: number; y0: number; x1: number; y1: number } | null {
  let x0 = width;
  let y0 = height;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      if (0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2] < threshold) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  return x1 < 0 ? null : { x0, y0, x1, y1 };
}

/** RGBA pixels to one bit each: 1 where it is dark enough to print. */
export function pixelsToBits(px: ArrayLike<number>, width: number, height: number): Uint8Array {
  const bits = new Uint8Array(width * height);
  for (let i = 0; i < bits.length; i++) {
    bits[i] = 0.299 * px[i * 4] + 0.587 * px[i * 4 + 1] + 0.114 * px[i * 4 + 2] < 128 ? 1 : 0;
  }
  return bits;
}

// ---------------------------------------------------------------------------
// In the browser only: a label that came as a picture, drawn for the Zebra
// ---------------------------------------------------------------------------

const loadImage = (src: string) =>
  new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("That label's picture couldn't be read."));
    img.src = src;
  });

/** The canvas cropped to what is printed on it, with a little white around. */
function trimmed(canvas: HTMLCanvasElement, pad: number): HTMLCanvasElement {
  const { width, height } = canvas;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return canvas;
  const box = contentBox(context.getImageData(0, 0, width, height).data, width, height);
  if (!box) return canvas;
  const x0 = Math.max(0, box.x0 - pad);
  const y0 = Math.max(0, box.y0 - pad);
  const x1 = Math.min(width - 1, box.x1 + pad);
  const y1 = Math.min(height - 1, box.y1 + pad);
  if (x0 === 0 && y0 === 0 && x1 === width - 1 && y1 === height - 1) return canvas;
  const out = document.createElement("canvas");
  out.width = x1 - x0 + 1;
  out.height = y1 - y0 + 1;
  const drawn = out.getContext("2d");
  if (!drawn) return canvas;
  drawn.fillStyle = "#fff";
  drawn.fillRect(0, 0, out.width, out.height);
  drawn.drawImage(canvas, x0, y0, out.width, out.height, 0, 0, out.width, out.height);
  return out;
}

/**
 * A label picture (a UPS GIF lies on its side; a PNG is usually upright) as
 * one 4 × 6 ZPL label. `crop` trims wide white margins first, which Redo's
 * pictures can carry, so the label fills the sticker.
 */
export async function imageToZpl(
  base64: string,
  kind: "png" | "gif",
  dpi = 203,
  crop = false,
): Promise<string> {
  const W = Math.round(4 * dpi);
  const H = Math.round(6 * dpi);
  const img = await loadImage(`data:image/${kind};base64,${base64}`);
  let source: HTMLImageElement | HTMLCanvasElement = img;
  let sw = img.naturalWidth;
  let sh = img.naturalHeight;
  if (crop) {
    const whole = document.createElement("canvas");
    whole.width = sw;
    whole.height = sh;
    const context = whole.getContext("2d", { willReadFrequently: true });
    if (context) {
      context.fillStyle = "#fff";
      context.fillRect(0, 0, sw, sh);
      context.drawImage(img, 0, 0);
      source = trimmed(whole, 12);
      sw = source.width;
      sh = source.height;
    }
  }
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("This browser can't draw the label for the printer.");
  context.fillStyle = "#fff";
  context.fillRect(0, 0, W, H);
  context.imageSmoothingEnabled = false;
  if (sw > sh) {
    // Turned a quarter clockwise, as the browser's label page does.
    context.translate(W, 0);
    context.rotate(Math.PI / 2);
    context.drawImage(source, 0, 0, H, W);
  } else {
    const k = Math.min(W / sw, H / sh);
    context.drawImage(source, (W - sw * k) / 2, (H - sh * k) / 2, sw * k, sh * k);
  }
  const bits = pixelsToBits(context.getImageData(0, 0, W, H).data, W, H);
  return `^XA^PW${W}^LL${H}^LH0,0${await bitsToGfaZ64(bits, W, H)}^XZ`;
}
