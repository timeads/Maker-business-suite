/**
 * A photo's size, read from its own first bytes (no image library): the PNG header, or a
 * JPEG's frame header. A JPEG's EXIF orientation is honoured, so a phone photo taken on its
 * side is measured the way it is shown (and the way Instagram and the browser show it).
 * Null when the bytes aren't a PNG or JPEG we can read.
 */
export type ImageSize = { width: number; height: number; type: "image/png" | "image/jpeg" };

export function imageSize(bytes: Uint8Array): ImageSize | null {
  if (isPng(bytes)) {
    if (bytes.length < 24) return null;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const width = view.getUint32(16);
    const height = view.getUint32(20);
    return width > 0 && height > 0 ? { width, height, type: "image/png" } : null;
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return jpegSize(bytes);
  return null;
}

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const isPng = (bytes: Uint8Array) => PNG.every((b, i) => bytes[i] === b);

// Start-of-frame markers carry the size; C4 (huffman), C8 (reserved) and CC (arithmetic) don't.
const isFrame = (marker: number) =>
  marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;

function jpegSize(bytes: Uint8Array): ImageSize | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 2;
  let orientation = 1;
  while (at + 4 <= bytes.length) {
    if (bytes[at] !== 0xff) return null;
    const marker = bytes[at + 1];
    // Fill bytes and markers without a length.
    if (marker === 0xff) {
      at += 1;
      continue;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      at += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return null;
    const length = view.getUint16(at + 2);
    if (length < 2 || at + 2 + length > bytes.length) return null;
    if (marker === 0xe1) orientation = exifOrientation(bytes, at + 4, length - 2) ?? orientation;
    if (isFrame(marker)) {
      if (length < 7) return null;
      const height = view.getUint16(at + 5);
      const width = view.getUint16(at + 7);
      if (!(width > 0 && height > 0)) return null;
      // 5 to 8 are turned a quarter: what is shown is the other way round.
      return orientation >= 5 && orientation <= 8
        ? { width: height, height: width, type: "image/jpeg" }
        : { width, height, type: "image/jpeg" };
    }
    at += 2 + length;
  }
  return null;
}

/** The orientation tag (0x0112) from an EXIF block, or null. */
function exifOrientation(bytes: Uint8Array, start: number, length: number): number | null {
  const end = start + length;
  // "Exif\0\0", then a TIFF header.
  if (length < 14) return null;
  const exif = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00];
  if (!exif.every((b, i) => bytes[start + i] === b)) return null;
  const tiff = start + 6;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const little = bytes[tiff] === 0x49 && bytes[tiff + 1] === 0x49;
  const big = bytes[tiff] === 0x4d && bytes[tiff + 1] === 0x4d;
  if (!little && !big) return null;
  const u16 = (at: number) => (at + 2 <= end ? view.getUint16(at, little) : -1);
  const u32 = (at: number) => (at + 4 <= end ? view.getUint32(at, little) : -1);
  const ifd = u32(tiff + 4);
  if (ifd < 0) return null;
  const entries = u16(tiff + ifd);
  if (entries < 0) return null;
  for (let i = 0; i < entries; i++) {
    const entry = tiff + ifd + 2 + i * 12;
    if (entry + 12 > end) return null;
    if (u16(entry) === 0x0112) {
      const value = u16(entry + 8);
      return value >= 1 && value <= 8 ? value : null;
    }
  }
  return null;
}
