import { describe, expect, it } from "vitest";
import { describeActions, mergeActions, replyTemplatesSchema } from "./config";
import {
  bodyOf,
  outboxWords,
  outgoingFrom,
  refusalCode,
  secondsLeft,
  sendPayloadSchema,
  summaryOf,
} from "./outbox";
import { buildOutboundRequest } from "./outbound";
import { ReplyRefused } from "./reply";
import { DEFAULT_DESK_SETTINGS, deskSettingsSchema, parseDeskSettings } from "./settings";

const doc = [{ t: "p" as const, runs: [{ text: "On its way today." }] }];
const payload = (over: object = {}) =>
  sendPayloadSchema.parse({
    kind: "reply",
    to: ["pat@example.test"],
    doc,
    then: "closed",
    ...over,
  });

describe("email waiting to go", () => {
  it("checks what is queued and fills in what was left out", () => {
    expect(payload()).toMatchObject({ cc: [], bcc: [], files: [], add_tags: [], assign_to: null });
    expect(
      sendPayloadSchema.safeParse({ kind: "reply", to: [], doc, then: "closed" }).success,
    ).toBe(false);
    expect(
      sendPayloadSchema.safeParse({ kind: "reply", to: ["a@b.test"], doc: "<p>hi</p>", then: "x" })
        .success,
    ).toBe(false);
    expect(sendPayloadSchema.safeParse({ ...payload(), add_tags: ["<script>"] }).success).toBe(
      false,
    );
  });

  it("shows a few words while it waits, never its files", () => {
    const summary = summaryOf(
      payload({ files: [{ name: "a.png", type: "image/png", size: 1, base64: "eA==" }] }),
    );
    expect(summary).toEqual({
      kind: "reply",
      to: ["pat@example.test"],
      preview: "On its way today.",
    });
    expect(JSON.stringify(summary)).not.toContain("eA==");
  });

  it("becomes the same mail request a send at once would make", () => {
    const where = {
      workspaceName: "Wild Thread",
      slug: "wild-thread",
      domain: "in.example.test",
      replyKey: "0123456789abcdef",
      subject: "Where is it?",
      inReplyTo: "<m1@mail.example.test>",
    };
    const request = buildOutboundRequest(outgoingFrom(payload({ cc: ["x@example.test"] }), where));
    expect(request).toMatchObject({
      To: "pat@example.test",
      Cc: "x@example.test",
      Subject: "Re: Where is it?",
      TextBody: "On its way today.",
    });
    expect(bodyOf(payload())).toBe("On its way today.");
    expect(bodyOf(payload({ kind: "forward", doc: [], appendix: "old words" }))).toBe(
      "(forwarded)",
    );
  });

  it("says in words what is waiting and what went wrong", () => {
    const summary = { kind: "reply", to: ["pat@example.test"] };
    expect(outboxWords({ state: "waiting", error: null, summary })).toBe(
      "An email to pat@example.test is about to go.",
    );
    expect(
      outboxWords({ state: "sending", error: null, summary: { kind: "forward", to: [] } }),
    ).toBe("A forward to the customer is going out now.");
    expect(
      outboxWords({ state: "failed", error: refusalCode(new ReplyRefused(422, 406)), summary }),
    ).toContain("bounced or complained");
    expect(outboxWords({ state: "failed", error: "author_left", summary })).toContain(
      "has left the workspace",
    );
    expect(outboxWords({ state: "unsure", error: "never_finished", summary })).toContain(
      "never heard",
    );
    expect(outboxWords({ state: "unsure", error: "sent_not_filed", summary })).toContain(
      "went out",
    );
    expect(refusalCode(new ReplyRefused(500, null))).toBe("postmark:500:none");
  });

  it("counts the seconds left, never below zero", () => {
    const now = Date.parse("2026-11-25T12:00:00Z");
    expect(secondsLeft("2026-11-25T12:00:04.200Z", now)).toBe(5);
    expect(secondsLeft("2026-11-25T11:59:00Z", now)).toBe(0);
  });
});

describe("what a saved reply also does when sent", () => {
  it("is optional, and checked when present", () => {
    const base = { id: "a", name: "Refund", body: "Hi" };
    expect(replyTemplatesSchema.safeParse({ version: 1, templates: [base] }).success).toBe(true);
    const withActions = replyTemplatesSchema.parse({
      version: 1,
      templates: [
        { ...base, actions: { add_tags: ["Refund "], then: "closed", assign_to: "sender" } },
      ],
    });
    expect(withActions.templates[0].actions).toEqual({
      add_tags: ["refund"],
      then: "closed",
      assign_to: "sender",
    });
    expect(
      replyTemplatesSchema.safeParse({
        version: 1,
        templates: [{ ...base, actions: { then: "deleted" } }],
      }).success,
    ).toBe(false);
  });

  it("two saved replies in one email add up", () => {
    const merged = mergeActions(
      { add_tags: ["refund"], then: "pending" },
      { add_tags: ["refund", "vip"], then: "closed", assign_to: "sender" },
    );
    expect(merged).toEqual({ add_tags: ["refund", "vip"], then: "closed", assign_to: "sender" });
    expect(mergeActions({ add_tags: ["a"] }, undefined)).toEqual({ add_tags: ["a"] });
    expect(mergeActions({}, {})).toEqual({});
  });

  it("is said in a few words", () => {
    expect(
      describeActions(
        { add_tags: ["refund"], then: "closed", assign_to: "sender" },
        () => "Amy",
      ).map((a) => a.label),
    ).toEqual(["tag refund", "close", "assign to whoever sends"]);
    expect(
      describeActions({ assign_to: "11111111-1111-4111-8111-111111111111" }, () => "Amy")[0].label,
    ).toBe("assign to Amy");
    expect(describeActions({}, () => "")).toEqual([]);
  });
});

describe("how the desk behaves", () => {
  it("has sensible defaults and refuses odd values", () => {
    expect(parseDeskSettings(null)).toEqual(DEFAULT_DESK_SETTINGS);
    expect(parseDeskSettings({ version: 1 })).toEqual(DEFAULT_DESK_SETTINGS);
    expect(deskSettingsSchema.safeParse({ version: 1, undo_seconds: 7 }).success).toBe(false);
    expect(deskSettingsSchema.safeParse({ version: 1, after_close: "elsewhere" }).success).toBe(
      false,
    );
    expect(
      deskSettingsSchema.parse({ version: 1, own_addresses: [" Hello@Studio.test "] })
        .own_addresses,
    ).toEqual(["hello@studio.test"]);
    expect(deskSettingsSchema.safeParse({ version: 1, own_addresses: ["nope"] }).success).toBe(
      false,
    );
  });
});
