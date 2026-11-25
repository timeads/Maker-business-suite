import { describe, expect, it } from "vitest";
import {
  DEFAULT_AUTO_REPLIES,
  autoRepliesSchema,
  messagesNeeded,
  parseAutoReplies,
  type AutoReplies,
} from "./config";
import {
  NAME_FALLBACK,
  STALE_AFTER_MS,
  channelProblem,
  fillWords,
  firstNameOf,
  isOpenAt,
  isOwnAddress,
  looksAutomated,
  shouldAutoReply,
  unknownPlaceholders,
  variantAt,
  type AutoReplyFacts,
} from "./rules";

const NY = "America/New_York";
const at = (iso: string) => Date.parse(iso);
const HOUR = 60 * 60 * 1000;

const weekdays9to5 = DEFAULT_AUTO_REPLIES.hours;
const settings = (over: Partial<AutoReplies> = {}): AutoReplies =>
  autoRepliesSchema.parse({
    version: 1,
    instagram: { on: true, message: "Hi {{first_name}}, thanks for writing to {{business_name}}." },
    facebook: {
      on: true,
      when: "outside_hours",
      away_message: "We're closed just now and will answer when we open.",
    },
    email: {
      on: true,
      when: "both",
      message: "Got it. We'll answer today.",
      away_message: "Got it. We're closed and will answer when we open.",
    },
    ...over,
  });

// A Wednesday afternoon in New York (10:00 there in winter is 15:00 UTC).
const OPEN = at("2026-11-25T15:00:00Z");
// The same Wednesday, eleven at night there.
const CLOSED = at("2026-11-26T04:00:00Z");

const facts = (over: Partial<AutoReplyFacts> = {}): AutoReplyFacts => ({
  channel: "instagram",
  ticketKind: "message",
  direction: "inbound",
  messageKind: "reply",
  removed: false,
  shelf: null,
  receivedAt: OPEN,
  now: OPEN + 2000,
  lastAutoReplyAt: null,
  teamAnsweredSince: false,
  standby: false,
  takeControl: false,
  automatedMail: false,
  fromOwnAddress: false,
  timeZone: NY,
  businessName: "A Made Up Studio",
  contactName: "Sam Example",
  ...over,
});
const reason = (s: AutoReplies, f: AutoReplyFacts) => {
  const decision = shouldAutoReply(s, f);
  return decision.send ? `send ${decision.variant}` : decision.reason;
};

describe("the settings", () => {
  it("send nothing until someone switches a channel on", () => {
    expect(DEFAULT_AUTO_REPLIES.instagram.on).toBe(false);
    expect(DEFAULT_AUTO_REPLIES.facebook.on).toBe(false);
    expect(DEFAULT_AUTO_REPLIES.email.on).toBe(false);
    expect(DEFAULT_AUTO_REPLIES.quiet_hours).toBe(24);
    expect(parseAutoReplies(null)).toEqual(DEFAULT_AUTO_REPLIES);
    expect(parseAutoReplies({ version: 1 })).toEqual(DEFAULT_AUTO_REPLIES);
    // Something unreadable is the same as nothing: everything off.
    expect(parseAutoReplies({ version: 1, instagram: { on: "yes" } })).toEqual(
      DEFAULT_AUTO_REPLIES,
    );
    for (const channel of ["instagram", "facebook", "email"] as const) {
      expect(reason(DEFAULT_AUTO_REPLIES, facts({ channel }))).toBe("off");
    }
  });

  it("keep the quiet period, the hours and the words within bounds", () => {
    const bad = (body: Record<string, unknown>) =>
      autoRepliesSchema.safeParse({ version: 1, ...body }).success;
    expect(bad({ quiet_hours: 0 })).toBe(false);
    expect(bad({ quiet_hours: 169 })).toBe(false);
    expect(bad({ quiet_hours: 1 })).toBe(true);
    expect(bad({ hours: [{ weekday: 7, start_minute: 0, end_minute: 60 }] })).toBe(false);
    expect(bad({ hours: [{ weekday: 1, start_minute: 600, end_minute: 600 }] })).toBe(false);
    expect(bad({ hours: [] })).toBe(true);
    expect(bad({ instagram: { on: true, message: "x".repeat(801) } })).toBe(false);
    expect(bad({ instagram: { on: true, message: "bell\u0007" } })).toBe(false);
    expect(bad({ instagram: { on: true, message: "two\nlines" } })).toBe(true);
    expect(bad({ instagram: { on: true, when: "sometimes" } })).toBe(false);
  });

  it("say which messages a choice of 'when' needs", () => {
    expect(messagesNeeded("always")).toEqual({ message: true, away: false });
    expect(messagesNeeded("outside_hours")).toEqual({ message: false, away: true });
    expect(messagesNeeded("both")).toEqual({ message: true, away: true });
    const channel = settings().instagram;
    expect(channelProblem("Instagram", { ...channel, on: false, message: "" })).toBeNull();
    expect(channelProblem("Instagram", { ...channel, message: "  " })).toMatch(/write the message/);
    expect(channelProblem("Instagram", { ...channel, when: "both", away_message: "" })).toMatch(
      /away message/,
    );
    expect(channelProblem("Instagram", { ...channel, when: "outside_hours", message: "" })).toMatch(
      /away message/,
    );
    expect(channelProblem("Instagram", channel)).toBeNull();
  });
});

describe("the words", () => {
  it("fill in only the two placeholders, and leave anything else as typed", () => {
    const who = { firstName: "Sam Example", businessName: "A Made Up Studio" };
    expect(fillWords("Hi {{first_name}}, this is {{ business_name }}.", who)).toBe(
      "Hi Sam, this is A Made Up Studio.",
    );
    expect(fillWords("Hi {{FIRST_NAME}}!", who)).toBe("Hi Sam!");
    expect(fillWords("Order {{order_number}} for {{first_name}}", who)).toBe(
      "Order {{order_number}} for Sam",
    );
    expect(unknownPlaceholders("{{order_number}} {{first_name}} {{ agent }}")).toEqual([
      "{{order_number}}",
      "{{ agent }}",
    ]);
    expect(unknownPlaceholders("Hi {{first_name}} from {{business_name}}")).toEqual([]);
    expect(fillWords("  line one\r\nline two  ", who)).toBe("line one\nline two");
  });

  it("say 'there' when no first name is known, or the name isn't a name", () => {
    const hi = (firstName: string | null) =>
      fillWords("Hi {{first_name}}", { firstName, businessName: "B" });
    expect(hi(null)).toBe(`Hi ${NAME_FALLBACK}`);
    expect(hi("")).toBe("Hi there");
    expect(hi("Facebook user")).toBe("Hi there");
    expect(hi("@a_made_up_handle")).toBe("Hi there");
    expect(hi("someone@example.test")).toBe("Hi there");
    expect(hi("https://example.test/win a prize")).toBe("Hi there");
    expect(hi("X")).toBe("Hi there");
    expect(hi("Zoë O'Neil-Smith")).toBe("Hi Zoë");
    expect(hi("  María José ")).toBe("Hi María");
    expect(firstNameOf("李 雷")).toBeNull(); // one character: not enough to greet by
    expect(firstNameOf("Jean-Luc Example")).toBe("Jean-Luc");
  });

  it("never fill a placeholder that arrived inside a name", () => {
    // A value is put in once and not looked at again.
    expect(
      fillWords("Hi {{first_name}} from {{business_name}}", {
        firstName: "Sam",
        businessName: "{{first_name}} & Co\nLtd",
      }),
    ).toBe("Hi Sam from first_name & Co Ltd");
  });
});

describe("opening hours", () => {
  it("follow the workspace's own clocks", () => {
    expect(isOpenAt(weekdays9to5, at("2026-11-25T14:00:00Z"), NY)).toBe(true); // Wed 09:00
    expect(isOpenAt(weekdays9to5, at("2026-11-25T13:59:00Z"), NY)).toBe(false); // Wed 08:59
    expect(isOpenAt(weekdays9to5, at("2026-11-25T21:59:00Z"), NY)).toBe(true); // Wed 16:59
    expect(isOpenAt(weekdays9to5, at("2026-11-25T22:00:00Z"), NY)).toBe(false); // Wed 17:00
    expect(isOpenAt(weekdays9to5, at("2026-11-28T15:00:00Z"), NY)).toBe(false); // Saturday
    // Monday morning in Auckland is still Sunday in UTC.
    expect(isOpenAt(weekdays9to5, at("2026-11-29T21:00:00Z"), "Pacific/Auckland")).toBe(true);
    expect(isOpenAt(weekdays9to5, at("2026-11-29T21:00:00Z"), NY)).toBe(false);
    expect(isOpenAt([], OPEN, NY)).toBe(false);
  });

  it("stay on the clock when it changes for daylight saving", () => {
    // New York, Monday 9 March 2026, the day after clocks went forward:
    // 09:00 there is 13:00 UTC, an hour earlier than the Friday before.
    expect(isOpenAt(weekdays9to5, at("2026-03-06T13:30:00Z"), NY)).toBe(false); // Fri 08:30 EST
    expect(isOpenAt(weekdays9to5, at("2026-03-06T14:00:00Z"), NY)).toBe(true); // Fri 09:00 EST
    expect(isOpenAt(weekdays9to5, at("2026-03-09T13:00:00Z"), NY)).toBe(true); // Mon 09:00 EDT
    expect(isOpenAt(weekdays9to5, at("2026-03-09T12:59:00Z"), NY)).toBe(false);
    expect(isOpenAt(weekdays9to5, at("2026-03-09T20:59:00Z"), NY)).toBe(true); // Mon 16:59 EDT
    expect(isOpenAt(weekdays9to5, at("2026-03-09T21:00:00Z"), NY)).toBe(false); // Mon 17:00 EDT
    // And back again in the autumn: Monday 2 November 2026.
    expect(isOpenAt(weekdays9to5, at("2026-10-30T13:00:00Z"), NY)).toBe(true); // Fri 09:00 EDT
    expect(isOpenAt(weekdays9to5, at("2026-11-02T13:00:00Z"), NY)).toBe(false); // Mon 08:00 EST
    expect(isOpenAt(weekdays9to5, at("2026-11-02T14:00:00Z"), NY)).toBe(true); // Mon 09:00 EST
  });

  it("handle the night the clocks change itself", () => {
    // A shop open Sunday 01:00 to 03:00, New York.
    const night = [{ weekday: 0, start_minute: 60, end_minute: 180 }];
    // 8 March 2026: 02:00 to 03:00 never happens. 01:59 EST is 06:59 UTC; a minute later it is 03:00 EDT.
    expect(isOpenAt(night, at("2026-03-08T06:59:00Z"), NY)).toBe(true);
    expect(isOpenAt(night, at("2026-03-08T07:00:00Z"), NY)).toBe(false);
    // 1 November 2026: 01:00 to 02:00 happens twice (05:00 and 06:00 UTC), and both count.
    expect(isOpenAt(night, at("2026-11-01T05:30:00Z"), NY)).toBe(true);
    expect(isOpenAt(night, at("2026-11-01T06:30:00Z"), NY)).toBe(true);
    expect(isOpenAt(night, at("2026-11-01T07:30:00Z"), NY)).toBe(true); // 02:30 EST
    expect(isOpenAt(night, at("2026-11-01T08:00:00Z"), NY)).toBe(false); // 03:00 EST
    // A timezone nobody can read: open, so nobody is wrongly told "we're closed".
    expect(isOpenAt(weekdays9to5, CLOSED, "Not/AZone")).toBe(true);
  });

  it("pick the usual message, the away message, or neither", () => {
    const s = settings();
    expect(variantAt(s.instagram, s.hours, OPEN, NY)).toBe("usual");
    expect(variantAt(s.instagram, s.hours, CLOSED, NY)).toBe("usual");
    expect(variantAt(s.facebook, s.hours, OPEN, NY)).toBeNull();
    expect(variantAt(s.facebook, s.hours, CLOSED, NY)).toBe("away");
    expect(variantAt(s.email, s.hours, OPEN, NY)).toBe("usual");
    expect(variantAt(s.email, s.hours, CLOSED, NY)).toBe("away");
  });
});

describe("shouldAutoReply", () => {
  it("answers a real message with the saved words", () => {
    expect(shouldAutoReply(settings(), facts())).toEqual({
      send: true,
      variant: "usual",
      text: "Hi Sam, thanks for writing to A Made Up Studio.",
    });
    expect(reason(settings(), facts({ messageKind: "story_reply" }))).toBe("send usual");
    expect(reason(settings(), facts({ messageKind: "share" }))).toBe("send usual");
    // An archived conversation comes back when the customer writes, so it is answered.
    expect(reason(settings(), facts({ shelf: "archived" }))).toBe("send usual");
  });

  it("goes by when the person wrote, not when we got to it", () => {
    const s = settings();
    // Written at 16:59, looked at at 17:01: still the inside-hours answer.
    const written = at("2026-11-25T21:59:00Z");
    expect(
      reason(s, facts({ channel: "email", receivedAt: written, now: written + 2 * 60_000 })),
    ).toBe("send usual");
    expect(
      reason(s, facts({ channel: "facebook", receivedAt: written, now: written + 2 * 60_000 })),
    ).toBe("inside_hours");
    expect(reason(s, facts({ channel: "facebook", receivedAt: CLOSED, now: CLOSED + 1 }))).toBe(
      "send away",
    );
    expect(
      shouldAutoReply(s, facts({ channel: "email", receivedAt: CLOSED, now: CLOSED })),
    ).toEqual({
      send: true,
      variant: "away",
      text: "Got it. We're closed and will answer when we open.",
    });
  });

  it("is never for anything but a person's own message", () => {
    const s = settings();
    for (const messageKind of [
      "reaction",
      "comment",
      "private_reply",
      "story_mention",
      "forward",
    ]) {
      expect(reason(s, facts({ messageKind })), messageKind).toBe("not_a_message");
    }
    // A comment on a post is public: never, whatever its kind says.
    expect(reason(s, facts({ ticketKind: "comment" }))).toBe("not_a_message");
    // An echo of something sent from the app, or by us.
    expect(reason(s, facts({ direction: "outbound" }))).toBe("not_a_message");
    // Taken back before we got to it.
    expect(reason(s, facts({ removed: true }))).toBe("not_a_message");
  });

  it("leaves Spam and the Trash alone", () => {
    expect(reason(settings(), facts({ shelf: "spam" }))).toBe("shelved");
    expect(reason(settings(), facts({ shelf: "trash" }))).toBe("shelved");
  });

  it("stays out of a conversation another inbox tool has, unless told to take it", () => {
    const s = settings();
    expect(reason(s, facts({ standby: true }))).toBe("another_tool");
    expect(reason(s, facts({ standby: true, takeControl: true }))).toBe("send usual");
    // Standby is Meta's: it means nothing for email.
    expect(reason(s, facts({ channel: "email", standby: true }))).toBe("send usual");
  });

  it("never answers a machine, or ourselves, by email", () => {
    const s = settings();
    expect(reason(s, facts({ channel: "email", automatedMail: true }))).toBe("automated");
    expect(reason(s, facts({ channel: "email", fromOwnAddress: true }))).toBe("own_address");
    // Those two are about email only.
    expect(reason(s, facts({ automatedMail: true, fromOwnAddress: true }))).toBe("send usual");
  });

  it("doesn't answer late", () => {
    const s = settings();
    expect(reason(s, facts({ now: OPEN + STALE_AFTER_MS }))).toBe("send usual");
    expect(reason(s, facts({ now: OPEN + STALE_AFTER_MS + 1 }))).toBe("stale");
    expect(reason(s, facts({ receivedAt: Number.NaN }))).toBe("stale");
  });

  it("stays quiet once the team has answered", () => {
    expect(reason(settings(), facts({ teamAnsweredSince: true }))).toBe("answered");
  });

  it("sends at most one per person per channel in the quiet period", () => {
    const s = settings();
    const now = OPEN + 2000;
    expect(reason(s, facts({ lastAutoReplyAt: now - 1 }))).toBe("quiet");
    expect(reason(s, facts({ lastAutoReplyAt: now - 24 * HOUR + 1 }))).toBe("quiet");
    expect(reason(s, facts({ lastAutoReplyAt: now - 24 * HOUR }))).toBe("send usual");
    const short = settings({ quiet_hours: 2 });
    expect(reason(short, facts({ lastAutoReplyAt: now - 2 * HOUR + 1 }))).toBe("quiet");
    expect(reason(short, facts({ lastAutoReplyAt: now - 2 * HOUR }))).toBe("send usual");
    const week = settings({ quiet_hours: 168 });
    expect(reason(week, facts({ lastAutoReplyAt: now - 167 * HOUR }))).toBe("quiet");
  });

  it("is plain elapsed time, whatever the clocks do in between", () => {
    // New York's clocks went forward at 07:00 UTC on 8 March 2026. A reply sent
    // at 20:00 the evening before is 23 clock-hours... and 24 real hours from
    // 20:00 UTC the next day, which is what counts.
    const s = settings();
    const before = at("2026-03-07T20:00:00Z");
    const f = (now: number) =>
      facts({ channel: "instagram", receivedAt: now, now, lastAutoReplyAt: before });
    expect(reason(s, f(at("2026-03-08T19:59:59Z")))).toBe("quiet");
    expect(reason(s, f(at("2026-03-08T20:00:00Z")))).toBe("send usual");
  });

  it("sends nothing when the words come to nothing", () => {
    const s = settings();
    s.instagram.message = "   ";
    expect(reason(s, facts())).toBe("no_words");
    // "Only outside hours" with no away message written.
    s.facebook.away_message = "";
    expect(reason(s, facts({ channel: "facebook", receivedAt: CLOSED, now: CLOSED }))).toBe(
      "no_words",
    );
  });

  it("gives its reasons in a fixed order", () => {
    const s = settings();
    const everything = facts({
      channel: "email",
      shelf: "spam",
      automatedMail: true,
      fromOwnAddress: true,
      teamAnsweredSince: true,
      lastAutoReplyAt: OPEN,
      now: OPEN + 10 * HOUR,
    });
    expect(reason(s, everything)).toBe("shelved");
    expect(reason(s, { ...everything, shelf: null })).toBe("own_address");
    expect(reason(s, { ...everything, shelf: null, fromOwnAddress: false })).toBe("automated");
    const human = { ...everything, shelf: null, fromOwnAddress: false, automatedMail: false };
    expect(reason(s, human)).toBe("stale");
    expect(reason(s, { ...human, now: OPEN + 1 })).toBe("answered");
    expect(reason(s, { ...human, now: OPEN + 1, teamAnsweredSince: false })).toBe("quiet");
  });
});

describe("mail a machine sent", () => {
  const from = "sam@example.test";
  it("is known by its headers", () => {
    expect(looksAutomated({}, from)).toBe(false);
    expect(looksAutomated({ "Auto-Submitted": "no" }, from)).toBe(false);
    expect(looksAutomated({ "Auto-Submitted": "auto-replied" }, from)).toBe(true);
    expect(looksAutomated({ "auto-submitted": "auto-generated" }, from)).toBe(true);
    expect(looksAutomated({ Precedence: "bulk" }, from)).toBe(true);
    expect(looksAutomated({ Precedence: "list" }, from)).toBe(true);
    expect(looksAutomated({ Precedence: "junk" }, from)).toBe(true);
    expect(looksAutomated({ Precedence: "auto_reply" }, from)).toBe(true);
    expect(looksAutomated({ Precedence: "first-class" }, from)).toBe(false);
    expect(looksAutomated({ "List-Unsubscribe": "<mailto:x@example.test>" }, from)).toBe(true);
    expect(looksAutomated({ "List-Id": "<news.example.test>" }, from)).toBe(true);
    expect(looksAutomated({ "X-Autoreply": "yes" }, from)).toBe(true);
    expect(looksAutomated({ "X-Auto-Response-Suppress": "All" }, from)).toBe(true);
    expect(looksAutomated({ "X-Loop": "desk" }, from)).toBe(true);
    expect(looksAutomated({ "Return-Path": "<>" }, from)).toBe(true);
    expect(looksAutomated({ "Return-Path": "<sam@example.test>" }, from)).toBe(false);
    expect(looksAutomated({ Subject: "Precedence: bulk" }, from)).toBe(false);
  });

  it("is known by who it says it is from", () => {
    for (const sender of [
      "no-reply@shop.test",
      "noreply@shop.test",
      "no_reply@shop.test",
      "NoReply+abc@shop.test",
      "do-not-reply@shop.test",
      "donotreply@shop.test",
      "mailer-daemon@mail.test",
      "postmaster@mail.test",
      "bounce@mail.test",
      "bounces+123@mail.test",
      "notifications@service.test",
      "auto-reply@service.test",
      "autoresponder@service.test",
    ]) {
      expect(looksAutomated({}, sender), sender).toBe(true);
    }
    for (const sender of ["noel@shop.test", "norah.reply@shop.test", "postman@shop.test"]) {
      expect(looksAutomated({}, sender), sender).toBe(false);
    }
  });

  it("knows the business's own addresses", () => {
    const own = { domain: "inbound.example.test", addresses: ["Hello@Studio.test"] };
    expect(isOwnAddress("support-studio@inbound.example.test", own)).toBe(true);
    expect(isOwnAddress("support-other+abc@INBOUND.example.test", own)).toBe(true);
    expect(isOwnAddress(" hello@studio.test ", own)).toBe(true);
    expect(isOwnAddress("sam@example.test", own)).toBe(false);
    expect(isOwnAddress("sam@example.test", { domain: null, addresses: [] })).toBe(false);
  });
});
