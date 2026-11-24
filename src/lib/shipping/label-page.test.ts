import { describe, expect, it } from "vitest";
import {
  gifSize,
  labelPageCsp,
  labelPictureSize,
  labelPrintPage,
  liesSideways,
  pngSize,
} from "./label-page";

/** The first bytes of a PNG that says it is `width` × `height`. */
function pngHeader(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12); // IHDR
  view.setUint32(16, width);
  view.setUint32(20, height);
  bytes.set([8, 2, 0, 0, 0], 24);
  return bytes;
}

function gifHeader(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(13);
  bytes.set(
    [..."GIF89a"].map((char) => char.charCodeAt(0)),
    0,
  );
  bytes[6] = width & 0xff;
  bytes[7] = width >> 8;
  bytes[8] = height & 0xff;
  bytes[9] = height >> 8;
  return bytes;
}

const base64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");
const ID = "0b9d7a52-58a4-4c8e-9a53-3a8f2f6f8f10";
const NONCE = "c2FmZS1ub25jZS12YWx1ZQ==";

describe("reading a label picture's size", () => {
  it("reads a PNG's width and height from its header", () => {
    expect(pngSize(pngHeader(1200, 1800))).toEqual({ width: 1200, height: 1800 });
    expect(pngSize(pngHeader(1800, 1200))).toEqual({ width: 1800, height: 1200 });
  });

  it("reads big sizes without going negative", () => {
    expect(pngSize(pngHeader(70000, 3))).toEqual({ width: 70000, height: 3 });
  });

  it("says nothing for bytes that aren't a PNG", () => {
    expect(pngSize(new Uint8Array(40))).toBeNull();
    expect(pngSize(pngHeader(1200, 1800).subarray(0, 20))).toBeNull();
    expect(pngSize(pngHeader(0, 1800))).toBeNull();
    const wrongChunk = pngHeader(1200, 1800);
    wrongChunk[12] = 0x70;
    expect(pngSize(wrongChunk)).toBeNull();
    expect(pngSize(gifHeader(800, 1200))).toBeNull();
  });

  it("reads a GIF's size, little end first", () => {
    expect(gifSize(gifHeader(1400, 800))).toEqual({ width: 1400, height: 800 });
    expect(gifSize(pngHeader(1, 1))).toBeNull();
  });

  it("reads the size from a kept label's first bytes only", () => {
    const whole = new Uint8Array(5000);
    whole.set(pngHeader(1200, 1800), 0);
    expect(labelPictureSize("image/png", base64(whole))).toEqual({ width: 1200, height: 1800 });
    expect(labelPictureSize("image/gif", base64(gifHeader(1400, 800)))).toEqual({
      width: 1400,
      height: 800,
    });
    expect(labelPictureSize("application/pdf", base64(whole))).toBeNull();
    expect(labelPictureSize("image/png", "!!!not base64!!!")).toBeNull();
  });

  it("turns a picture only when it is wider than tall", () => {
    expect(liesSideways({ width: 1800, height: 1200 })).toBe(true);
    expect(liesSideways({ width: 1200, height: 1800 })).toBe(false);
    expect(liesSideways({ width: 1200, height: 1200 })).toBe(false);
    // Unreadable: left upright rather than guessed at.
    expect(liesSideways(null)).toBe(false);
  });
});

describe("the label print page", () => {
  it("is a 4 × 6 inch sheet with no margin, so the browser adds no header or footer", () => {
    const html = labelPrintPage({ id: ID, sideways: false });
    expect(html).toContain("@page { size: 4in 6in; margin: 0 }");
    expect(html).toContain(".label { width: 4in; height: 6in;");
    expect(html).toContain(`<img src="${ID}?raw=1" alt="Postage label">`);
  });

  it("fits an upright picture whole, without cropping or turning it", () => {
    const html = labelPrintPage({ id: ID, sideways: false });
    expect(html).toContain("width: 4in; height: 6in; object-fit: contain");
    expect(html).not.toContain("rotate(");
  });

  it("stands a sideways picture upright, still whole", () => {
    const html = labelPrintPage({ id: ID, sideways: true });
    expect(html).toContain("width: 6in; height: 4in; object-fit: contain");
    expect(html).toContain("transform: rotate(90deg)");
  });

  it("keeps a UPS GIF edge to edge, as it has always printed", () => {
    const html = labelPrintPage({ id: ID, sideways: true, stretch: true });
    expect(html).toContain(
      "position: absolute; top: 0; left: 4in; width: 6in; height: 4in; object-fit: fill; transform-origin: top left; transform: rotate(90deg)",
    );
  });

  it("has no script at all without a nonce", () => {
    const html = labelPrintPage({ id: ID, sideways: false });
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<button");
    expect(labelPrintPage({ id: ID, sideways: false, nonce: 'x" onload="alert(1)' })).not.toContain(
      "<script",
    );
  });

  it("prints by itself through one script that carries the response's nonce", () => {
    const html = labelPrintPage({ id: ID, sideways: false, nonce: NONCE });
    expect(html.match(/<script/g)).toHaveLength(1);
    expect(html).toContain(`<script nonce="${NONCE}">`);
    expect(html).toContain("window.print()");
    // Nothing inline that the policy would have to be loosened for.
    expect(html).not.toMatch(/\son[a-z]+=/i);
    expect(html).toContain("if (false) {");
    expect(labelPrintPage({ id: ID, sideways: false, nonce: NONCE, crop: true })).toContain(
      "if (true) {",
    );
  });

  it("hides the Print bar on paper", () => {
    expect(labelPrintPage({ id: ID, sideways: false, nonce: NONCE })).toContain(
      "@media print { .bar { display: none } }",
    );
  });

  it("refuses anything that isn't a label's own id", () => {
    expect(() => labelPrintPage({ id: '"><script>', sideways: false })).toThrow();
  });

  it("allows only its own picture, its styles and the one script", () => {
    const csp = labelPageCsp(NONCE);
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("img-src 'self'");
    expect(csp).toContain(`script-src 'nonce-${NONCE}'`);
    expect(csp).not.toContain("unsafe-eval");
    expect(csp).not.toMatch(/script-src[^;]*unsafe-inline/);
  });
});
