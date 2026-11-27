import { describe, expect, it } from "vitest";
import { requiredItems } from "../setup/items";
import { DEFAULT_AUTO_REPLIES } from "./auto-reply/config";
import { autoReplyExplained, replyWindowExplained, viewExplained } from "./explain";
import { HELPDESK_STEPS, helpdeskSetupItems, type HelpdeskSetupFacts } from "./setup";
import { replyWindow } from "./social/window";

const NOW = new Date("2026-11-27T15:00:00Z");
const fresh = { status: "active" as const, lastSyncedAt: "2026-11-27T12:00:00Z", lastError: null };
const on = { instagram: "on", facebook: "on" } as const;

/** A workspace with nothing left to do. */
const done = (more: Partial<HelpdeskSetupFacts> = {}): HelpdeskSetupFacts => ({
  now: NOW,
  address: true,
  emailReceived: true,
  ownAddresses: 1,
  undoSeconds: 5,
  templates: 2,
  rules: 1,
  social: { offered: true, messages: on, comments: on },
  autoReplyOn: true,
  manual: { saved: true },
  helpCentre: { on: true },
  shop: fresh,
  ...more,
});
const ids = (facts: HelpdeskSetupFacts) => helpdeskSetupItems(facts).map((item) => item.id);

describe("helpdeskSetupItems", () => {
  it("has nothing to say when everything is in place", () => {
    expect(helpdeskSetupItems(done())).toEqual([]);
  });

  it("asks for the forwarding until the first email comes in", () => {
    expect(ids(done({ emailReceived: false }))).toEqual(["email.forward"]);
    // Not known, or no mail in this environment: never a false "do this".
    expect(ids(done({ emailReceived: null }))).toEqual([]);
    expect(ids(done({ address: false, emailReceived: false }))).toEqual([]);
  });

  it("says when a channel is switched on but can't come in", () => {
    const item = helpdeskSetupItems(
      done({
        social: {
          offered: true,
          messages: { instagram: "blocked", facebook: "on" },
          comments: { instagram: "off", facebook: "blocked" },
        },
      }),
    ).find((i) => i.id === "channels.blocked");
    expect(item).toMatchObject({
      title: "Instagram messages and Facebook comments are switched on but can't come in",
      to: "settings/helpdesk/channels",
    });
    expect(item?.optional).toBeUndefined();
  });

  it("offers Instagram and Facebook only where they're offered and all off", () => {
    const off = { instagram: "off", facebook: "off" } as const;
    expect(ids(done({ social: { offered: true, messages: off, comments: off } }))).toEqual([
      "channels.social",
    ]);
    expect(ids(done({ social: { offered: false, messages: off, comments: off } }))).toEqual([]);
  });

  it("offers the rest as optional, never on the card", () => {
    const facts = done({
      ownAddresses: 0,
      undoSeconds: 0,
      templates: 0,
      rules: 0,
      autoReplyOn: false,
      manual: { saved: false },
      helpCentre: { on: false },
      shop: null,
    });
    expect(ids(facts)).toEqual([
      "email.own",
      "email.undo",
      "replies.saved",
      "replies.rules",
      "automatic.reply",
      "manual",
      "help-centre",
      "shop.connect",
    ]);
    expect(requiredItems(helpdeskSetupItems(facts))).toEqual([]);
  });

  it("only links to the automatic reply's own form, for owners and admins", () => {
    const item = helpdeskSetupItems(done({ autoReplyOn: false }))[0];
    expect(item).toMatchObject({ to: "settings/helpdesk/auto-replies", managersOnly: true });
  });

  it("puts every item in a step that exists", () => {
    const steps = new Set(HELPDESK_STEPS.map((s) => s.id));
    const all = helpdeskSetupItems(
      done({ emailReceived: false, templates: 0, rules: 0, autoReplyOn: false, shop: null }),
    );
    for (const item of all) expect(steps.has(item.step)).toBe(true);
    expect(HELPDESK_STEPS.at(-1)?.id).toBe("review");
  });
});

describe("help desk explanations", () => {
  const now = NOW.getTime();
  const format = (at: string) => at.slice(0, 16);
  const ticket = {
    status: "open" as const,
    assignee_id: null,
    snoozed_until: null,
    merged_into: null,
  };

  it("says why an open conversation is where it is, and every view it's in", () => {
    const lines = viewExplained(ticket, "me", now, format);
    expect(lines[0]).toMatch(/nobody has it yet/);
    expect(lines[1]).toBe("It shows in: Unassigned, Open, All tickets.");
  });

  it("explains a snooze, a folder and a shelf", () => {
    const snoozed = { ...ticket, snoozed_until: "2026-11-28T14:00:00Z" };
    expect(viewExplained(snoozed, "me", now, format)[0]).toMatch(
      /snoozed until 2026-11-28T14:00.*back in Open/,
    );
    expect(viewExplained(snoozed, "me", now, format)[1]).toBe("It shows in: Snoozed, All tickets.");
    expect(
      viewExplained({ ...ticket, folder_id: "f" }, "me", now, format, { folder: "Repairs" })[0],
    ).toMatch(/filed in “Repairs”/);
    expect(
      viewExplained({ ...ticket, status: "closed", shelf: "spam" }, "me", now, format),
    ).toEqual([expect.stringMatching(/spam: closed/), "It shows in: Spam."]);
    expect(viewExplained({ ...ticket, merged_into: "x" }, "me", now, format)[0]).toMatch(/joined/);
  });

  it("explains Meta's reply window, open and passed", () => {
    const open = replyWindow("2026-11-27T10:00:00Z", now);
    expect(replyWindowExplained("instagram", open, format, false)[1]).toBe(
      "This one can be answered until 2026-11-28T10:00.",
    );
    const passed = replyWindow("2026-11-25T10:00:00Z", now);
    expect(replyWindowExplained("facebook", passed, format, false)[1]).toMatch(/That passed/);
    expect(replyWindowExplained("facebook", passed, format, true)[2]).toMatch(/seven days/);
    expect(replyWindowExplained("facebook", replyWindow(null, now), format, false)[1]).toMatch(
      /Nothing has come in/,
    );
  });

  it("says why an automatic reply did or didn't go", () => {
    const base = {
      channel: "email" as const,
      ticketKind: "message",
      sent: false,
      firstInboundAt: "2026-11-27T15:00:00Z", // Friday, 10am in New York
      timeZone: "America/New_York",
    };
    expect(autoReplyExplained(DEFAULT_AUTO_REPLIES, base)[0]).toMatch(/off for Email/);
    expect(autoReplyExplained(DEFAULT_AUTO_REPLIES, { ...base, sent: true })[0]).toMatch(
      /words saved for Email/,
    );
    expect(autoReplyExplained(DEFAULT_AUTO_REPLIES, { ...base, ticketKind: "comment" })[0]).toMatch(
      /public/,
    );
    const away = {
      ...DEFAULT_AUTO_REPLIES,
      email: { on: true, when: "outside_hours" as const, message: "", away_message: "Hi" },
    };
    expect(autoReplyExplained(away, base)[0]).toMatch(/during your opening hours/);
    expect(
      autoReplyExplained(away, { ...base, firstInboundAt: "2026-11-28T15:00:00Z" })[0],
    ).toMatch(/held back when/);
  });
});
