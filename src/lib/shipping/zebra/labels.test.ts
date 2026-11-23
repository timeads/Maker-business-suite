import { describe, expect, it } from "vitest";
import { labelsToZpl } from "./labels";

const b64 = (text: string) => Buffer.from(text, "utf8").toString("base64");

describe("labels for the Zebra", () => {
  it("sends ZPL as it is, draws pictures, and keeps the boxes in order", async () => {
    const drawn: unknown[] = [];
    const jobs = await labelsToZpl(
      [
        { box: 2, kind: "gif", data: "R0lGOD", crop: true },
        { box: 1, kind: "zpl", data: b64("^XA^FDBox one^FS^XZ\n") },
        { box: 3, kind: "png", data: "iVBOR" },
      ],
      300,
      async (data, kind, dpi, crop) => {
        drawn.push([data, kind, dpi, crop]);
        return `^XA^FX drawn ${kind}^XZ`;
      },
    );
    expect(jobs).toEqual(["^XA^FDBox one^FS^XZ", "^XA^FX drawn gif^XZ", "^XA^FX drawn png^XZ"]);
    expect(drawn).toEqual([
      ["R0lGOD", "gif", 300, true],
      ["iVBOR", "png", 300, false],
    ]);
  });
});
