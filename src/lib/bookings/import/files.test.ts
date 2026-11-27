import { describe, expect, it } from "vitest";
import {
  BOOKING_ALIASES,
  BOOKING_COLUMNS,
  BOOKING_IMPORT_KINDS,
  guessBookingImportKind,
  readBookingImport,
  readMoment,
  readTags,
} from "./files";
import { BOOKING_IMPORT_GUIDE } from "./guide";
import { bookingCountLines } from "./words";

const NY = "America/New_York";
const read = (kind: "workshops" | "dates" | "bookings", text: string) => {
  const result = readBookingImport(kind, text, { timeZone: NY });
  if (!result.ok) throw new Error(result.error);
  return result;
};

describe("reading a moment", () => {
  it("takes a time zone when the cell has one, as a database writes it", () => {
    expect(readMoment("2027-03-06 15:00:00+00", NY)).toBe("2027-03-06T15:00:00.000Z");
    expect(readMoment("2027-03-06T15:00:00Z", NY)).toBe("2027-03-06T15:00:00.000Z");
    expect(readMoment("2027-03-06 10:00:00-05:00", NY)).toBe("2027-03-06T15:00:00.000Z");
    expect(readMoment("2027-03-06 15:00:00.123+0000", NY)).toBe("2027-03-06T15:00:00.000Z");
  });

  it("reads a time with no zone on the workspace's own clock, through the clock change", () => {
    // Before the clocks go forward (EST, UTC-5) and after (EDT, UTC-4).
    expect(readMoment("2027-03-13 10:00", NY)).toBe("2027-03-13T15:00:00.000Z");
    expect(readMoment("2027-03-15 10:00", NY)).toBe("2027-03-15T14:00:00.000Z");
    expect(readMoment("3/15/2027 2:30 pm", NY)).toBe("2027-03-15T18:30:00.000Z");
    // 2:30 in the morning doesn't happen on the day the clocks go forward.
    expect(readMoment("2027-03-14 02:30", NY)).toBeNull();
  });

  it("takes a plain day only where a day is enough", () => {
    expect(readMoment("2027-03-06", NY)).toBeNull();
    expect(readMoment("2027-03-06", NY, true)).toBe("2027-03-06T17:00:00.000Z");
    expect(readMoment("2/30/2027", NY, true)).toBeNull();
    expect(readMoment("soon", NY, true)).toBeNull();
  });
});

describe("tags", () => {
  it("reads a database's list and a plain one", () => {
    expect(readTags("{gift,Returning}")).toEqual(["gift", "returning"]);
    expect(readTags("gift; gift ; vip")).toEqual(["gift", "vip"]);
    expect(readTags("")).toEqual([]);
  });
});

describe("the workshops file", () => {
  it("takes the earlier app's own column names", () => {
    const r = read(
      "workshops",
      [
        "id,title,description,duration_minutes,default_capacity,location,shopify_product_id,shopify_variant_id,active",
        "w1,Mini tufting,Make a mini rug,180,8,Studio 2,gid://shopify/Product/9001,9101,t",
        "w2,  One-day   rug ,,360,6,,,,f",
      ].join("\n"),
    );
    expect(r.problems).toEqual([]);
    expect(r.payload[0]).toEqual({
      line: 2,
      ref: "w1",
      name: "Mini tufting",
      description: "Make a mini rug",
      duration_minutes: 180,
      capacity: 8,
      location: "Studio 2",
      shop_product_id: "9001",
      shop_variant_id: "9101",
      active: true,
    });
    expect(r.payload[1]).toMatchObject({ name: "One-day rug", active: false, location: "" });
  });

  it("reports rows it can't use by line, and keeps the rest", () => {
    const r = read(
      "workshops",
      ["id,name,duration_minutes", "w1,Good,60", "w2,,60", "w3,Long,9999", "w1,Again,60"].join(
        "\n",
      ),
    );
    expect(r.payload).toHaveLength(1);
    expect(r.problems.map((p) => p.line)).toEqual([3, 4, 5]);
    expect(r.problems[2].reason).toMatch(/twice/);
  });

  it("says plainly when a needed column is missing", () => {
    const r = readBookingImport("workshops", "id,length\nw1,60", { timeZone: NY });
    expect(r).toEqual({ ok: false, error: expect.stringContaining("“name”") });
  });
});

describe("the dates file", () => {
  it("keeps a date's id, reads its times and its shared room", () => {
    const id = "11111111-1111-4111-8111-111111111111";
    const r = read(
      "dates",
      [
        "id,workshop_id,starts_at,capacity,status,bookings_closed,private,notes,capacity_group_id,shared_capacity",
        `${id},w1,2027-03-06 15:00:00+00,8,scheduled,f,f,Big table,g1,12`,
        `not-a-uuid,w1,2027-03-07 15:00:00+00,8,cancelled,,,,,`,
        `x3,w1,2027-03-08 10:00,8,odd,,,,,`,
        `x4,w1,2027-03-09 10:00,8,scheduled,,,,g2,`,
      ].join("\n"),
    );
    expect(r.payload[0]).toEqual({
      line: 2,
      ref: id,
      keep_id: id,
      workshop_ref: "w1",
      starts_at: "2027-03-06T15:00:00.000Z",
      capacity: 8,
      cancelled: false,
      bookings_closed: false,
      private: false,
      notes: "Big table",
      shared_group: "g1",
      shared_capacity: 12,
    });
    // An id that isn't one of ours to keep is still remembered, for bookings to find.
    expect(r.payload[1]).toMatchObject({ ref: "not-a-uuid", cancelled: true });
    expect(r.payload[1]).not.toHaveProperty("keep_id");
    expect(r.problems.map((p) => p.line)).toEqual([4, 5]);
    expect(r.notes[0]).toMatch(/1 date keeps its id/);
  });

  it("needs a start with a time", () => {
    const r = read("dates", "workshop,starts_at\nMini,2027-03-06");
    expect(r.payload).toEqual([]);
    expect(r.problems[0].reason).toMatch(/date and time/);
  });
});

describe("the bookings file", () => {
  it("reads a booking as the earlier app keeps it", () => {
    const r = read(
      "bookings",
      [
        "id,session_id,customer_name,customer_email,customer_phone,sms_opt_in,seats,shopify_order_id,shopify_order_number,status,source,created_at,notes,tags,cancelled_at,email_opt_in,reminder_sent_at,day_of_sent_at,followup_sent_at",
        "b1,s1,Pat Example,PAT@Example.com,+1 (555) 010-0100,t,2,5001,#1001,attended,shopify,2027-01-02 15:00:00+00,,{gift},,t,2027-03-04 15:00:00+00,,",
        "b2,s1,,,,,1,,,confirmed,manual,,,,,,,,",
        "b3,s1,Lee,lee@example.com,,,1,,,no_show,eventbrite,,,,,f,,,",
      ].join("\n"),
    );
    expect(r.problems).toEqual([{ line: 3, reason: "A booking needs a name or an email address" }]);
    expect(r.payload[0]).toEqual({
      line: 2,
      ref: "b1",
      session_ref: "s1",
      name: "Pat Example",
      email: "pat@example.com",
      phone: "+1 (555) 010-0100",
      text_opt_in: true,
      seats: 2,
      status: "confirmed",
      attendance: "attended",
      source: "online",
      tags: ["gift"],
      shop_order_id: "5001",
      shop_order_name: "#1001",
      notes: "",
      email_opt_in: true,
      created_at: "2027-01-02T15:00:00.000Z",
      cancelled_at: null,
      reminder_sent_at: "2027-03-04T15:00:00.000Z",
      day_of_sent_at: null,
      followup_sent_at: null,
      reminder_text_sent_at: null,
      day_of_text_sent_at: null,
      followup_text_sent_at: null,
      amount_cents: null,
    });
    expect(r.payload[1]).toMatchObject({
      source: "manual",
      attendance: "no_show",
      email_opt_in: false,
      tags: ["eventbrite"],
    });
    expect(r.notes.join(" ")).toMatch(/Nobody is emailed or texted/);
    expect(r.notes.join(" ")).toMatch(/Eventbrite/);
  });

  it("reads which texts the earlier app sent, under its own column names too", () => {
    const r = read(
      "bookings",
      [
        "session_id,customer_email,seats,reminder_48h_sms_sent_at,day_of_text_sent_at,followup_24h_sms_sent_at",
        "s1,a@example.com,1,2027-03-04 15:00:00+00,,2027-03-08 15:00:00+00",
      ].join("\n"),
    );
    expect(r.problems).toEqual([]);
    expect(r.payload[0]).toMatchObject({
      reminder_text_sent_at: "2027-03-04T15:00:00.000Z",
      day_of_text_sent_at: null,
      followup_text_sent_at: "2027-03-08T15:00:00.000Z",
    });
  });

  it("leaves out what can't be a booking", () => {
    const r = read(
      "bookings",
      [
        "session_id,customer_email,seats,status",
        "s1,a@example.com,0,confirmed",
        "s1,not-an-email,1,confirmed",
        ",b@example.com,1,confirmed",
        "s1,c@example.com,1,pending",
        "s1,d@example.com,2,cancelled",
      ].join("\n"),
    );
    expect(r.payload).toHaveLength(1);
    expect(r.payload[0]).toMatchObject({ status: "cancelled", seats: 2 });
    expect(r.problems.map((p) => p.line)).toEqual([2, 3, 4, 5]);
  });
});

describe("telling the files apart", () => {
  it("by their headings", () => {
    expect(guessBookingImportKind(["id", "title", "default_capacity"])).toBe("workshops");
    expect(guessBookingImportKind(["id", "workshop_id", "starts_at"])).toBe("dates");
    expect(guessBookingImportKind(["id", "session_id", "seats", "customer_email"])).toBe(
      "bookings",
    );
    expect(guessBookingImportKind(["sku", "on_hand"])).toBeNull();
  });
});

describe("the guide", () => {
  it("names only columns the readers know, and every needed one", () => {
    for (const kind of BOOKING_IMPORT_KINDS) {
      const known = new Set(BOOKING_COLUMNS[kind]);
      for (const column of BOOKING_IMPORT_GUIDE[kind].columns) {
        expect(known.has(column.name), `${kind}: ${column.name}`).toBe(true);
      }
      for (const alias of Object.keys(BOOKING_ALIASES[kind])) {
        expect(known.has(alias), `${kind} alias for ${alias}`).toBe(true);
      }
    }
  });
});

describe("the words for the counts", () => {
  it("say what would happen, then what did", () => {
    const counts = { new: 2, changed: 0, same: 1, refused: [{ line: 4, reason: "x" }] };
    expect(bookingCountLines("dates", counts, false)).toEqual([
      "2 new dates to bring in",
      "1 date already here as the file says",
      "1 row left out by the check against what's here",
    ]);
    expect(
      bookingCountLines("bookings", { new: 0, changed: 0, same: 0, refused: [] }, true),
    ).toEqual(["Nothing in this file would change anything."]);
  });
});
