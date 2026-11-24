import { describe, expect, it } from "vitest";
import { GmailSendError } from "../../connections/providers/google-mail";
import { fingerprint, poSnapshot } from "./email";
import { SendRefused, checkSendInput, sendPoEmail, type SendDeps, type SendInput } from "./send";

const snapshot = poSnapshot({
  reference: "HI-202611-ABC123",
  supplierName: "Hill Mill Yarns",
  contactName: "Sam",
  lines: [
    {
      stockItemId: "i1",
      title: "Yarn",
      sku: "Y-1",
      supplierSku: null,
      qtyOrdered: 4,
      unitCost: "2.50",
    },
  ],
  shippingCost: "0",
  taxRatePct: "0",
  adjustments: [],
  notes: null,
  expectedOn: null,
});

const input = (over: Partial<SendInput> = {}): SendInput => ({
  requestKey: "0d5b2f4e-1c1c-4c1c-8c1c-0123456789ab",
  to: "Sam <sam@hillmill.example>, pat@hillmill.example",
  ccMe: false,
  subject: "November order – HI-202611-ABC123",
  body: "Hi Sam,\n\nPlease find attached.\n\nThanks,\nDana",
  ...over,
});

type Sent = { token: string; raw: string; threadId: string | null };

/** Fakes for everything outside, each remembering what it was asked. */
function world(
  over: Partial<SendDeps> & {
    state?: "new" | "retry" | "sent" | "busy" | "unsure";
    thread?: boolean;
  } = {},
) {
  const log = {
    begun: [] as Parameters<SendDeps["begin"]>[0][],
    sent: [] as Sent[],
    finished: [] as Parameters<SendDeps["finish"]>[0][],
    tokens: [] as boolean[],
    pdfs: 0,
  };
  const deps: SendDeps = {
    sender: { email: "dana@wildthread.example", name: "Wild Thread Studio" },
    snapshot,
    filename: "HI-202611-ABC123.pdf",
    random: "fixed",
    begin: async (args) => {
      log.begun.push(args);
      return {
        id: "email-1",
        state: over.state ?? "new",
        threadId: over.thread ? "thr-1" : null,
        replyTo: over.thread ? "<po-first@wildthread.example>" : null,
      };
    },
    renderPdf: async () => {
      log.pdfs += 1;
      return Buffer.from("%PDF-1.4 fake");
    },
    accessToken: async (fresh) => {
      log.tokens.push(fresh);
      return fresh ? "fresh-token" : "saved-token";
    },
    send: async (token, raw, threadId) => {
      log.sent.push({ token, raw, threadId });
      return { id: "msg-1", threadId: threadId ?? "thr-new" };
    },
    finish: async (args) => {
      log.finished.push(args);
      return { markedOrdered: args.outcome === "sent" };
    },
    ...over,
  };
  return { deps, log };
}
const mimeOf = (sent: Sent) => Buffer.from(sent.raw, "base64url").toString("utf8");

describe("checking what was typed", () => {
  it("reads the addresses and copies the sender only when asked", () => {
    expect(checkSendInput(input(), "Dana@WildThread.example")).toMatchObject({
      to: ["sam@hillmill.example", "pat@hillmill.example"],
      cc: [],
    });
    expect(checkSendInput(input({ ccMe: true }), "Dana@WildThread.example")).toMatchObject({
      cc: ["dana@wildthread.example"],
    });
    // Already one of the people it goes to: no second copy.
    expect(
      checkSendInput(
        input({ ccMe: true, to: "dana@wildthread.example" }),
        "dana@wildthread.example",
      ),
    ).toMatchObject({ cc: [] });
  });
  it("says what is missing or wrong", () => {
    const why = (over: Partial<SendInput>) =>
      (checkSendInput(input(over), "dana@wildthread.example") as { error: string }).error;
    expect(why({ to: "" })).toBe("Add the supplier's email address.");
    expect(why({ to: "sam@hillmill, pat" })).toBe("Not an email address: sam@hillmill, pat");
    expect(why({ subject: " \n " })).toBe("Add a subject.");
    expect(why({ body: "   " })).toBe("Add a message.");
    expect(why({ to: Array.from({ length: 11 }, (_, i) => `p${i}@x.example`).join(",") })).toMatch(
      /ten/,
    );
  });
  it("keeps line breaks out of the subject", () => {
    expect(
      checkSendInput(input({ subject: "Order\r\nBcc: x@evil.example" }), "dana@wildthread.example"),
    ).toMatchObject({ subject: "Order Bcc: x@evil.example" });
  });
});

describe("sending an order by email", () => {
  it("claims the send, sends once, and writes down Gmail's ids", async () => {
    const { deps, log } = world();
    const result = await sendPoEmail(input({ ccMe: true }), deps);
    expect(result).toEqual({
      ok: true,
      to: ["sam@hillmill.example", "pat@hillmill.example"],
      cc: ["dana@wildthread.example"],
      markedOrdered: true,
      repeated: false,
    });
    expect(log.begun).toEqual([
      {
        requestKey: "0d5b2f4e-1c1c-4c1c-8c1c-0123456789ab",
        to: ["sam@hillmill.example", "pat@hillmill.example"],
        cc: ["dana@wildthread.example"],
        subject: "November order – HI-202611-ABC123",
        senderEmail: "dana@wildthread.example",
        messageId: "<po-fixed@wildthread.example>",
        snapshot,
        fingerprint: fingerprint(snapshot),
      },
    ]);
    expect(log.sent).toHaveLength(1);
    expect(log.sent[0].token).toBe("saved-token");
    expect(log.sent[0].threadId).toBeNull();
    const mime = mimeOf(log.sent[0]);
    expect(mime).toContain('From: "Wild Thread Studio" <dana@wildthread.example>\r\n');
    expect(mime).toContain("To: sam@hillmill.example, pat@hillmill.example\r\n");
    expect(mime).toContain("Cc: dana@wildthread.example\r\n");
    expect(mime).toContain("Message-ID: <po-fixed@wildthread.example>\r\n");
    expect(mime).toContain('filename="HI-202611-ABC123.pdf"');
    expect(mime).not.toContain("In-Reply-To");
    expect(log.finished).toEqual([
      { id: "email-1", outcome: "sent", gmailMessageId: "msg-1", gmailThreadId: "thr-new" },
    ]);
    // The record never holds the token.
    expect(JSON.stringify([log.begun, log.finished])).not.toMatch(/saved-token|fresh-token/);
  });

  it("a second press of the same button sends nothing", async () => {
    const { deps, log } = world({ state: "sent" });
    expect(await sendPoEmail(input(), deps)).toMatchObject({
      ok: true,
      repeated: true,
      markedOrdered: false,
    });
    expect(log.sent).toEqual([]);
    expect(log.pdfs).toBe(0);
    expect(log.tokens).toEqual([]);
    expect(log.finished).toEqual([]);
  });

  it("sends nothing while the first press is still going, or when we can't tell how it went", async () => {
    for (const state of ["busy", "unsure"] as const) {
      const { deps, log } = world({ state });
      const result = await sendPoEmail(input(), deps);
      expect(result).toMatchObject({ ok: false, canRetry: false });
      expect(log.sent).toEqual([]);
      expect(log.finished).toEqual([]);
    }
  });

  it("checks what was typed before claiming anything", async () => {
    const { deps, log } = world();
    expect(await sendPoEmail(input({ to: "nobody" }), deps)).toEqual({
      ok: false,
      error: "Not an email address: nobody",
      canRetry: true,
    });
    expect(log.begun).toEqual([]);
  });

  it("replies in the earlier conversation when this mailbox has sent the order before", async () => {
    const { deps, log } = world({ thread: true });
    await sendPoEmail(input(), deps);
    expect(log.sent[0].threadId).toBe("thr-1");
    const mime = mimeOf(log.sent[0]);
    expect(mime).toContain("In-Reply-To: <po-first@wildthread.example>\r\n");
    expect(mime).toContain("References: <po-first@wildthread.example>\r\n");
  });

  it("starts a new conversation when Gmail can no longer find the old one", async () => {
    let calls = 0;
    const { deps, log } = world({
      thread: true,
      send: async (token, raw, threadId) => {
        calls += 1;
        log.sent.push({ token, raw, threadId });
        if (threadId) throw new GmailSendError("gone", "no", "thread");
        return { id: "msg-2", threadId: "thr-2" };
      },
    });
    expect(await sendPoEmail(input(), deps)).toMatchObject({ ok: true });
    expect(calls).toBe(2);
    expect(log.sent.map((s) => s.threadId)).toEqual(["thr-1", null]);
    expect(mimeOf(log.sent[1])).not.toContain("In-Reply-To");
    expect(log.finished).toEqual([
      { id: "email-1", outcome: "sent", gmailMessageId: "msg-2", gmailThreadId: "thr-2" },
    ]);
  });

  it("renews a sign-in Gmail turns away, once, and sends once", async () => {
    const { deps, log } = world({
      send: async (token, raw, threadId) => {
        log.sent.push({ token, raw, threadId });
        if (token === "saved-token") throw new GmailSendError("stale", "no", "stale");
        return { id: "msg-3", threadId: "thr-3" };
      },
    });
    expect(await sendPoEmail(input(), deps)).toMatchObject({ ok: true });
    expect(log.tokens).toEqual([false, true]);
    expect(log.sent.map((s) => s.token)).toEqual(["saved-token", "fresh-token"]);
    expect(log.finished.map((f) => f.outcome)).toEqual(["sent"]);
  });

  it("gives up after one renewal and asks for a reconnect", async () => {
    const { deps, log } = world({
      send: async (token, raw, threadId) => {
        log.sent.push({ token, raw, threadId });
        throw new GmailSendError("stale", "no", "stale");
      },
    });
    const result = await sendPoEmail(input(), deps);
    expect(result).toEqual({
      ok: false,
      error: "Gmail needs reconnecting, under Connections. Nothing was sent.",
      canRetry: true,
    });
    expect(log.sent).toHaveLength(2);
    expect(log.finished).toEqual([
      {
        id: "email-1",
        outcome: "failed",
        error: "Gmail needs reconnecting, under Connections. Nothing was sent.",
      },
    ]);
  });

  it("records a clean no as failed, so the same press can be tried again", async () => {
    const { deps, log } = world({
      send: async () => {
        throw new GmailSendError(
          "Gmail wouldn't send it: Invalid To header. Nothing was sent.",
          "no",
        );
      },
    });
    expect(await sendPoEmail(input(), deps)).toEqual({
      ok: false,
      error: "Gmail wouldn't send it: Invalid To header. Nothing was sent.",
      canRetry: true,
    });
    expect(log.finished.map((f) => f.outcome)).toEqual(["failed"]);

    // The retry is claimed as a retry, and goes.
    const again = world({ state: "retry" });
    expect(await sendPoEmail(input(), again.deps)).toMatchObject({ ok: true, repeated: false });
    expect(again.log.sent).toHaveLength(1);
  });

  it("records not knowing as unsure, and never tries again by itself", async () => {
    let calls = 0;
    const { deps, log } = world({
      send: async () => {
        calls += 1;
        throw new GmailSendError("We didn't hear back from Gmail.", "unsure");
      },
    });
    expect(await sendPoEmail(input(), deps)).toMatchObject({ ok: false, canRetry: false });
    expect(calls).toBe(1);
    expect(log.finished.map((f) => f.outcome)).toEqual(["unsure"]);

    // Something nobody expected is treated the same way.
    const odd = world({
      send: async () => {
        throw new TypeError("boom");
      },
    });
    expect(await sendPoEmail(input(), odd.deps)).toMatchObject({ ok: false, canRetry: false });
    expect(odd.log.finished.map((f) => f.outcome)).toEqual(["unsure"]);
  });

  it("sends nothing when the PDF can't be drawn or Gmail isn't connected", async () => {
    const noPdf = world({
      renderPdf: async () => {
        throw new Error("font missing");
      },
    });
    expect(await sendPoEmail(input(), noPdf.deps)).toMatchObject({ ok: false, canRetry: true });
    expect(noPdf.log.sent).toEqual([]);
    expect(noPdf.log.finished.map((f) => f.outcome)).toEqual(["failed"]);

    const noMail = world({
      accessToken: async () => {
        throw new SendRefused("Connect Gmail under Connections first.");
      },
    });
    expect(await sendPoEmail(input(), noMail.deps)).toEqual({
      ok: false,
      error: "Connect Gmail under Connections first.",
      canRetry: true,
    });
    expect(noMail.log.sent).toEqual([]);
  });

  it("passes on the database's own refusal in its words", async () => {
    const { deps, log } = world({
      begin: async () => {
        throw new SendRefused("This order was cancelled, so it can't be emailed.");
      },
    });
    expect(await sendPoEmail(input(), deps)).toEqual({
      ok: false,
      error: "This order was cancelled, so it can't be emailed.",
      canRetry: true,
    });
    expect(log.sent).toEqual([]);
  });

  it("never invites a second send when the email went but the note of it didn't", async () => {
    const { deps, log } = world({
      finish: async () => {
        throw new Error("database away");
      },
    });
    const result = await sendPoEmail(input(), deps);
    expect(result).toMatchObject({ ok: false, canRetry: false });
    expect((result as { error: string }).error).toMatch(/was sent/);
    expect(log.sent).toHaveLength(1);
  });
});
