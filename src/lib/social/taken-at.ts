import { zonedTimeToUtc } from "../bookings/slots";

/**
 * When a photo was taken, read by the server from the photo's own bytes (no
 * image library). Ported from the Content Hub's `media-time.ts`
 * (`takenAtFromExif`) and made multi-tenant: EXIF keeps the camera's wall
 * clock with no zone, so it is read on the workspace's clock, unless the
 * camera also wrote its offset (OffsetTimeOriginal), which then wins.
 *
 * Only JPEG's EXIF is read. A PNG, a video, or a photo with no date gives
 * null, and the photo is then ordered by when it was added. Nothing the
 * browser says (a file name, a modified time) is trusted for this.
 */

export type ExifTime = {
  /** The camera's wall clock, "YYYY-MM-DDTHH:MM:SS". */
  local: string;
  /** "+HH:MM" when the camera wrote its offset from UTC. */
  offset: string | null;
};

const DATE = /^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})$/;
const OFFSET = /^([+-])(\d{2}):(\d{2})$/;

/** DateTimeOriginal (else DateTime) from a JPEG's EXIF block, with its offset if written. */
export function exifTakenAt(bytes: Uint8Array): ExifTime | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.byteLength < 4 || view.getUint16(0) !== 0xffd8) return null;

  // Walk the JPEG's segments to the APP1 segment that starts with "Exif\0\0".
  let offset = 2;
  let tiff = -1;
  while (offset + 4 <= view.byteLength) {
    if (view.getUint8(offset) !== 0xff) break;
    const marker = view.getUint8(offset + 1);
    const size = view.getUint16(offset + 2);
    if (
      marker === 0xe1 &&
      offset + 10 <= view.byteLength &&
      view.getUint32(offset + 4) === 0x45786966
    ) {
      tiff = offset + 10;
      break;
    }
    if (marker === 0xda || size < 2) break;
    offset += 2 + size;
  }
  if (tiff < 0 || tiff + 8 > view.byteLength) return null;

  const little = view.getUint16(tiff) === 0x4949;
  if (!little && view.getUint16(tiff) !== 0x4d4d) return null;
  const u16 = (o: number) => view.getUint16(o, little);
  const u32 = (o: number) => view.getUint32(o, little);

  const ascii = (entry: number, length: number): string | null => {
    const count = u32(entry + 4);
    if (count < length) return null;
    const start = count <= 4 ? entry + 8 : tiff + u32(entry + 8);
    if (start < 0 || start + length > view.byteLength) return null;
    let out = "";
    for (let i = 0; i < length; i++) out += String.fromCharCode(view.getUint8(start + i));
    return out;
  };

  /** A tag in the directory at `dir`: the entry's offset, or -1. */
  const find = (dir: number, tag: number): number => {
    if (dir < 0 || dir + 2 > view.byteLength) return -1;
    const n = u16(dir);
    for (let i = 0; i < n; i++) {
      const entry = dir + 2 + i * 12;
      if (entry + 12 > view.byteLength) return -1;
      if (u16(entry) === tag) return entry;
    }
    return -1;
  };

  const ifd0 = tiff + u32(tiff + 4);
  let text: string | null = null;
  let zone: string | null = null;
  const exifPointer = find(ifd0, 0x8769);
  if (exifPointer >= 0) {
    const exif = tiff + u32(exifPointer + 8);
    const original = find(exif, 0x9003);
    if (original >= 0) text = ascii(original, 19);
    const offsetTag = find(exif, 0x9011);
    if (text && offsetTag >= 0) zone = ascii(offsetTag, 6);
  }
  if (!text) {
    const dateTime = find(ifd0, 0x0132);
    if (dateTime >= 0) text = ascii(dateTime, 19);
  }
  const m = text ? DATE.exec(text) : null;
  if (!m) return null;
  return {
    local: `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}`,
    offset: zone && OFFSET.test(zone) ? zone : null,
  };
}

/**
 * The moment a photo was taken, or null when its bytes don't say. A time
 * before 2000 or more than a day ahead is a camera with its clock unset, not
 * a date.
 */
export function takenAtFrom(bytes: Uint8Array, timeZone: string, now = new Date()): Date | null {
  let time: ExifTime | null;
  try {
    time = exifTakenAt(bytes);
  } catch {
    return null;
  }
  if (!time) return null;
  const [day, clock] = time.local.split("T");
  const [hours, minutes, seconds] = clock.split(":").map(Number);
  const [y, mo, d] = day.split("-").map(Number);
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || hours > 23 || minutes > 59 || seconds > 59) {
    return null;
  }
  let at: Date | null;
  if (time.offset) {
    const sign = time.offset.startsWith("-") ? -1 : 1;
    const shift = sign * (Number(time.offset.slice(1, 3)) * 60 + Number(time.offset.slice(4, 6)));
    at = new Date(Date.UTC(y, mo - 1, d, hours, minutes - shift, seconds));
  } else {
    // A wall-clock time that doesn't exist on the workspace's clock (the hour the clocks skip)
    // is read an hour on, as the camera would have shown it.
    const base = zonedTimeToUtc(day, hours * 60 + minutes, timeZone);
    const shifted = base ?? zonedTimeToUtc(day, hours * 60 + minutes + 60, timeZone);
    at = shifted ? new Date(shifted.getTime() + seconds * 1000) : null;
  }
  if (!at || Number.isNaN(at.getTime())) return null;
  const t = at.getTime();
  return t > Date.UTC(2000, 0, 1) && t < now.getTime() + 86_400_000 ? at : null;
}
