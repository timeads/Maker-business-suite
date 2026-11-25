import { describe, expect, it } from "vitest";
import { EXPORT_COLUMNS, csvCell, exportName, ticketsCsv, type ExportRow } from "./export";
import { groupTags, parseTagGroups, tagGroupsSchema } from "./tag-groups";

const row = (over: Partial<ExportRow> = {}): ExportRow => ({
  number: 12,
  subject: "Where is my rug?",
  customer_name: "Pat Maker",
  customer_email: "pat@example.test",
  status: "open",
  priority: "normal",
  assignee: "Amy",
  tags: ["shipping", "vip"],
  messages: 3,
  created_at: "2026-11-20T10:00:00Z",
  last_message_at: "2026-11-21T10:00:00Z",
  first_reply_at: null,
  closed_at: null,
  kind: null,
  mood: null,
  ...over,
});

describe("the list as a spreadsheet", () => {
  it("has a heading row and one line per conversation, with no message text", () => {
    const csv = ticketsCsv([row(), row({ number: 13, subject: 'Rug, "blue"', tags: [] })]);
    const lines = csv.trimEnd().split("\n");
    expect(lines[0]).toBe(EXPORT_COLUMNS.join(","));
    expect(lines[0]).not.toMatch(/body|message_text/);
    expect(lines[1]).toBe(
      "12,Where is my rug?,Pat Maker,pat@example.test,open,normal,Amy,shipping; vip,3,2026-11-20T10:00:00Z,2026-11-21T10:00:00Z,,,,",
    );
    expect(lines[2]).toContain('13,"Rug, ""blue""",');
    expect(csv.endsWith("\n")).toBe(true);
  });

  it("keeps a subject that looks like a formula as text", () => {
    expect(csvCell('=HYPERLINK("http://x")')).toBe('"\'=HYPERLINK(""http://x"")"');
    expect(csvCell("+1 555 0100")).toBe("'+1 555 0100");
    expect(csvCell("-5")).toBe("'-5");
    expect(csvCell("@pat")).toBe("'@pat");
    expect(csvCell("plain")).toBe("plain");
    expect(csvCell(null)).toBe("");
    expect(csvCell("two\nlines")).toBe('"two\nlines"');
  });

  it("names the file for the day", () => {
    expect(exportName("2026-11-25")).toBe("conversations-2026-11-25.csv");
  });
});

describe("tags in groups", () => {
  const groups = [
    { id: "a", name: "Problem", tags: ["jammed", "noise"] },
    { id: "b", name: "Product", tags: ["gun", "frame"] },
  ];

  it("offers each group's tags, then the rest under Other", () => {
    expect(groupTags(groups, ["noise", "vip", "wholesale"])).toEqual([
      { name: "Problem", tags: ["jammed", "noise"] },
      { name: "Product", tags: ["gun", "frame"] },
      { name: "Other", tags: ["vip", "wholesale"] },
    ]);
  });

  it("leaves out what is already on, narrows by what was typed, and drops empty groups", () => {
    expect(groupTags(groups, ["vip"], { on: ["jammed", "vip"], find: "no" })).toEqual([
      { name: "Problem", tags: ["noise"] },
    ]);
    expect(groupTags([], ["vip"])).toEqual([{ name: "Tags", tags: ["vip"] }]);
    expect(groupTags([], [])).toEqual([]);
  });

  it("is a checked setting", () => {
    expect(parseTagGroups(null).groups).toEqual([]);
    expect(
      tagGroupsSchema.safeParse({ version: 1, groups: [{ id: "a", name: "X", tags: [] }] }).success,
    ).toBe(false);
    expect(
      tagGroupsSchema.parse({ version: 1, groups: [{ id: "a", name: " X ", tags: ["Loud "] }] })
        .groups[0],
    ).toEqual({ id: "a", name: "X", tags: ["loud"] });
  });
});
