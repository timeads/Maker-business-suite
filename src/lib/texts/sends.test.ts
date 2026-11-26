import { describe, expect, it } from "vitest";
import { DEFAULT_TEXT_SETTINGS, parseTextSettings } from "./config";
import { drainBookingTexts, type TextSendDeps } from "./sends";
import type { TextDelivery } from "./twilio-client";

const TENANT = "11111111-1111-4111-8111-111111111111";
const details = {
  booking_id: "b1",
  tenant_id: TENANT,
  customer_name: "Sam Shopper",
  service_name: "Rug Tufting",
  workspace_name: "Wild Thread",
  starts_at: "2027-01-16T19:00:00.000Z",
  ends_at: "2027-01-16T21:00:00.000Z",
  timezone: "America/New_York",
  seats: 1,
  location: "",
} as never;
// Made-up keys of the right shape. Never a real credential.
const ACCESS = {
  accountSid: `AC${"1".repeat(32)}`,
  authToken: "2".repeat(32),
  sender: "+12155550199",
};

function fakeAdmin(claims: object[]) {
  const finished: Record<string, unknown>[] = [];
  const admin = {
    rpc: async (fn: string, args: Record<string, unknown>) => {
      if (fn === "claim_booking_text_sends") return { data: claims, error: null };
      if (fn === "finish_booking_text_send") {
        finished.push(args);
        const status =
          args.p_outcome === "sent" ? "sent" : args.p_outcome === "unsure" ? "unsure" : "failed";
        return { data: { status, final: true, changed: true }, error: null };
      }
      return { data: null, error: null };
    },
  } as never;
  return { admin, finished };
}

const claim = (id: string, kind = "reminder") => ({
  send_id: id,
  booking_id: `booking-${id}`,
  tenant_id: TENANT,
  kind,
  tries: 1,
});

function deps(over: Partial<TextSendDeps> = {}) {
  const sent: { to: string; body: string }[] = [];
  const alerts: string[] = [];
  const base: TextSendDeps = {
    open: async () => true,
    details: async () => details,
    settings: async () => parseTextSettings({ version: 1, on: true }),
    target: async () => ({
      phone: "(215) 555-0134",
      opt_in: true,
      created_at: "2026-12-01T00:00:00Z",
    }),
    optedOut: async () => null,
    access: async () => ACCESS,
    send: async (_access, to, body): Promise<TextDelivery> => {
      sent.push({ to, body });
      return { outcome: "sent", sid: `SM${"3".repeat(32)}`, detail: "" };
    },
    alert: async (_a, _t, _app, text) => void alerts.push(text),
  };
  return { deps: { ...base, ...over }, sent, alerts };
}

describe("sending booking texts", () => {
  it("sends the workspace's words to the number in full form, once, and writes down Twilio's id", async () => {
    const { admin, finished } = fakeAdmin([claim("s1")]);
    const { deps: d, sent } = deps();
    expect(await drainBookingTexts(admin, d)).toBe(1);
    expect(sent).toEqual([
      {
        to: "+12155550134",
        body: "Reminder from Wild Thread: Rug Tufting is coming up on Saturday, January 16 at 2:00 PM ET. See you soon! Reply STOP to opt out.",
      },
    ]);
    expect(finished).toEqual([
      { p_send_id: "s1", p_outcome: "sent", p_detail: "", p_provider_id: `SM${"3".repeat(32)}` },
    ]);
  });

  it("sends nothing to a number that replied STOP since booking, or one it can't read", async () => {
    const { admin, finished } = fakeAdmin([claim("s1"), claim("s2")]);
    let n = 0;
    const { deps: d, sent } = deps({
      optedOut: async () => "2026-12-05T00:00:00Z",
      target: async () => {
        n += 1;
        return n === 1
          ? { phone: "+12155550134", opt_in: true, created_at: "2026-12-01T00:00:00Z" }
          : { phone: "07700 900123", opt_in: true, created_at: "2026-12-01T00:00:00Z" };
      },
    });
    expect(await drainBookingTexts(admin, d)).toBe(0);
    expect(sent).toEqual([]);
    expect(finished.map((f) => [f.p_outcome, f.p_detail])).toEqual([
      ["rejected", "They replied STOP, so nothing was sent."],
      [
        "rejected",
        "We couldn't read the number they gave as a mobile number, so nothing was sent.",
      ],
    ]);
  });

  it("texts someone again who ticked the box on a booking made after an old STOP", async () => {
    const { admin } = fakeAdmin([claim("s1")]);
    const { deps: d, sent } = deps({ optedOut: async () => "2026-11-01T00:00:00Z" });
    await drainBookingTexts(admin, d);
    expect(sent).toHaveLength(1);
  });

  it("sends nothing off the plan, and tells the team when one couldn't go or might not have", async () => {
    const off = fakeAdmin([claim("s1")]);
    const closed = deps({ open: async () => false });
    await drainBookingTexts(off.admin, closed.deps);
    expect(closed.sent).toEqual([]);
    expect(off.finished[0]).toMatchObject({ p_outcome: "rejected" });

    const odd = fakeAdmin([claim("s1"), claim("s2")]);
    let n = 0;
    const told = deps({
      send: async (): Promise<TextDelivery> =>
        (n += 1) === 1
          ? { outcome: "unsure", detail: "We didn't hear back from Twilio.", code: null }
          : { outcome: "refused", detail: "Twilio said: busy", code: 20429 },
    });
    await drainBookingTexts(odd.admin, told.deps);
    expect(odd.finished.map((f) => f.p_outcome)).toEqual(["unsure", "refused"]);
    expect(told.alerts).toHaveLength(2);
    expect(told.alerts[0]).toContain("not sure");
    expect(told.alerts[1]).toContain("Twilio said: busy");
  });

  it("counts a failure before Twilio as a refusal it may try again, never as sent", async () => {
    const { admin, finished } = fakeAdmin([claim("s1")]);
    const { deps: d } = deps({
      access: async () => {
        throw new Error("twilio is not connected");
      },
      settings: async () => DEFAULT_TEXT_SETTINGS,
    });
    await drainBookingTexts(admin, d);
    expect(finished[0]).toMatchObject({ p_outcome: "refused" });
  });
});
