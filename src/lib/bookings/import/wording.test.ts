import { describe, expect, it } from "vitest";
import { DEFAULT_TEXT_SETTINGS } from "../../texts/config";
import { DEFAULT_EMAIL_WORDS } from "../words";
import { readWording, translate } from "./wording";

// Made-up wording in the earlier app's shape; never a real business's.
const current = { emailWords: DEFAULT_EMAIL_WORDS, textSettings: DEFAULT_TEXT_SETTINGS };
const csv = (rows: string[][]) =>
  [["key", "channel", "subject", "body"], ...rows]
    .map((row) => row.map((cell) => `"${cell.replace(/"/g, '""')}"`).join(","))
    .join("\n");

describe("translating the earlier app's fill-ins", () => {
  it("renames each fill-in, and turns the seats count into places", () => {
    expect(
      translate(
        "Hi {{first_name}} ({{full_name}}): {{workshop_title}} on {{session_date}} at {{session_time}}, {{location}}. {{seats}} seat(s).",
        {
          channel: "email",
          message: "reminder",
        },
      ),
    ).toEqual({
      text: "Hi {{first_name}} ({{name}}): {{workshop}} on {{date}} at {{time}}, {{place}}. {{places}}.",
      notes: [],
    });
    expect(translate("{{ seats }} for you", { channel: "text", message: "reminder" }).text).toBe(
      "{{places}} for you",
    );
  });

  it("keeps the change link only in a confirmation email, and says what it took out", () => {
    expect(
      translate("Change: {{manage_link}}", { channel: "email", message: "confirmation" }).text,
    ).toBe("Change: {{manage_link}}");
    const reminder = translate("Questions? {{manage_link}}", {
      channel: "email",
      message: "reminder",
    });
    expect(reminder.text).toBe("Questions?");
    expect(reminder.notes[0]).toMatch(/manage_link/);
    const odd = translate("Hello {{nickname}}", { channel: "text", message: "reminder" });
    expect(odd).toEqual({
      text: "Hello",
      notes: ["{{nickname}} has no match here, so it was taken out."],
    });
  });

  it("takes markup out, keeping its line breaks", () => {
    const html = translate("<p>Hi {{first_name}},</p><p>See you<br>soon</p>", {
      channel: "email",
      message: "reminder",
    });
    expect(html.text).toBe("Hi {{first_name}},\n\nSee you\nsoon");
    expect(html.notes[0]).toMatch(/markup/);
  });
});

describe("reading the wording file", () => {
  it("fills both configs, mapping each message onto the suite's", () => {
    const read = readWording(
      csv([
        [
          "reminder_48h",
          "email",
          "Soon: {{workshop_title}}",
          "Hi {{first_name}}, see you {{session_date}}.",
        ],
        ["reminder_48h", "sms", "", "Reminder: {{workshop_title}} at {{session_time}}"],
        ["booking_cancelled", "email", "Cancelled", "Sorry {{first_name}}."],
        ["booking_rescheduled", "text", "", "Moved to {{session_date}}"],
      ]),
      current,
    );
    if (!read.ok) throw new Error(read.error);
    expect(read.problems).toEqual([]);
    expect(read.emailWords.messages.reminder).toEqual({
      subject: "Soon: {{workshop}}",
      body: "Hi {{first_name}}, see you {{date}}.",
    });
    // One cancellation notice there; a person's cancel and a shop refund here.
    expect(read.emailWords.messages.booking_cancelled?.body).toBe("Sorry {{first_name}}.");
    expect(read.emailWords.messages.shop_cancelled?.body).toBe("Sorry {{first_name}}.");
    expect(read.textSettings.messages.reminder.body).toBe("Reminder: {{workshop}} at {{time}}");
    expect(read.textSettings.messages.moved.body).toBe("Moved to {{date}}");
    // Words only: no text is switched on by bringing wording across.
    expect(read.textSettings.on).toBe(false);
    expect(read.textSettings.messages.reminder.on).toBe(false);
    expect(read.rows.map((r) => r.into)).toEqual([
      ["reminder"],
      ["reminder"],
      ["booking_cancelled", "shop_cancelled"],
      ["moved"],
    ]);
  });

  it("reports what it can't use by line, and changes nothing for those rows", () => {
    const read = readWording(
      csv([
        ["owner_new_booking", "email", "New booking", "Someone booked."],
        ["birthday", "email", "Hi", "Hello"],
        ["confirmation", "fax", "Hi", "Hello"],
        ["confirmation", "email", "", "No subject"],
        ["confirmation", "text", "", ""],
        ["followup_24h", "email", "Thanks", "Thanks {{first_name}}"],
        ["followup_24h", "email", "Again", "Twice"],
      ]),
      current,
    );
    if (!read.ok) throw new Error(read.error);
    expect(read.problems.map((p) => p.line)).toEqual([2, 3, 4, 5, 6, 8]);
    expect(read.problems[1].reason).toContain("birthday");
    expect(read.emailWords.messages.confirmation).toBeUndefined();
    expect(read.emailWords.messages.followup?.subject).toBe("Thanks");
  });

  it("needs its columns", () => {
    expect(readWording("name,words\nx,y", current)).toMatchObject({ ok: false });
  });
});
