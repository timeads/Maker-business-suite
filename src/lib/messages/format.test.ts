import { describe, expect, it } from "vitest";
import {
  handlesFor,
  initials,
  layoutMessages,
  mentionsMe,
  nameOf,
  splitBody,
  type ChatMessage,
  type Person,
} from "./format";

const kim: Person = { user_id: "u-kim", email: "kim.lee@shop.test", display_name: null };
const sam: Person = { user_id: "u-sam", email: "sam@shop.test", display_name: "Samira Q" };
const people = [kim, sam];

describe("names", () => {
  it("come from the chosen name, else the email", () => {
    expect(nameOf(kim)).toBe("Kim Lee");
    expect(nameOf(sam)).toBe("Samira Q");
    expect(nameOf(undefined)).toBe("Someone");
    expect(initials("Kim Lee")).toBe("KL");
    expect(initials("Samira")).toBe("SA");
    expect(initials("Jo (studio)")).toBe("JS");
    expect(handlesFor(sam)).toEqual(["samira", "sam"]);
  });
});

describe("splitBody", () => {
  it("finds links and mentions and leaves everything else as text", () => {
    const pieces = splitBody("@kim see https://example.com/a?b=1. Thanks @sam!", people, "u-sam");
    expect(pieces).toEqual([
      { kind: "mention", text: "@Kim", me: false },
      { kind: "text", text: " see " },
      { kind: "link", text: "https://example.com/a?b=1", href: "https://example.com/a?b=1" },
      { kind: "text", text: ". Thanks " },
      { kind: "mention", text: "@Samira", me: true },
      { kind: "text", text: "!" },
    ]);
  });

  it("treats unknown handles, markup and script as plain text", () => {
    const body = "@nobody <img src=x onerror=alert(1)> javascript:alert(1)";
    expect(splitBody(body, people, "u-kim")).toEqual([{ kind: "text", text: body }]);
  });

  it("knows when a message mentions me", () => {
    expect(mentionsMe("morning @kim.lee", people, "u-kim")).toBe(true);
    expect(mentionsMe("morning @kim.lee", people, "u-sam")).toBe(false);
  });
});

describe("layoutMessages", () => {
  const msg = (id: number, author: string, at: string): ChatMessage => ({
    id,
    channel_id: "c",
    author_id: author,
    app: null,
    body: "x",
    created_at: at,
    edited_at: null,
    deleted_at: null,
  });

  it("groups a quick run from one author and divides by local day", () => {
    const rows = layoutMessages(
      [
        msg(1, "a", "2026-11-21T15:00:00Z"),
        msg(2, "a", "2026-11-21T15:03:00Z"),
        msg(3, "a", "2026-11-21T15:20:00Z"),
        msg(4, "b", "2026-11-21T15:21:00Z"),
        // 03:30 UTC is still the evening of the 21st in New York.
        msg(5, "b", "2026-11-22T03:30:00Z"),
        msg(6, "b", "2026-11-22T14:00:00Z"),
      ],
      "America/New_York",
      new Date("2026-11-22T18:00:00Z"),
    );
    expect(
      rows.map((r) => (r.kind === "day" ? r.label : `${r.message.id}${r.head ? "*" : ""}`)),
    ).toEqual(["Yesterday", "1*", "2", "3*", "4*", "5*", "Today", "6*"]);
  });
});
