import { describe, expect, it } from "vitest";
import { exifTakenAt, takenAtFrom } from "./taken-at";

/**
 * Ported from the Content Hub's `media-time.test.ts` (`takenAtFromExif`),
 * with the workspace's clock and the camera's own offset added.
 */

/** A minimal JPEG whose EXIF block carries the given dates. */
function jpegWithExif(opts: {
  original?: string;
  dateTime?: string;
  offset?: string;
  little?: boolean;
}): Uint8Array {
  const little = opts.little ?? true;
  const tiff = new Uint8Array(240);
  const v = new DataView(tiff.buffer);
  const ascii = (at: number, text: string) => {
    for (let i = 0; i < text.length; i++) tiff[at + i] = text.charCodeAt(i);
  };
  v.setUint16(0, little ? 0x4949 : 0x4d4d);
  v.setUint16(2, 42, little);
  v.setUint32(4, 8, little); // IFD0 at 8
  const entries: [number, number][] = [];
  if (opts.dateTime) entries.push([0x0132, 100]);
  if (opts.original) entries.push([0x8769, 50]);
  v.setUint16(8, entries.length, little);
  entries.forEach(([tag, value], i) => {
    const e = 10 + i * 12;
    v.setUint16(e, tag, little);
    v.setUint16(e + 2, tag === 0x8769 ? 4 : 2, little);
    v.setUint32(e + 4, tag === 0x8769 ? 1 : 20, little);
    v.setUint32(e + 8, value, little);
  });
  if (opts.dateTime) ascii(100, opts.dateTime);
  if (opts.original) {
    const count = opts.offset ? 2 : 1;
    v.setUint16(50, count, little); // Exif IFD
    v.setUint16(52, 0x9003, little);
    v.setUint16(54, 2, little);
    v.setUint32(56, 20, little);
    v.setUint32(60, 140, little);
    ascii(140, opts.original);
    if (opts.offset) {
      v.setUint16(64, 0x9011, little);
      v.setUint16(66, 2, little);
      v.setUint32(68, 7, little);
      v.setUint32(72, 180, little);
      ascii(180, opts.offset);
    }
  }
  const out = new Uint8Array(2 + 4 + 6 + tiff.length);
  const o = new DataView(out.buffer);
  o.setUint16(0, 0xffd8);
  o.setUint16(2, 0xffe1);
  o.setUint16(4, 2 + 6 + tiff.length);
  out.set([0x45, 0x78, 0x69, 0x66, 0, 0], 6);
  out.set(tiff, 12);
  return out;
}

const NOW = new Date("2026-11-26T12:00:00Z");

describe("exifTakenAt", () => {
  it("prefers DateTimeOriginal, in either byte order", () => {
    for (const little of [true, false]) {
      const bytes = jpegWithExif({
        original: "2026:10:12 14:56:17",
        dateTime: "2026:10:13 09:00:00",
        little,
      });
      expect(exifTakenAt(bytes)).toEqual({ local: "2026-10-12T14:56:17", offset: null });
    }
  });

  it("falls back to DateTime", () => {
    expect(exifTakenAt(jpegWithExif({ dateTime: "2026:10:13 09:00:00" }))?.local).toBe(
      "2026-10-13T09:00:00",
    );
  });

  it("reads the camera's offset when it wrote one", () => {
    const bytes = jpegWithExif({ original: "2026:10:12 14:56:17", offset: "-04:00" });
    expect(exifTakenAt(bytes)).toEqual({ local: "2026-10-12T14:56:17", offset: "-04:00" });
  });

  it("returns null for a PNG, a JPEG with no EXIF, a cut-off block and a broken date", () => {
    expect(exifTakenAt(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBeNull();
    expect(exifTakenAt(new Uint8Array([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x04, 0, 0]))).toBeNull();
    expect(exifTakenAt(jpegWithExif({ original: "2026:10:12 14:56:17" }).slice(0, 40))).toBeNull();
    expect(exifTakenAt(jpegWithExif({ original: "not a date string !!" }))).toBeNull();
    expect(exifTakenAt(new Uint8Array(0))).toBeNull();
  });
});

describe("takenAtFrom", () => {
  it("reads the camera's clock on the workspace's clock", () => {
    const bytes = jpegWithExif({ original: "2026:10:12 14:56:17" });
    expect(takenAtFrom(bytes, "America/New_York", NOW)?.toISOString()).toBe(
      "2026-10-12T18:56:17.000Z",
    );
    expect(takenAtFrom(bytes, "Europe/London", NOW)?.toISOString()).toBe(
      "2026-10-12T13:56:17.000Z",
    );
  });

  it("uses the camera's own offset over the workspace's clock", () => {
    const bytes = jpegWithExif({ original: "2026:10:12 14:56:17", offset: "+09:00" });
    expect(takenAtFrom(bytes, "America/New_York", NOW)?.toISOString()).toBe(
      "2026-10-12T05:56:17.000Z",
    );
  });

  it("is right either side of the clocks changing", () => {
    // New York: clocks go back at 2am on 1 November 2026, forward at 2am on 8 March 2026.
    const before = takenAtFrom(
      jpegWithExif({ original: "2026:10:31 12:00:00" }),
      "America/New_York",
      NOW,
    );
    const after = takenAtFrom(
      jpegWithExif({ original: "2026:11:02 12:00:00" }),
      "America/New_York",
      NOW,
    );
    expect(before?.toISOString()).toBe("2026-10-31T16:00:00.000Z");
    expect(after?.toISOString()).toBe("2026-11-02T17:00:00.000Z");
    // 2:30am on 8 March never happened there; it is read as 3:30am.
    const skipped = takenAtFrom(
      jpegWithExif({ original: "2026:03:08 02:30:00" }),
      "America/New_York",
      NOW,
    );
    expect(skipped?.toISOString()).toBe("2026-03-08T07:30:00.000Z");
  });

  it("ignores a camera whose clock was never set, or is ahead of today", () => {
    expect(takenAtFrom(jpegWithExif({ original: "1980:01:01 00:00:00" }), "UTC", NOW)).toBeNull();
    expect(takenAtFrom(jpegWithExif({ original: "2027:06:01 00:00:00" }), "UTC", NOW)).toBeNull();
    expect(takenAtFrom(jpegWithExif({ original: "2026:13:01 00:00:00" }), "UTC", NOW)).toBeNull();
  });

  it("never throws on bytes that aren't a photo", () => {
    expect(
      takenAtFrom(new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 0xff, 0xff]), "UTC", NOW),
    ).toBeNull();
    expect(takenAtFrom(new Uint8Array(3), "UTC", NOW)).toBeNull();
  });
});
