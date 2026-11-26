import { describe, expect, it } from "vitest";
import { copyCrop, cropFor, fits, needsCopy } from "./fit";
import { imageSize } from "./image-size";

describe("fitting a photo to Instagram", () => {
  it("takes feed photos between 4:5 and 1.91:1 as they are", () => {
    expect(fits(1080, 1350, "instagram")).toBe(true);
    expect(fits(1080, 1080, "instagram")).toBe(true);
    expect(fits(1910, 1000, "instagram")).toBe(true);
    expect(fits(1080, 1351, "instagram")).toBe(true); // a pixel of rounding
    expect(fits(1080, 1920, "instagram")).toBe(false);
    expect(fits(3000, 1000, "instagram")).toBe(false);
    expect(fits(0, 100, "instagram")).toBe(false);
  });

  it("takes only 9:16 for a Story", () => {
    expect(fits(1080, 1920, "instagram_story")).toBe(true);
    expect(fits(720, 1280, "instagram_story")).toBe(true);
    expect(fits(1080, 1350, "instagram_story")).toBe(false);
  });

  it("crops a tall photo to 4:5 from the middle, top and bottom trimmed", () => {
    const crop = cropFor(3000, 6000, "instagram")!;
    expect(crop).toEqual({ sx: 0, sy: 1125, sw: 3000, sh: 3750, width: 1080, height: 1350 });
    expect(fits(crop.width, crop.height, "instagram")).toBe(true);
  });

  it("crops a wide photo to 1.91:1, the sides trimmed", () => {
    const crop = cropFor(4000, 1000, "instagram")!;
    expect(crop.sw).toBe(1910);
    expect(crop.sx).toBe(1045);
    expect(crop.sh).toBe(1000);
    expect(fits(crop.width, crop.height, "instagram")).toBe(true);
  });

  it("crops a square photo to 9:16 for a Story, never making it bigger than it was", () => {
    const crop = cropFor(900, 900, "instagram_story")!;
    expect(crop.sw).toBe(506);
    expect(crop.sh).toBe(900);
    expect(crop.width).toBe(506);
    expect(fits(crop.width, crop.height, "instagram_story")).toBe(true);
  });

  it("leaves a photo that fits alone, but still copies a PNG or one of unknown size", () => {
    expect(cropFor(1080, 1350, "instagram")).toBeNull();
    expect(needsCopy({ width: 1080, height: 1350, mimeType: "image/jpeg" }, "instagram")).toBe(
      false,
    );
    expect(needsCopy({ width: 1080, height: 1350, mimeType: "image/png" }, "instagram")).toBe(true);
    expect(needsCopy({ width: null, height: null, mimeType: "image/jpeg" }, "instagram")).toBe(
      true,
    );
    const whole = copyCrop(2000, 2000, "instagram");
    expect(whole).toEqual({ sx: 0, sy: 0, sw: 2000, sh: 2000, width: 1080, height: 1080 });
  });
});

/** A tiny JPEG's header: SOI, an optional EXIF block, then a baseline frame header. */
function jpeg(width: number, height: number, orientation?: number): Uint8Array {
  const parts: number[] = [0xff, 0xd8];
  if (orientation) {
    // APP1: "Exif\0\0", little-endian TIFF, one IFD entry (0x0112, SHORT, 1, value).
    const tiff = [0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00, 0x01, 0x00];
    const entry = [0x12, 0x01, 0x03, 0x00, 0x01, 0x00, 0x00, 0x00, orientation, 0x00, 0, 0];
    const body = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00, ...tiff, ...entry, 0, 0, 0, 0];
    const length = body.length + 2;
    parts.push(0xff, 0xe1, length >> 8, length & 0xff, ...body);
  }
  parts.push(0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff);
  parts.push(0x03, ...new Array(9).fill(0));
  return new Uint8Array(parts);
}

describe("reading a photo's size from its bytes", () => {
  it("reads a PNG", () => {
    const png = new Uint8Array(24);
    png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
    png.set([0, 0, 0x04, 0x38], 16); // 1080
    png.set([0, 0, 0x05, 0x46], 20); // 1350
    expect(imageSize(png)).toEqual({ width: 1080, height: 1350, type: "image/png" });
  });

  it("reads a JPEG, turned the way its EXIF says it is shown", () => {
    expect(imageSize(jpeg(4032, 3024))).toEqual({ width: 4032, height: 3024, type: "image/jpeg" });
    expect(imageSize(jpeg(4032, 3024, 1))).toMatchObject({ width: 4032, height: 3024 });
    expect(imageSize(jpeg(4032, 3024, 6))).toMatchObject({ width: 3024, height: 4032 });
    expect(imageSize(jpeg(4032, 3024, 3))).toMatchObject({ width: 4032, height: 3024 });
  });

  it("refuses anything else", () => {
    expect(imageSize(new TextEncoder().encode("<svg></svg>"))).toBeNull();
    expect(imageSize(new Uint8Array([0xff, 0xd8, 0xff]))).toBeNull();
  });
});
