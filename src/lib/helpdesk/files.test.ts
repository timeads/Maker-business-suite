import { describe, expect, it } from "vitest";
import {
  MAX_DAILY_BYTES,
  MAX_FILE_BYTES,
  MAX_MESSAGE_BYTES,
  MAX_MESSAGE_FILES,
  claimedType,
  contentId,
  displayName,
  fileHeaders,
  filesNote,
  fromBase64,
  notKeptWords,
  planFiles,
  sniffType,
  storagePath,
  type IncomingFile,
} from "./files";
import { pickCarried, replyAllCopies } from "./outbound";

const bytes = (...values: (number | string)[]) =>
  new Uint8Array(
    values.flatMap((v) => (typeof v === "string" ? [...v].map((c) => c.charCodeAt(0)) : [v])),
  );
const JPEG = bytes(0xff, 0xd8, 0xff, 0xe0, "....JFIF");
const PNG = bytes(0x89, "PNG", 0x0d, 0x0a, 0x1a, 0x0a, "rest");
const PDF = bytes("%PDF-1.7 rest");
const ftyp = (brand: string) => bytes(0, 0, 0, 0x18, "ftyp", brand, 0, 0, 0, 0);
const sized = (head: Uint8Array, size: number) => {
  const out = new Uint8Array(size);
  out.set(head);
  return out;
};
const file = (name: string, claimed: string, content: Uint8Array): IncomingFile => ({
  name,
  claimed,
  bytes: content,
  contentId: null,
});

describe("what a file really is", () => {
  it("reads pictures, PDFs and video from their first bytes", () => {
    expect(sniffType(JPEG)).toBe("image/jpeg");
    expect(sniffType(PNG)).toBe("image/png");
    expect(sniffType(bytes("GIF89a...."))).toBe("image/gif");
    expect(sniffType(bytes("RIFF", 0, 0, 0, 0, "WEBPVP8 "))).toBe("image/webp");
    expect(sniffType(ftyp("heic"))).toBe("image/heic");
    expect(sniffType(ftyp("mif1"))).toBe("image/heic");
    expect(sniffType(PDF)).toBe("application/pdf");
    expect(sniffType(ftyp("isom"))).toBe("video/mp4");
    expect(sniffType(ftyp("mp42"))).toBe("video/mp4");
    expect(sniffType(ftyp("qt  "))).toBe("video/quicktime");
  });

  it("never believes the name or the type a sender claims", () => {
    const exe = bytes("MZ", 0x90, 0, 3, 0, 0, 0);
    expect(sniffType(exe, { type: "image/jpeg", name: "holiday.jpg" })).toBeNull();
    expect(sniffType(bytes("PK", 3, 4, "word/"), { type: "application/pdf" })).toBeNull();
    // A real picture is kept as what it is, whatever it was called.
    expect(sniffType(JPEG, { type: "application/x-msdownload", name: "run.exe" })).toBe(
      "image/jpeg",
    );
    expect(sniffType(ftyp("avif"))).toBeNull();
    expect(sniffType(new Uint8Array())).toBeNull();
  });

  it("keeps text and CSV only when they are plain words, and never markup", () => {
    expect(sniffType(bytes("sku,qty\nA1,2\n"), { type: "text/csv" })).toBe("text/csv");
    expect(sniffType(bytes("sku,qty\n"), { name: "Order.CSV" })).toBe("text/csv");
    expect(sniffType(bytes("hello there"), { type: "text/plain; charset=utf-8" })).toBe(
      "text/plain",
    );
    // Words with no claim to be text are not kept.
    expect(sniffType(bytes("hello there"), { type: "application/octet-stream" })).toBeNull();
    for (const sneaky of [
      "<html><body>hi</body></html>",
      "<!DOCTYPE html><p>",
      "  <svg xmlns='http://www.w3.org/2000/svg' onload='x()'>",
      "<?xml version='1.0'?><svg>",
      "hello <script>alert(1)</script>",
    ]) {
      expect(sniffType(bytes(sneaky), { type: "text/plain", name: "note.txt" })).toBeNull();
    }
    expect(sniffType(bytes("a", 0, "b"), { type: "text/plain" })).toBeNull();
    expect(sniffType(bytes(0xff, 0xfe, "x"), { type: "text/plain" })).toBeNull();
  });
});

describe("names and claims, tidied", () => {
  it("makes a name safe to show and never a path", () => {
    expect(displayName("../../etc/passwd")).toBe("passwd");
    expect(displayName("C:\\Users\\me\\IMG_0209.jpeg")).toBe("IMG_0209.jpeg");
    expect(displayName('a"b<c>.png')).toBe("a_b_c_.png");
    expect(displayName("photo\r\nSet-Cookie: x.jpg")).toBe("photoSet-Cookie_ x.jpg");
    // The mark that makes "gpj.exe" read as "exe.jpg" is dropped.
    expect(displayName("invoice\u202egpj.exe")).toBe("invoicegpj.exe");
    expect(displayName("")).toBe("file");
    expect(displayName(null)).toBe("file");
    expect(displayName("...hidden")).toBe("hidden");
    const long = displayName(`${"x".repeat(300)}.jpeg`);
    expect(long).toHaveLength(120);
    expect(long.endsWith(".jpeg")).toBe(true);
  });

  it("shows a claimed type only when it looks like one", () => {
    expect(claimedType("Application/ZIP; name=x")).toBe("application/zip");
    expect(claimedType("<script>")).toBe("unknown");
    expect(claimedType(undefined)).toBe("unknown");
  });

  it("reads a content id with or without its brackets", () => {
    expect(contentId("<image001.png@01DB>")).toBe("image001.png@01DB");
    expect(contentId("ii_abc123")).toBe("ii_abc123");
    expect(contentId("")).toBeNull();
    expect(contentId('a"b')).toBeNull();
  });

  it("decodes base64, and treats rubbish as an empty file", () => {
    expect([...fromBase64(Buffer.from("hi").toString("base64"))]).toEqual([104, 105]);
    expect(fromBase64(undefined)).toHaveLength(0);
    expect(fromBase64(42)).toHaveLength(0);
  });
});

describe("deciding what is kept", () => {
  it("keeps what it recognises under its real type, and notes the rest", () => {
    const plan = planFiles(
      [
        file("IMG_0209.jpeg", "image/jpeg", JPEG),
        file("setup.exe", "application/x-msdownload", bytes("MZ....")),
        file("page.html", "text/html", bytes("<html></html>")),
        file("logo.svg", "image/svg+xml", bytes("<svg></svg>")),
        file("macro.docm", "application/vnd.ms-word.document.macroEnabled.12", bytes("PK", 3, 4)),
      ],
      0,
    );
    expect(plan.map((f) => f.keep)).toEqual([true, false, false, false, false]);
    expect(plan[0]).toMatchObject({ type: "image/jpeg", name: "IMG_0209.jpeg" });
    expect(plan[1]).toMatchObject({
      keep: false,
      reason: "type",
      type: "application/x-msdownload",
      name: "setup.exe",
    });
    expect(plan[3]).toMatchObject({ keep: false, reason: "type" });
  });

  it("records an oversize file as not kept, with its size", () => {
    const [big] = planFiles([file("film.mov", "video/quicktime", ftyp("qt  "))], 0);
    expect(big.keep).toBe(true);
    const [tooBig] = planFiles(
      [
        {
          ...file("film.mov", "video/quicktime", new Uint8Array()),
          statedSize: MAX_FILE_BYTES + 1,
        },
      ],
      0,
    );
    expect(tooBig).toMatchObject({ keep: false, reason: "too_big", size: MAX_FILE_BYTES + 1 });
  });

  it("stops at the per-email total and the workspace's day", () => {
    const twenty = sized(JPEG, 20 * 1024 * 1024);
    const plan = planFiles(
      [file("a.jpg", "", twenty), file("b.jpg", "", twenty), file("c.png", "", PNG)],
      0,
    );
    expect(20 * 1024 * 1024 * 2).toBeGreaterThan(MAX_MESSAGE_BYTES);
    expect(plan.map((f) => (f.keep ? "kept" : f.reason))).toEqual(["kept", "message_cap", "kept"]);
    const day = planFiles([file("a.jpg", "", JPEG)], MAX_DAILY_BYTES - 3);
    expect(day[0]).toMatchObject({ keep: false, reason: "daily_cap" });
    expect(planFiles([file("a.jpg", "", JPEG)], MAX_DAILY_BYTES - JPEG.length)[0].keep).toBe(true);
  });

  it("looks at a limited number of files per email", () => {
    const many = Array.from({ length: MAX_MESSAGE_FILES + 5 }, (_, i) => file(`${i}.png`, "", PNG));
    expect(planFiles(many, 0)).toHaveLength(MAX_MESSAGE_FILES);
  });

  it("says why in plain words", () => {
    expect(notKeptWords("too_big")).toBe("too big to keep");
    expect(notKeptWords("type")).toBe("not a kind of file we keep");
    expect(notKeptWords(null)).toBe("not a kind of file we keep");
  });
});

describe("handing a file back", () => {
  it("shows pictures, PDFs and video in the page and downloads everything else", () => {
    const picture = fileHeaders({ name: "IMG_0209.jpeg", mime_type: "image/jpeg", bytes: 10 });
    expect(picture["content-type"]).toBe("image/jpeg");
    expect(picture["content-disposition"]).toMatch(/^inline; filename="IMG_0209.jpeg"/);
    expect(picture["x-content-type-options"]).toBe("nosniff");
    expect(picture["cache-control"]).toBe("private, no-store");
    expect(picture["content-security-policy"]).toContain("default-src 'none'");
    expect(picture["content-security-policy"]).toContain("sandbox");
    expect(picture["content-length"]).toBe("10");

    for (const type of ["text/plain", "text/csv", "image/heic"]) {
      expect(fileHeaders({ name: "x", mime_type: type })["content-disposition"]).toMatch(
        /^attachment;/,
      );
    }
    expect(fileHeaders({ name: "x.csv", mime_type: "text/csv" })["content-type"]).toBe(
      "text/plain; charset=utf-8",
    );
    expect(
      fileHeaders({ name: "x.pdf", mime_type: "application/pdf" })["content-security-policy"],
    ).not.toContain("sandbox");
    expect(
      fileHeaders({ name: "x.jpg", mime_type: "image/jpeg" }, { download: true })[
        "content-disposition"
      ],
    ).toMatch(/^attachment;/);
  });

  it("never serves a type it didn't choose, and keeps names out of the header's structure", () => {
    const odd = fileHeaders({ name: 'a"\r\nx: y.html', mime_type: "text/html" });
    expect(odd["content-type"]).toBe("application/octet-stream");
    expect(odd["content-disposition"]).toMatch(/^attachment;/);
    expect(odd["content-disposition"]).not.toMatch(/[\r\n]/);
    expect(odd["content-disposition"].match(/"/g)).toHaveLength(2);
    const accents = fileHeaders({ name: "café.png", mime_type: "image/png" });
    expect(accents["content-disposition"]).toContain("filename*=UTF-8''caf%C3%A9.png");
  });

  it("stores under the workspace, never under a name anyone typed", () => {
    expect(storagePath("t1", "k1", "m1", "r1")).toBe("t1/k1/m1/r1");
  });

  it("tells a prompt about files by name and kind only", () => {
    expect(filesNote([])).toBe("");
    expect(filesNote([{ name: "IMG_1.jpeg", mime_type: "image/jpeg" }])).toContain(
      "IMG_1.jpeg (image/jpeg)",
    );
  });
});

describe("reply all and forwards", () => {
  const own = { domain: "in.example.test", addresses: ["hello@studio.test"] };

  it("copies in the other people on the customer's last email, never ourselves", () => {
    expect(
      replyAllCopies(
        {
          from_email: "pat@example.test",
          to_emails: ["hello@studio.test", "Partner@Example.test", "support-wild@in.example.test"],
          cc_emails: ["pat@example.test", "accounts@example.test", "partner@example.test"],
        },
        own,
      ),
    ).toEqual(["partner@example.test", "accounts@example.test"]);
    expect(replyAllCopies(null, own)).toEqual([]);
    expect(replyAllCopies({ from_email: "pat@example.test" }, own)).toEqual([]);
  });

  it("carries a conversation's files on a forward while they fit", () => {
    const mb = 1024 * 1024;
    const { carried, left } = pickCarried(
      [
        { name: "a.jpg", size: 3 * mb },
        { name: "b.mov", size: 6 * mb },
        { name: "c.pdf", size: 2 * mb },
      ],
      2 * mb,
    );
    expect(carried.map((f) => f.name)).toEqual(["a.jpg", "c.pdf"]);
    expect(left.map((f) => f.name)).toEqual(["b.mov"]);
  });
});
