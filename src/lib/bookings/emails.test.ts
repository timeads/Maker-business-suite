import { describe, expect, it } from "vitest";
import { confirmationEmail, dateChangedEmail, type BookingDetails } from "./emails";

const details: BookingDetails = {
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

describe("where a workshop happens, in the emails", () => {
  it("is shown under the time when the business has said, and left out when not", () => {
    const withPlace = confirmationEmail({ ...details, location: "Studio 2" }, "https://x/y");
    expect(withPlace.text).toMatch(/When: .*\nWhere: Studio 2\n/);
    expect(confirmationEmail(details, "https://x/y").text).not.toMatch(/Where:/);
    expect(confirmationEmail({ ...details, location: "  " }, "https://x/y").text).not.toMatch(
      /Where:/,
    );
  });
});

describe("a date moved to a new time", () => {
  it("gives the new time first, the old one after, and says the place is kept", () => {
    const email = dateChangedEmail(
      details,
      { ...details, starts_at: "2027-03-13T15:00:00.000Z", ends_at: "2027-03-13T17:00:00.000Z" },
      { starts_at: details.starts_at, ends_at: details.ends_at },
    );
    expect(email.to).toBe("pat@example.com");
    expect(email.subject).toBe("New time: Rug tufting with The Studio");
    expect(email.text).toContain("Hi Pat,");
    expect(email.text).toContain("Your place is kept.");
    expect(email.text.indexOf("New time:")).toBeLessThan(email.text.indexOf("It was:"));
    expect(email.text).toMatch(/New time: .*13/);
    expect(email.text).toMatch(/It was: .*6/);
  });
});
