import { describe, expect, it } from "vitest";
import {
  bookingCancelledEmail,
  confirmationEmail,
  dateChangedEmail,
  dayOfEmail,
  followupEmail,
  movedEmail,
  reminderEmail,
  sessionCancelledEmail,
  shopCancelledEmail,
  type BookingDetails,
} from "./emails";
import {
  DEFAULT_EMAIL_WORDS,
  DEFAULT_WORDS,
  MESSAGE_KEYS,
  bookingEmail,
  emailWordsSchema,
  fillTemplate,
  messageWordsChanged,
  parseEmailWords,
  sampleBooking,
  sampleExtras,
  unknownFillIns,
  type EmailWords,
} from "./words";

const base: BookingDetails = {
  booking_id: "b",
  tenant_id: "t",
  status: "confirmed",
  seats: 2,
  amount_cents: 0,
  currency: "USD",
  customer_name: "Pat Example",
  customer_email: "pat@example.com",
  oversold: false,
  session_id: "s",
  starts_at: "2027-03-06T15:00:00.000Z",
  ends_at: "2027-03-06T17:00:00.000Z",
  session_cancelled: false,
  service_id: "v",
  service_name: "Rug tufting",
  service_kind: "workshop",
  workspace_name: "The Studio",
  workspace_slug: "the-studio",
  timezone: "America/New_York",
};

// Every shape of booking the old words had a branch for.
const variants: BookingDetails[] = [
  base,
  { ...base, location: "Studio 2, 12 Mill Lane" },
  { ...base, location: "   " },
  { ...base, seats: 1, amount_cents: 4500 },
  { ...base, service_kind: "appointment", seats: 1, amount_cents: 12000, currency: "GBP" },
  { ...base, customer_name: "  ", location: "Back room" },
  // Across the spring change, so the zone label in "when" moves with it.
  { ...base, starts_at: "2027-03-14T15:00:00.000Z", ends_at: "2027-03-14T17:00:00.000Z" },
  { ...base, timezone: "Europe/London", customer_name: "Ana María López" },
];
const notes = ["", "Park round the back.", "Line one.\n\n\nLine two after a gap."];
const link = "https://app.example/booking/abc123";
const was = { starts_at: "2027-02-27T15:00:00.000Z", ends_at: "2027-02-27T17:00:00.000Z" };
const none = DEFAULT_EMAIL_WORDS;

describe("our words, unchanged, are exactly the emails as they were", () => {
  for (const [i, d] of variants.entries()) {
    for (const note of notes) {
      it(`variant ${i}, note ${JSON.stringify(note.slice(0, 8))}`, () => {
        expect(bookingEmail("confirmation", d, none, { link, note })).toEqual(
          confirmationEmail(d, link, note),
        );
        expect(bookingEmail("reminder", d, none, { note })).toEqual(reminderEmail(d, note));
        expect(bookingEmail("day_of", d, none, { note })).toEqual(dayOfEmail(d, note));
        expect(bookingEmail("followup", d, none, { note })).toEqual(followupEmail(d, note));
      });
    }
    it(`variant ${i}, the notes-free messages`, () => {
      expect(bookingEmail("confirmation", d, none, { link })).toEqual(confirmationEmail(d, link));
      expect(bookingEmail("booking_cancelled", d, none)).toEqual(bookingCancelledEmail(d));
      expect(bookingEmail("session_cancelled", d, none)).toEqual(sessionCancelledEmail(d));
      expect(bookingEmail("shop_cancelled", d, none)).toEqual(shopCancelledEmail(d));
      expect(bookingEmail("moved", d, none)).toEqual(movedEmail(d, null));
      expect(bookingEmail("date_changed", d, none, { was })).toEqual(dateChangedEmail(d, d, was));
    });
  }
});

describe("the business's own words", () => {
  const words: EmailWords = {
    version: 1,
    reply_to: "hello@studio.example",
    messages: {
      reminder: {
        subject: "See you {{date}}, {{first_name}}!",
        body: "Hello {{name}},\n\n{{workshop}} is at {{time}}.\n{{where_line}}\n\n\n\nBring an apron.\n{{note}}",
      },
    },
  };

  it("fills each fill-in, leaves out empty lines, and never stacks blank lines", () => {
    const email = bookingEmail("reminder", base, words, { note: "" });
    expect(email.subject).toBe("See you Saturday, March 6, Pat!");
    expect(email.text).toBe(
      "Hello Pat Example,\n\nRug tufting is at 10:00 AM EST.\n\nBring an apron.",
    );
  });

  it("sends replies to the business's own address", () => {
    expect(bookingEmail("reminder", base, words).replyTo).toBe("hello@studio.example");
    expect(bookingEmail("reminder", base, none).replyTo).toBeUndefined();
  });

  it("only changes the message it was written for", () => {
    expect(bookingEmail("day_of", base, words, { note: "x" })).toEqual({
      ...dayOfEmail(base, "x"),
      replyTo: "hello@studio.example",
    });
  });

  it("never fills from a filled-in value twice", () => {
    const d = { ...base, customer_name: "{{business_name}}" };
    const email = bookingEmail("reminder", d, words);
    expect(email.text).toContain("Hello {{business_name}},");
  });

  it("keeps a line break out of the subject", () => {
    const d = { ...base, service_name: "Rugs\nand more" };
    expect(bookingEmail("reminder", d, none).subject).toBe(
      "Reminder: Rugs and more with The Studio",
    );
  });
});

describe("checking the words before they are saved", () => {
  it("refuses a fill-in the message doesn't have, and a misspelt one", () => {
    expect(unknownFillIns("reminder", "Your link: {{manage_link}}")).toEqual(["manage_link"]);
    expect(unknownFillIns("confirmation", "Your link: {{manage_link}}")).toEqual([]);
    expect(unknownFillIns("reminder", "Hi {{ First Name }}")).toEqual(["First Name"]);
    expect(unknownFillIns("reminder", "Hi {{nmae}}")).toEqual(["nmae"]);
    const parsed = emailWordsSchema.safeParse({
      version: 1,
      messages: { reminder: { subject: "Hi", body: "{{old_when}}" } },
    });
    expect(parsed.success).toBe(false);
  });

  it("refuses a subject with a line break, an empty body and a bad reply-to", () => {
    const bad = [
      { version: 1, messages: { reminder: { subject: "a\nb", body: "x" } } },
      { version: 1, messages: { reminder: { subject: "a", body: "  " } } },
      { version: 1, reply_to: "not an address" },
    ];
    for (const body of bad) expect(emailWordsSchema.safeParse(body).success).toBe(false);
  });

  it("reads anything unusable as our words", () => {
    expect(parseEmailWords(null)).toEqual(DEFAULT_EMAIL_WORDS);
    expect(parseEmailWords({ version: 2 })).toEqual(DEFAULT_EMAIL_WORDS);
    expect(parseEmailWords({ version: 1 })).toEqual(DEFAULT_EMAIL_WORDS);
  });

  it("tells a change of words from a change of reply-to only", () => {
    const words: EmailWords = {
      version: 1,
      reply_to: "",
      messages: { reminder: { subject: "a", body: "b" } },
    };
    expect(messageWordsChanged({ ...words, reply_to: "x@y.example" }, words)).toBe(false);
    expect(messageWordsChanged({ ...words, messages: {} }, words)).toBe(true);
    expect(
      messageWordsChanged({ ...words, messages: { reminder: { subject: "a", body: "c" } } }, words),
    ).toBe(true);
  });

  it("our own words pass our own check", () => {
    const parsed = emailWordsSchema.safeParse({ version: 1, messages: DEFAULT_WORDS });
    expect(parsed.success).toBe(true);
  });
});

describe("filling a template", () => {
  it("drops a lone empty fill-in and trims blank lines at either end", () => {
    expect(fillTemplate("\n\n{{a}}\nHi {{b}}\n{{a}}\n\n", { a: "", b: "you" })).toBe("Hi you");
  });
  it("leaves something that isn't a fill-in as it is", () => {
    expect(fillTemplate("Costs {{price}}", { a: "" })).toBe("Costs {{price}}");
  });
});

describe("the sample booking", () => {
  it("fills every message with something sensible", () => {
    const sample = sampleBooking({
      workspaceName: "The Studio",
      timezone: "America/New_York",
      startsAt: "2027-07-10T17:00:00.000Z",
    });
    for (const key of MESSAGE_KEYS) {
      const email = bookingEmail(
        key,
        sample,
        none,
        sampleExtras(key, sample, "https://app.example", ""),
      );
      expect(email.text).not.toMatch(/\{\{/);
      expect(email.subject).not.toMatch(/\{\{/);
    }
  });
});
