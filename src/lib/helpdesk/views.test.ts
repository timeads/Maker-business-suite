import { describe, expect, it } from "vitest";
import { actionsFor, autoTagRulesSchema } from "./config";
import { describeEvent } from "./activity";
import { passesFilters } from "./list";
import { describeConditions, matchesConditions } from "./saved-views";
import {
  byUrgency,
  formatDuration,
  inFolder,
  inView,
  isShelf,
  median,
  parseView,
  snoozeChoices,
  VIEWS,
} from "./views";

const NOW = Date.parse("2026-11-20T15:00:00Z");
const ME = "11111111-1111-4111-8111-111111111111";
const base = { status: "open", assignee_id: null, snoozed_until: null, merged_into: null } as const;

describe("inbox folders", () => {
  it("puts a live conversation in one main folder only", () => {
    const cases = [
      base,
      { ...base, status: "pending" as const },
      { ...base, status: "closed" as const },
      { ...base, snoozed_until: "2026-11-21T15:00:00Z" },
    ];
    for (const ticket of cases) {
      const main = (["open", "pending", "snoozed", "closed"] as const).filter((v) =>
        inView(ticket, v, ME, NOW),
      );
      expect(main).toHaveLength(1);
    }
  });

  it("a snooze that has run out is back in the inbox", () => {
    const ticket = { ...base, snoozed_until: "2026-11-20T14:00:00Z" };
    expect(inView(ticket, "open", ME, NOW)).toBe(true);
    expect(inView(ticket, "snoozed", ME, NOW)).toBe(false);
  });

  it("mine and unassigned follow who has it; folded conversations only show under everything", () => {
    expect(inView({ ...base, assignee_id: ME }, "mine", ME, NOW)).toBe(true);
    expect(inView({ ...base, assignee_id: ME }, "unassigned", ME, NOW)).toBe(false);
    expect(inView(base, "unassigned", ME, NOW)).toBe(true);
    const folded = { ...base, status: "closed" as const, merged_into: "x" };
    expect(VIEWS.filter((v) => inView(folded, v.key, ME, NOW)).map((v) => v.key)).toEqual(["all"]);
  });

  it("sorts urgent to the top, then newest first", () => {
    const rows = [
      { id: "a", priority: "normal" as const, last_message_at: "2026-11-20T10:00:00Z" },
      { id: "b", priority: "urgent" as const, last_message_at: "2026-11-19T10:00:00Z" },
      { id: "c", priority: "low" as const, last_message_at: "2026-11-20T12:00:00Z" },
    ];
    expect(rows.sort(byUrgency).map((r) => r.id)).toEqual(["b", "c", "a"]);
  });
});

describe("archive, spam and the trash", () => {
  const base = {
    status: "closed" as const,
    assignee_id: "me",
    snoozed_until: null,
    merged_into: null,
    folder_id: null,
  };
  const working = ["mine", "unassigned", "open", "pending", "snoozed", "closed"] as const;

  it("a shelved conversation shows on its own shelf and in no working folder", () => {
    for (const shelf of ["archived", "spam", "trash"] as const) {
      const ticket = { ...base, shelf, mentioned: true };
      for (const view of working) expect(inView(ticket, view, "me", 0)).toBe(false);
      for (const other of ["archived", "spam", "trash"] as const) {
        expect(inView(ticket, other, "me", 0)).toBe(other === shelf);
      }
      expect(inFolder({ ...ticket, status: "open", folder_id: "f1" }, "f1")).toBe(false);
    }
  });

  it("archived is still under All tickets and Mentions; spam and trash are not", () => {
    expect(inView({ ...base, shelf: "archived" }, "all", "me", 0)).toBe(true);
    expect(inView({ ...base, shelf: "archived", mentioned: true }, "mentions", "me", 0)).toBe(true);
    for (const shelf of ["spam", "trash"] as const) {
      expect(inView({ ...base, shelf }, "all", "me", 0)).toBe(false);
      expect(inView({ ...base, shelf, mentioned: true }, "mentions", "me", 0)).toBe(false);
    }
  });

  it("a conversation that isn't shelved is on no shelf", () => {
    for (const shelf of ["archived", "spam", "trash"] as const) {
      expect(inView({ ...base, shelf: null }, shelf, "me", 0)).toBe(false);
      expect(inView({ ...base, status: "open" }, shelf, "me", 0)).toBe(false);
    }
    expect(inView({ ...base, shelf: null }, "closed", "me", 0)).toBe(true);
    expect(isShelf("spam")).toBe(true);
    expect(isShelf("open")).toBe(false);
    expect(parseView("trash")).toEqual({ kind: "built", key: "trash" });
  });

  it("saved views never hold spam or trash, and archived only under any status", () => {
    const row = {
      ...base,
      priority: "normal" as const,
      tags: [],
      subject: "s",
      customer: "c",
      unread: false,
    };
    expect(matchesConditions({ ...row, shelf: "spam" }, { status: "any" }, "me", 0)).toBe(false);
    expect(matchesConditions({ ...row, shelf: "trash" }, { status: "closed" }, "me", 0)).toBe(
      false,
    );
    expect(matchesConditions({ ...row, shelf: "archived" }, { status: "closed" }, "me", 0)).toBe(
      false,
    );
    expect(matchesConditions({ ...row, shelf: "archived" }, { status: "any" }, "me", 0)).toBe(true);
    expect(matchesConditions({ ...row, shelf: null }, { status: "closed" }, "me", 0)).toBe(true);
  });

  it("the log says who shelved what", () => {
    const names = { person: () => "Amy", when: (x: string) => x };
    const event = (detail: string) =>
      describeEvent({ id: "1", kind: "shelf", detail, actor_id: "u", created_at: "" }, names);
    expect(event("archived")).toBe("Amy archived this");
    expect(event("spam")).toBe("Amy marked this as spam");
    expect(event("trash")).toBe("Amy moved this to the Trash");
    expect(event("restored|spam")).toBe("Amy marked this as not spam");
    expect(event("restored|trash")).toBe("Amy restored this from the Trash");
    expect(event("restored|archived")).toBe("Amy took this out of the archive");
    const log = (kind: string, detail: string, actor: string | null) =>
      describeEvent({ id: "1", kind, detail, actor_id: actor, created_at: "" }, names);
    expect(log("tags", "+refund", "u")).toBe("Amy added the tag refund");
    expect(log("tags", "-refund", "u")).toBe("Amy removed the tag refund");
    expect(log("tags", "+shipping", null)).toBe("A rule added the tag shipping");
    expect(log("priority", "urgent", null)).toBe("A rule set priority to urgent");
    expect(log("priority", "high", "u")).toBe("Amy set priority to high");
  });
});

describe("snooze choices", () => {
  it("mornings are 9:00 on the workspace's clock, across a clock change", () => {
    // Friday 30 October 2026 in New York; clocks go back on Sunday 1 November.
    const choices = snoozeChoices(new Date("2026-10-30T18:00:00Z"), "America/New_York");
    const by = Object.fromEntries(choices.map((c) => [c.key, c.until]));
    expect(by.tomorrow).toBe("2026-10-31T13:00:00.000Z");
    expect(by.monday).toBe("2026-11-02T14:00:00.000Z");
    expect(by["3h"]).toBe("2026-10-30T21:00:00.000Z");
  });

  it("on a Monday, Monday means next week", () => {
    const choices = snoozeChoices(new Date("2026-11-02T18:00:00Z"), "UTC");
    expect(choices.find((c) => c.key === "monday")?.until).toBe("2026-11-09T09:00:00.000Z");
  });
});

describe("rules", () => {
  const rules = autoTagRulesSchema.parse({
    version: 1,
    rules: [
      { id: "a", contains: "refund", where: "anywhere", tag: "refund", priority: "high" },
      { id: "b", contains: "chargeback", where: "anywhere", priority: "urgent" },
      { id: "c", contains: "@bigstore.com", where: "from", tag: "wholesale", assign_to: ME },
      { id: "d", contains: "hello", where: "subject", priority: "low" },
    ],
  });

  it("keeps every tag, the most urgent priority and the first teammate", () => {
    const outcome = actionsFor(rules, {
      subject: "Hello, refund please",
      body: "or I will file a chargeback",
      from: "buyer@bigstore.com",
    });
    expect(outcome.tags.sort()).toEqual(["refund", "wholesale"]);
    expect(outcome.priority).toBe("urgent");
    expect(outcome.assignTo).toBe(ME);
  });

  it("does nothing when no words match", () => {
    expect(actionsFor(rules, { subject: "Lovely rug", body: "Thanks!", from: "a@b.co" })).toEqual({
      tags: [],
      priority: null,
      assignTo: null,
    });
  });

  it("a rule has to do something", () => {
    expect(
      autoTagRulesSchema.safeParse({ version: 1, rules: [{ id: "x", contains: "hi there" }] })
        .success,
    ).toBe(false);
  });
});

describe("report figures", () => {
  it("formats how long things took", () => {
    expect(formatDuration(5 * 60_000)).toBe("5m");
    expect(formatDuration(125 * 60_000)).toBe("2h 5m");
    expect(formatDuration(76 * 3_600_000)).toBe("3d 4h");
  });
  it("finds the middle value", () => {
    expect(median([])).toBeNull();
    expect(median([5, 1, 9])).toBe(5);
    expect(median([4, 2])).toBe(3);
  });
});

describe("Instagram and Facebook conversations", () => {
  const insta = { ...base, channel: "instagram" };
  it("have a view of their own: open or in progress, not snoozed, not filed", () => {
    expect(inView(insta, "social", ME, NOW)).toBe(true);
    expect(inView({ ...insta, channel: "facebook", status: "pending" }, "social", ME, NOW)).toBe(
      true,
    );
    expect(inView({ ...base, channel: "email" }, "social", ME, NOW)).toBe(false);
    expect(inView(base, "social", ME, NOW)).toBe(false);
    expect(inView({ ...insta, status: "closed" }, "social", ME, NOW)).toBe(false);
    expect(inView({ ...insta, snoozed_until: "2026-11-21T15:00:00Z" }, "social", ME, NOW)).toBe(
      false,
    );
    expect(inView({ ...insta, folder_id: "f1" }, "social", ME, NOW)).toBe(false);
    expect(inView({ ...insta, shelf: "spam" }, "social", ME, NOW)).toBe(false);
    // They sit in the ordinary views too, beside email.
    expect(inView(insta, "open", ME, NOW)).toBe(true);
    expect(inView(insta, "unassigned", ME, NOW)).toBe(true);
  });

  it("can be what a saved view or the filter row asks for", () => {
    const facts = {
      ...base,
      priority: "normal" as const,
      tags: [],
      subject: "",
      customer: "",
      unread: false,
    };
    const view = (channel: "email" | "instagram" | "facebook" | "social") =>
      ({ status: "active", channel }) as const;
    expect(matchesConditions({ ...facts, channel: "instagram" }, view("instagram"), ME, NOW)).toBe(
      true,
    );
    expect(matchesConditions({ ...facts, channel: "instagram" }, view("facebook"), ME, NOW)).toBe(
      false,
    );
    expect(matchesConditions({ ...facts, channel: "facebook" }, view("social"), ME, NOW)).toBe(
      true,
    );
    expect(matchesConditions({ ...facts, channel: "email" }, view("social"), ME, NOW)).toBe(false);
    // A conversation from before channels existed is an email.
    expect(matchesConditions(facts, view("email"), ME, NOW)).toBe(true);
    expect(describeConditions(view("social"), { person: () => "", folder: () => "" })).toBe(
      "open or in progress · from Instagram & Facebook",
    );
    const row = { ...facts, last_message_at: "", created_at: "", last_inbound_at: null };
    expect(passesFilters({ ...row, channel: "facebook" }, { channel: "social" }, ME)).toBe(true);
    expect(passesFilters({ ...row, channel: "facebook" }, { channel: "instagram" }, ME)).toBe(
      false,
    );
    expect(passesFilters(row, { channel: "email" }, ME)).toBe(true);
  });
});
