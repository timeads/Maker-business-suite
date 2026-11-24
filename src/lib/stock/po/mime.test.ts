import { describe, expect, it } from "vitest";
import { buildMime, encodeHeader, newMessageId, parseRecipients, toRaw } from "./mime";

const pdf = Buffer.from("%PDF-1.4 fake pdf bytes");

describe("buildMime", () => {
  const mime = buildMime({
    from: { name: "Dana Reyes", email: "dana@wildthread.example" },
    to: ["orders@hillmill.example", "accounts@hillmill.example"],
    subject: "November order – HI-202611-ABC123",
    text: "Hi Sam,\n\nPlease find attached purchase order HI-202611-ABC123.\n\nThanks,\nDana",
    attachment: { filename: "HI-202611-ABC123.pdf", contentType: "application/pdf", content: pdf },
    messageId: "<po-1@wildthread.example>",
    boundary: "BOUNDARY",
  });

  it("has the headers Gmail needs, CRLF line endings", () => {
    expect(mime).toContain('From: "Dana Reyes" <dana@wildthread.example>\r\n');
    expect(mime).toContain("To: orders@hillmill.example, accounts@hillmill.example\r\n");
    expect(mime).toContain("Message-ID: <po-1@wildthread.example>\r\n");
    expect(mime).toContain('Content-Type: multipart/mixed; boundary="BOUNDARY"');
    expect(mime).not.toContain("In-Reply-To");
    expect(mime).not.toContain("Cc:");
    expect(mime.replace(/\r\n/g, "")).not.toContain("\n");
  });

  it("encodes a subject with a non-ASCII dash as UTF-8 encoded-words", () => {
    const subject = mime.split("\r\n").find((l) => l.startsWith("Subject:"))!;
    expect(subject).toMatch(/^Subject: =\?UTF-8\?B\?/);
    const words = mime
      .match(/=\?UTF-8\?B\?([^?]+)\?=/g)!
      .map((w) => Buffer.from(w.slice(10, -2), "base64").toString("utf8"));
    expect(words.join("")).toBe("November order – HI-202611-ABC123");
  });

  it("carries the message and the PDF, both base64", () => {
    const parts = mime.split("--BOUNDARY");
    expect(parts).toHaveLength(4); // headers, text, pdf, closing "--"
    const textB64 = parts[1]!.split("\r\n\r\n")[1]!.replace(/\r\n/g, "");
    expect(Buffer.from(textB64, "base64").toString("utf8")).toBe(
      "Hi Sam,\r\n\r\nPlease find attached purchase order HI-202611-ABC123.\r\n\r\nThanks,\r\nDana",
    );
    expect(parts[2]).toContain('Content-Disposition: attachment; filename="HI-202611-ABC123.pdf"');
    const pdfB64 = parts[2]!.split("\r\n\r\n")[1]!.replace(/\r\n/g, "");
    expect(Buffer.from(pdfB64, "base64").equals(pdf)).toBe(true);
    expect(mime.endsWith("--BOUNDARY--\r\n")).toBe(true);
  });

  it("a resend replies to the first send, and can copy the sender in", () => {
    const re = buildMime({
      from: { email: "dana@wildthread.example" },
      to: ["orders@hillmill.example"],
      cc: ["dana@wildthread.example"],
      subject: "Re: November order",
      text: "Updated",
      attachment: { filename: "x.pdf", contentType: "application/pdf", content: pdf },
      messageId: "<po-2@wildthread.example>",
      inReplyTo: "<po-1@wildthread.example>",
    });
    expect(re).toContain("From: dana@wildthread.example\r\n");
    expect(re).toContain("Cc: dana@wildthread.example\r\n");
    expect(re).toContain("In-Reply-To: <po-1@wildthread.example>\r\n");
    expect(re).toContain("References: <po-1@wildthread.example>\r\n");
  });

  it("wraps base64 at 76 characters", () => {
    const big = buildMime({
      from: { email: "a@b.example" },
      to: ["c@d.example"],
      subject: "s",
      text: "x".repeat(500),
      attachment: {
        filename: "x.pdf",
        contentType: "application/pdf",
        content: Buffer.alloc(3000, 7),
      },
      messageId: "<m@b.example>",
    });
    expect(Math.max(...big.split("\r\n").map((l) => l.length))).toBeLessThanOrEqual(76);
  });

  it("toRaw is base64url (no + / =)", () => {
    expect(toRaw(mime)).not.toMatch(/[+/=]/);
    expect(Buffer.from(toRaw(mime), "base64url").toString("utf8")).toBe(mime);
  });

  it("encodes a sender's name that isn't plain ASCII", () => {
    const named = buildMime({
      from: { name: "王小明", email: "wang@studio.example" },
      to: ["c@d.example"],
      subject: "订单 HI-1",
      text: "你好",
      attachment: { filename: "订单.pdf", contentType: "application/pdf", content: pdf },
      messageId: "<m@studio.example>",
      boundary: "B",
    });
    const from = named.split("\r\n").find((l) => l.startsWith("From:"))!;
    expect(from).toBe(
      `From: =?UTF-8?B?${Buffer.from("王小明").toString("base64")}?= <wang@studio.example>`,
    );
    // The attachment's name is kept to characters every mail program reads.
    expect(named).toContain('filename="__.pdf"');
    expect(named.split("\r\n\r\n")[0]).toMatch(/^[\x00-\x7f]*$/);
  });

  it("never lets a typed value start a header of its own", () => {
    const sly = buildMime({
      from: { name: "Dana\r\nBcc: everyone@evil.example", email: "dana@wildthread.example" },
      to: ["orders@hillmill.example\r\nBcc: more@evil.example"],
      cc: ["x@y.example>\r\nBcc: z@evil.example"],
      subject: "Order\r\nBcc: other@evil.example",
      text: "Hello",
      attachment: {
        filename: 'a"\r\nBcc: f@evil.example.pdf',
        contentType: "application/pdf",
        content: pdf,
      },
      messageId: "<m@wildthread.example>\r\nBcc: id@evil.example",
      inReplyTo: "<n@wildthread.example>\r\nBcc: re@evil.example",
      boundary: "B",
    });
    const head = sly.split("\r\n\r\n")[0];
    expect(head.split("\r\n").filter((line) => /^bcc:/i.test(line))).toEqual([]);
    expect(sly.split("\r\n").filter((line) => /^bcc:/i.test(line))).toEqual([]);
  });
});

describe("helpers", () => {
  it("leaves plain ASCII headers alone", () => {
    expect(encodeHeader("Purchase order HI-1")).toBe("Purchase order HI-1");
  });
  it("splits a long non-ASCII header without cutting a character in half", () => {
    const long = "订单".repeat(40);
    const words = encodeHeader(long)
      .split("\r\n ")
      .map((w) => Buffer.from(w.slice(10, -2), "base64").toString("utf8"));
    expect(words.length).toBeGreaterThan(1);
    expect(words.join("")).toBe(long);
    expect(words.every((w) => !w.includes("\uFFFD"))).toBe(true);
  });
  it("makes a Message-ID on the sender's domain", () => {
    expect(newMessageId("dana@wildthread.example", "abc")).toBe("<po-abc@wildthread.example>");
    expect(newMessageId("odd", "a b<c>")).toBe("<po-abc@mail.invalid>");
  });
  it("reads a list of recipients, with names, and flags bad ones", () => {
    expect(
      parseRecipients(
        "orders@hillmill.example, Sam <sam@hillmill.example>; ORDERS@hillmill.example",
      ),
    ).toEqual({
      ok: ["orders@hillmill.example", "sam@hillmill.example"],
      bad: [],
    });
    expect(parseRecipients("sam@hillmill, ,pat@wildthread.example").bad).toEqual(["sam@hillmill"]);
  });
});
