import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  bitsToGfa,
  bitsToGfaZ64,
  compressRow,
  contentBox,
  crc16,
  expandRows,
  pixelsToBits,
  testLabelZpl,
  wrapText,
  zplFromBase64,
  zplText,
} from "./zpl";

describe("ZPL text", () => {
  it("passes plain words and hides anything the printer would read as a command", () => {
    expect(zplText("Wool rug, large")).toBe("Wool rug, large");
    // ^ and ~ start commands; _ is the escape itself.
    expect(zplText("a^XZ~JA_b")).toBe("a_5EXZ_7EJA_5Fb");
    // Accents go as UTF-8 bytes, for ^CI28.
    expect(zplText("Zoë")).toBe("Zo_C3_AB");
    // A line break in a note can't end the field.
    expect(zplText("  one\n two\t three ")).toBe("one two three");
  });

  it("wraps on words, cuts a word too long for a line, and keeps typed line breaks", () => {
    expect(wrapText("one two three four", 9)).toEqual(["one two", "three", "four"]);
    expect(wrapText("abcdefghij kl", 4)).toEqual(["abcd", "efgh", "ij", "kl"]);
    expect(wrapText("first\nsecond line", 20)).toEqual(["first", "second line"]);
    expect(wrapText("", 10)).toEqual([]);
  });

  it("makes a test label that is one whole label and carries no stray commands", () => {
    const zpl = testLabelZpl("Tuft ^XA Studio");
    expect(zpl.startsWith("^XA")).toBe(true);
    expect(zpl.endsWith("^XZ")).toBe(true);
    expect(zpl.match(/\^XA/g)).toHaveLength(1);
    expect(zpl).toContain("Tuft _5EXA Studio");
    expect(zpl).toContain("^BCN,100,Y,N,N^FDTEST-1234^FS");
    expect(testLabelZpl("")).toContain("^FDTest label^FS");
  });

  it("reads a carrier's base64 ZPL back to text", () => {
    const zpl = "^XA^FO50,50^A0N,30,30^FDTo: Zoë^FS^XZ";
    expect(zplFromBase64(Buffer.from(zpl, "utf8").toString("base64"))).toBe(zpl);
  });
});

describe("ZPL graphic encoding", () => {
  it("uses ZPL's run-length letters, trailing-zero commas and repeat colons", () => {
    expect(compressRow("FFFF0000", null)).toBe("JF,"); // J = 4
    expect(compressRow("00000000", null)).toBe(",");
    expect(compressRow("AB", null)).toBe("AB");
    expect(compressRow("FFFF0000", "FFFF0000")).toBe(":");
    expect(compressRow("F".repeat(45), null)).toBe("hKF"); // 40 + 5
  });

  it("round-trips a picture exactly", () => {
    const w = 100;
    const h = 60;
    const bits = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        bits[y * w + x] = (x * 7 + y * 3) % 11 < 4 || (y > 20 && y < 30) ? 1 : 0;
      }
    }
    const gfa = bitsToGfa(bits, w, h);
    const m = /^\^FO0,0\^GFA,(\d+),(\d+),(\d+),(.*)\^FS$/.exec(gfa)!;
    const bytesPerRow = Number(m[3]);
    expect(bytesPerRow).toBe(13);
    expect(Number(m[1])).toBe(13 * h);
    const rows = expandRows(m[4], bytesPerRow);
    expect(rows).toHaveLength(h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const byte = parseInt(rows[y].slice(Math.floor(x / 8) * 2, Math.floor(x / 8) * 2 + 2), 16);
        expect((byte >> (7 - (x % 8))) & 1).toBe(bits[y * w + x]);
      }
    }
    expect(m[4].length).toBeLessThan(13 * 2 * h); // actually compressed
  });

  it("uses the CRC-16/XMODEM check ZPL expects", () => {
    expect(crc16("123456789")).toBe("31C3"); // the standard check value
  });

  it("compresses to zlib + base64 that inflates back to the same pixels, much smaller", async () => {
    const w = 812;
    const h = 600;
    const bits = new Uint8Array(w * h);
    for (let y = 100; y < 140; y++) {
      for (let x = 50; x < 700; x++) bits[y * w + x] = (x >> 2) % 3 === 0 ? 1 : 0;
    }
    const gfa = await bitsToGfaZ64(bits, w, h);
    const m = /^\^FO0,0\^GFA,(\d+),(\d+),(\d+),:Z64:([A-Za-z0-9+/=]+):([0-9A-F]{4})\^FS$/.exec(
      gfa,
    )!;
    expect(m).toBeTruthy();
    expect(crc16(m[4])).toBe(m[5]);
    const raw = inflateSync(Buffer.from(m[4], "base64"));
    const bpr = Number(m[3]);
    expect(raw.length).toBe(Number(m[1]));
    for (let y = 0; y < h; y += 7) {
      for (let x = 0; x < w; x += 3) {
        expect((raw[y * bpr + (x >> 3)] >> (7 - (x & 7))) & 1).toBe(bits[y * w + x]);
      }
    }
    expect(gfa.length).toBeLessThan(bitsToGfa(bits, w, h).length);
  });

  it("finds what is printed on a picture, and turns pixels into black and white", () => {
    const rgba = (w: number, h: number, dark: [number, number][]) => {
      const px = new Uint8ClampedArray(w * h * 4).fill(255);
      for (const [x, y] of dark) px.fill(0, (y * w + x) * 4, (y * w + x) * 4 + 3);
      return px;
    };
    expect(contentBox(rgba(10, 8, []), 10, 8)).toBeNull();
    expect(
      contentBox(
        rgba(10, 8, [
          [2, 3],
          [7, 5],
        ]),
        10,
        8,
      ),
    ).toEqual({ x0: 2, y0: 3, x1: 7, y1: 5 });
    expect([...pixelsToBits(rgba(3, 1, [[1, 0]]), 3, 1)]).toEqual([0, 1, 0]);
  });
});
