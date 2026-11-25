import { describe, expect, it } from "vitest";
import {
  chooseBody,
  htmlToText,
  inboundFiles,
  parseInboundEmail,
  processInboundEmail,
  type IngestResult,
  type PostmarkInbound,
} from "./inbound";
import { DEFAULT_RULES } from "./config";
import { placeInline, signatureStart, splitQuote } from "./thread";

const DOMAIN = "in.example.test";
const mail = (over: Partial<PostmarkInbound> = {}): PostmarkInbound => ({
  MessageID: "pm-100",
  From: "pat@example.test",
  FromFull: { Email: "Pat@Example.test", Name: "Pat Maker" },
  ToFull: [{ Email: `support-wild-thread@${DOMAIN}` }],
  OriginalRecipient: `support-wild-thread@${DOMAIN}`,
  Subject: "A question",
  TextBody: "Hello",
  Headers: [{ Name: "Message-ID", Value: "<m1@mail.example.test>" }],
  ...over,
});

// All four emails below are made up.
describe("the words of an incoming email", () => {
  it("a short message above a signature keeps the message", () => {
    const text = "Can you ship to Canada?\n\n-- \nPat Maker\nMaker & Co.\n555-0100";
    // The mail service's own guess at "just the reply" can come back as the signature alone.
    const body = chooseBody({
      TextBody: text,
      StrippedTextReply: "Pat Maker\nMaker & Co.\n555-0100",
    });
    expect(body).toBe(text);
    const shown = splitQuote(body);
    expect(shown.quoted).toBeNull();
    expect(shown.own.startsWith("Can you ship to Canada?")).toBe(true);
    expect(signatureStart(body)).toBe(body.indexOf("-- \n"));
  });

  it("an HTML-only email becomes readable plain text", () => {
    const html = `<html><head><style>p{color:red}</style><title>x</title></head><body>
      <div>Hi there,</div><div><br></div>
      <p>My <b>tufting gun</b> jams &amp; won&#39;t feed &mdash; see <a href="https://example.test/video">this video</a>.</p>
      <ul><li>Model: AK-I</li><li>Bought&nbsp;in May</li></ul>
      <script>alert(1)</script>
      <blockquote>Earlier: thanks for your order</blockquote>
      <p>Thanks,<br>Pat</p></body></html>`;
    const body = chooseBody({ TextBody: "  ", HtmlBody: html });
    expect(body).toBe(
      [
        "Hi there,",
        "",
        "My tufting gun jams & won't feed — see this video (https://example.test/video).",
        "",
        "- Model: AK-I",
        "- Bought in May",
        "",
        "> Earlier: thanks for your order",
        "",
        "Thanks,",
        "Pat",
      ].join("\n"),
    );
    expect(body).not.toMatch(/[<>]\w|alert|color:red/);
  });

  it("a reply with quoted history keeps its own words on top and folds the rest", () => {
    const text =
      "Yes please, the blue one.\n\nOn Mon, 3 Nov 2026 at 10:02, Wild Thread <support@x.test>\nwrote:\n> Which colour would you like?\n> We have blue and green.\n";
    const body = chooseBody({ TextBody: text, StrippedTextReply: "Yes please, the blue one." });
    const shown = splitQuote(body);
    expect(shown.own).toBe("Yes please, the blue one.");
    expect(shown.quoted).toContain("Which colour would you like?");
  });

  it("a forward with only a signature above it is shown whole, never as just the signature", () => {
    const text =
      "-- \nPat Maker\nMaker & Co.\n\n---------- Forwarded message ---------\nFrom: Sam <sam@example.test>\nDate: Mon, 3 Nov 2026\nSubject: Rug\n\nThe rug arrived torn. What now?";
    const shown = splitQuote(chooseBody({ TextBody: text, StrippedTextReply: "Pat Maker" }));
    expect(shown.quoted).toBeNull();
    expect(shown.own).toContain("The rug arrived torn. What now?");
    // With no signature at all, the forward header alone isn't "their own words" either.
    const bare = splitQuote(
      "---------- Forwarded message ---------\nFrom: Sam <sam@example.test>\nDate: Mon\n\nTorn rug.",
    );
    expect(bare.quoted).toBeNull();
  });

  it("an empty body with only an attachment is filed, with its file", async () => {
    const payload = mail({
      TextBody: "",
      HtmlBody: "",
      StrippedTextReply: "",
      Attachments: [
        {
          Name: "IMG_0001.jpeg",
          Content: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]).toString("base64"),
          ContentType: "image/jpeg",
          ContentLength: 7,
        },
      ],
    });
    expect(parseInboundEmail(payload, DOMAIN)?.body).toBe("");
    const kept: number[] = [];
    const result = await processInboundEmail(payload, DOMAIN, {
      rulesFor: async () => DEFAULT_RULES,
      ingest: async (): Promise<IngestResult> => ({
        result: "created",
        tenant_id: "t",
        ticket_id: "k",
        message_id: "m",
        number: 1,
      }),
      keepFiles: async (_result, files) => {
        kept.push(files.length, files[0].bytes.length);
      },
    });
    expect(result).toBe("created");
    expect(kept).toEqual([1, 7]);
  });

  it("falls back to the service's stripped reply only when there is nothing else", () => {
    expect(chooseBody({ StrippedTextReply: "Just this" })).toBe("Just this");
    expect(chooseBody({})).toBe("");
  });

  it("leaves no markup behind, even when it is disguised", () => {
    expect(htmlToText("<p>a &lt;script&gt;x&lt;/script&gt; b</p>")).toBe("a <script>x</script> b");
    expect(htmlToText("<div>one</div><!-- <p>hidden</p> --><div>two</div>")).toBe("one\ntwo");
    expect(htmlToText('<p>See</p><img src="cid:img1@x" alt="p"><p>above</p>')).toBe(
      "See\n\n[cid:img1@x]\n\nabove",
    );
    expect(htmlToText("&#128512;&#x41;&#99999999;")).toBe("😀A&#99999999;");
  });
});

describe("who else an email was written to", () => {
  it("keeps To and Cc, without the sender or any address of ours", () => {
    const email = parseInboundEmail(
      mail({
        ToFull: [
          { Email: "Hello@Studio.test" },
          { Email: `support-wild-thread@${DOMAIN}` },
          { Email: "pat@example.test" },
        ],
        CcFull: [{ Email: "partner@example.test" }, { Email: "hello@studio.test" }, { Email: "x" }],
      }),
      DOMAIN,
    );
    expect(email?.to).toEqual(["hello@studio.test"]);
    expect(email?.cc).toEqual(["partner@example.test"]);
  });
});

describe("an email's files", () => {
  it("decodes what was attached and remembers which picture is which", () => {
    const files = inboundFiles({
      Attachments: [
        {
          Name: "image001.png",
          Content: Buffer.from("x").toString("base64"),
          ContentType: "image/png",
          ContentID: "<image001.png@01DB>",
          ContentLength: 1,
        },
        { Name: "big.mov", ContentType: "video/quicktime", ContentLength: 99 },
      ],
    });
    expect(files[0]).toMatchObject({ name: "image001.png", contentId: "image001.png@01DB" });
    expect(files[0].bytes).toHaveLength(1);
    expect(files[1]).toMatchObject({ statedSize: 99, contentId: null });
    expect(inboundFiles({})).toEqual([]);
  });

  it("finishes the files of an email it has seen before, without filing it twice", async () => {
    const calls: string[] = [];
    const payload = mail({
      Attachments: [{ Name: "a.png", Content: "eA==", ContentType: "image/png" }],
    });
    const result = await processInboundEmail(payload, DOMAIN, {
      rulesFor: async () => DEFAULT_RULES,
      ingest: async () => ({
        result: "duplicate",
        tenant_id: "t",
        ticket_id: "k",
        message_id: "m",
      }),
      onCreated: async () => {
        calls.push("created");
      },
      keepFiles: async () => {
        calls.push("files");
      },
    });
    expect(result).toBe("duplicate");
    expect(calls).toEqual(["files"]);
  });
});

describe("pictures set into an email", () => {
  const pictures = [
    { id: "p1", contentId: "image001.png@01DB", name: "image001.png" },
    { id: "p2", contentId: null, name: "Screenshot.png" },
  ];

  it("puts each where the email's text marks it", () => {
    const { pieces, placed } = placeInline(
      "Here is the fault:\n[cid:image001.png@01DB]\nand the box:\n[image: Screenshot.png]\nThanks",
      pictures,
    );
    expect(pieces).toEqual([
      { kind: "text", text: "Here is the fault:" },
      { kind: "image", id: "p1" },
      { kind: "text", text: "and the box:" },
      { kind: "image", id: "p2" },
      { kind: "text", text: "Thanks" },
    ]);
    expect([...placed]).toEqual(["p1", "p2"]);
  });

  it("leaves marks it can't match as the words they are", () => {
    const { pieces, placed } = placeInline("See [cid:other@x] and [image: nope.png]", pictures);
    expect(pieces).toEqual([{ kind: "text", text: "See [cid:other@x] and [image: nope.png]" }]);
    expect(placed.size).toBe(0);
    expect(placeInline("", pictures).pieces).toEqual([]);
  });
});
