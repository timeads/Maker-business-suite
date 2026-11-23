import { describe, expect, it } from "vitest";
import { labelsToZpl, printKind } from "./labels";

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

  it("a PDF is one label per page, in page order, in its box's place", async () => {
    const asked: unknown[] = [];
    const jobs = await labelsToZpl(
      [
        { box: 3, kind: "zpl", data: b64("^XA^FDBox three^FS^XZ") },
        { box: 2, kind: "pdf", data: "JVBERi0y" },
        { box: 1, kind: "pdf", data: "JVBERi0x" },
      ],
      203,
      async () => {
        throw new Error("no pictures here");
      },
      async (data, dpi) => {
        asked.push([data, dpi]);
        return data === "JVBERi0x" ? ["^XA^FX 1a^XZ", "^XA^FX 1b^XZ"] : ["^XA^FX 2a^XZ"];
      },
    );
    expect(jobs).toEqual(["^XA^FX 1a^XZ", "^XA^FX 1b^XZ", "^XA^FX 2a^XZ", "^XA^FDBox three^FS^XZ"]);
    expect(asked).toEqual([
      ["JVBERi0x", 203],
      ["JVBERi0y", 203],
    ]);
  });

  it("a PDF that can't be drawn stops the run, so nothing prints out of order", async () => {
    await expect(
      labelsToZpl(
        [
          { box: 1, kind: "pdf", data: "JVBERi0x" },
          { box: 2, kind: "zpl", data: b64("^XA^XZ") },
        ],
        203,
        undefined,
        async () => {
          throw new Error("We couldn't draw this label's PDF for the Zebra.");
        },
      ),
    ).rejects.toThrow(/couldn't draw/);
  });

  it("knows how each kind of kept file goes to the printer", () => {
    expect(printKind("text/plain")).toBe("zpl");
    expect(printKind("image/png")).toBe("png");
    expect(printKind("image/gif")).toBe("gif");
    expect(printKind("application/pdf")).toBe("pdf");
    expect(printKind("text/html")).toBeNull();
    expect(printKind("constructor")).toBeNull();
    expect(printKind("")).toBeNull();
  });
});
