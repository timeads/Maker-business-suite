import { describe, expect, it } from "vitest";
import {
  buildRunsheet,
  parseDay,
  rangeLabel,
  returningBookings,
  runsheetCsv,
  runsheetRange,
  type RunsheetSession,
} from "./runsheet";
import { renderRunsheetPdf } from "./runsheet-pdf";

const person = (over: Partial<RunsheetSession["people"][number]> = {}) => ({
  id: "p1",
  name: "Pat Example",
  email: "pat@example.com",
  phone: "",
  seats: 1,
  attendance: null,
  notes: "",
  answers: {},
  returning: false,
  ...over,
});

const sessions: RunsheetSession[] = [
  {
    id: "s2",
    service: "Punch needle",
    location: "",
    starts_at: "2027-03-07T15:00:00.000Z",
    ends_at: "2027-03-07T17:00:00.000Z",
    capacity: 6,
    people: [],
  },
  {
    id: "s1",
    service: "Rug tufting",
    location: "Studio 2",
    starts_at: "2027-03-06T15:00:00.000Z",
    ends_at: "2027-03-06T18:00:00.000Z",
    capacity: 10,
    people: [
      person({ id: "b", name: "Sam Shopper", seats: 2, phone: "555 0100", returning: true }),
      person({
        id: "a",
        name: "Ana López",
        attendance: "attended",
        notes: "Vegetarian lunch",
        answers: { "Left-handed?": "Yes", Size: "Large" },
      }),
    ],
  },
];

describe("the runsheet", () => {
  const doc = buildRunsheet({
    business: "The Studio",
    timezone: "America/New_York",
    from: "2027-03-06",
    to: "2027-03-19",
    sessions,
  });

  it("puts the classes in time order, leaves out empty ones, and sorts people by name", () => {
    expect(doc.title).toBe("Runsheet");
    expect(doc.subtitle).toBe("Mar 6 to Mar 19, 2027");
    expect(doc.blocks.map((b) => b.title)).toEqual(["Rug tufting"]);
    const block = doc.blocks[0];
    expect(block.when).toBe("Sat, Mar 6, 10:00 AM – 1:00 PM EST");
    expect(block.line).toBe("Studio 2 · 3 of 10 places booked · 1 checked in");
    expect(block.rows.map((r) => r.name)).toEqual(["Ana López", "Sam Shopper"]);
  });

  it("carries contact, places, check-in, notes, answers and returning", () => {
    const [ana, sam] = doc.blocks[0].rows;
    expect(ana).toMatchObject({ here: true, returning: false, contact: "pat@example.com" });
    expect(ana.extra).toEqual(["Vegetarian lunch", "Left-handed? Yes", "Size: Large"]);
    expect(sam).toMatchObject({
      seats: "2",
      returning: true,
      contact: "pat@example.com · 555 0100",
    });
    expect(doc.footnote).toBe("Returning: has booked with you before.");
  });

  it("is one date's roster with every block kept, even an empty one", () => {
    const one = buildRunsheet({
      business: "The Studio",
      timezone: "America/New_York",
      from: "2027-03-07",
      to: "2027-03-07",
      sessions: [sessions[0]],
      single: true,
    });
    expect(one.title).toBe("Punch needle: who's coming");
    expect(one.blocks).toHaveLength(1);
    expect(one.footnote).toBeNull();
  });

  it("makes a spreadsheet with one row per person, and defuses formulas", () => {
    const withFormula = [
      { ...sessions[1], people: [person({ name: "=HYPERLINK(1)", returning: true })] },
    ];
    const sheet = buildRunsheet({
      business: "x",
      timezone: "America/New_York",
      from: "2027-03-06",
      to: "2027-03-06",
      sessions: withFormula,
    });
    const csv = runsheetCsv(sheet, withFormula, "America/New_York").split("\r\n");
    expect(csv[0]).toBe("Class,Day,When,Name,Email,Phone,Places,Returning,Checked in");
    expect(csv[1]).toContain("'=HYPERLINK(1)");
    expect(csv[1]).toContain("2027-03-06");
    expect(csv[1]).toContain(",Yes,");
  });

  it("draws as a PDF with the built-in font", async () => {
    const pdf = await renderRunsheetPdf(doc);
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
  });
});

describe("who is returning", () => {
  it("counts an earlier date under the same email, never the same or a later one", () => {
    const people = [
      { id: "1", email: "Pat@Example.com ", starts_at: "2027-03-06T15:00:00Z" },
      { id: "2", email: "sam@example.com", starts_at: "2027-03-06T15:00:00Z" },
      { id: "3", email: "new@example.com", starts_at: "2027-03-06T15:00:00Z" },
    ];
    const history = [
      { email: "pat@example.com", starts_at: "2026-11-01T15:00:00Z" },
      { email: "sam@example.com", starts_at: "2027-03-06T15:00:00Z" },
      { email: "new@example.com", starts_at: "2027-04-01T15:00:00Z" },
      { email: "", starts_at: "2020-01-01T00:00:00Z" },
    ];
    expect([...returningBookings(people, history)]).toEqual(["1"]);
  });
});

describe("the days a runsheet covers", () => {
  it("is today and the next 13 days unless the address says", () => {
    expect(runsheetRange({}, "2027-03-06")).toEqual({ from: "2027-03-06", to: "2027-03-19" });
    expect(runsheetRange({ from: "2027-03-10", to: "2027-03-01" }, "2027-03-06")).toEqual({
      from: "2027-03-10",
      to: "2027-03-10",
    });
    expect(runsheetRange({ from: "2027-01-01", to: "2028-01-01" }, "x").to).toBe("2027-04-03");
  });
  it("only takes real days", () => {
    expect(parseDay("2027-02-30")).toBeNull();
    expect(parseDay("2027-02-28")).toBe("2027-02-28");
    expect(parseDay("tomorrow")).toBeNull();
  });
  it("says one day in full", () => {
    expect(rangeLabel("2027-03-06", "2027-03-06")).toBe("Saturday, Mar 6, 2027");
  });
});
