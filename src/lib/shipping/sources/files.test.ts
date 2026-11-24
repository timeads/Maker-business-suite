import { describe, expect, it } from "vitest";
import type { Fetch } from "../../connections/types";
import { downloadEasyPostLabel, isEasyPostFileLink, labelKind } from "./files";

const b64 = (text: string) => Buffer.from(text, "latin1").toString("base64");
const ZPL = "^XA^FO50,50^A0N,30,30^FDSam Shopper^FS^XZ";

const serving = (body: string | Uint8Array<ArrayBuffer>, status = 200) => {
  const calls: { url: string; headers: Headers }[] = [];
  const impl = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    calls.push({ url: String(input), headers: new Headers(init.headers) });
    return new Response(body, { status });
  }) as Fetch;
  return { impl, calls };
};

describe("a label's file", () => {
  it("is known by what it holds, not by what was asked for", () => {
    expect(labelKind(b64(ZPL))).toBe("text/plain");
    expect(labelKind(b64("GIF89a...."))).toBe("image/gif");
    expect(labelKind(b64("\x89PNG\r\n"))).toBe("image/png");
    expect(labelKind(b64("%PDF-1.7"))).toBe("application/pdf");
    expect(labelKind(b64("<html>"))).toBeNull();
    expect(labelKind("not base64 at all!")).toBeNull();
  });

  it("is fetched from EasyPost's link with no key, and kept as base64", async () => {
    const { impl, calls } = serving(ZPL);
    const file = await downloadEasyPostLabel("https://easypost-files.example/l.zpl", impl);
    expect(file).toEqual({ contentType: "text/plain", data: b64(ZPL) });
    expect(calls).toHaveLength(1);
    expect(calls[0].headers.get("authorization")).toBeNull();
  });

  it("is left out, never thrown about, when it can't be had or isn't a label", async () => {
    expect(await downloadEasyPostLabel("http://plain.example/l.zpl", serving(ZPL).impl)).toBeNull();
    expect(await downloadEasyPostLabel("not a link", serving(ZPL).impl)).toBeNull();
    expect(await downloadEasyPostLabel("https://x.example/l", serving(ZPL, 403).impl)).toBeNull();
    expect(await downloadEasyPostLabel("https://x.example/l", serving("").impl)).toBeNull();
    expect(await downloadEasyPostLabel("https://x.example/l", serving("<html>").impl)).toBeNull();
    const broken = (async () => {
      throw new Error("network down");
    }) as Fetch;
    expect(await downloadEasyPostLabel("https://x.example/l", broken)).toBeNull();
  });

  it("is only fetched again later from EasyPost's own file store", () => {
    for (const link of [
      "https://easypost-files.s3.us-west-2.amazonaws.com/files/postage_label/2026/a.png",
      "https://easypost-files.s3-us-west-2.amazonaws.com/files/postage_label/2026/a.zpl",
      "https://assets.easypost.com/labels/a.png",
    ]) {
      expect(isEasyPostFileLink(link), link).toBe(true);
    }
    for (const link of [
      "http://easypost-files.s3.us-west-2.amazonaws.com/a.png",
      "https://evil.example/easypost-files.s3.amazonaws.com/a.png",
      "https://easypost-files.s3.amazonaws.com.evil.example/a.png",
      "https://not-easypost.com/a.png",
      "https://169.254.169.254/latest/meta-data",
      "https://localhost/a.png",
      "",
    ]) {
      expect(isEasyPostFileLink(link), link).toBe(false);
    }
  });
});

describe("handing label files to the database", () => {
  it("names the kind the way the database reads it", async () => {
    const { filesForKeeping } = await import("./files");
    expect(filesForKeeping([{ box: 2, contentType: "image/gif", data: "R0lGODlh" }])).toEqual([
      { box: 2, content_type: "image/gif", data: "R0lGODlh" },
    ]);
  });
});
