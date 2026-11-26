import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { deliverEmail, type Delivery } from "../email";
import { DEFAULT_EMAILS } from "./config";
import { drainBookingEmails, emailFor } from "./email-sends";
import type { BookingDetails } from "./emails";
import { DEFAULT_EMAIL_WORDS } from "./words";

const details: BookingDetails = {
  booking_id: "b1",
  tenant_id: "t1",
  status: "confirmed",
  seats: 1,
  amount_cents: 0,
  currency: "USD",
  customer_name: "Sam Shopper",
  customer_email: "sam@example.com",
  oversold: false,
  session_id: "s1",
  starts_at: "2026-07-04T14:00:00Z",
  ends_at: "2026-07-04T16:00:00Z",
  session_cancelled: false,
  service_id: "v1",
  service_name: "Rug Tufting",
  service_kind: "workshop",
  workspace_name: "Alice Rugs",
  workspace_slug: "alice",
  timezone: "America/New_York",
};

function fakeAdmin(claims: object[], finish: (args: Record<string, unknown>) => object | Error) {
  const calls: { fn: string; args: Record<string, unknown> }[] = [];
  const admin = {
    rpc: async (fn: string, args: Record<string, unknown>) => {
      calls.push({ fn, args });
      if (fn === "claim_booking_email_sends") return { data: claims, error: null };
      const out = finish(args);
      return out instanceof Error
        ? { data: null, error: { message: out.message } }
        : { data: out, error: null };
    },
  } as unknown as SupabaseClient;
  return { admin, calls };
}

const claim = (kind: string, id = "e1") => ({
  send_id: id,
  booking_id: "b1",
  tenant_id: "t1",
  kind,
});

function run(
  claims: object[],
  delivery: Delivery | Error,
  finished: object | Error = { status: "sent", final: true, changed: true },
) {
  const { admin, calls } = fakeAdmin(claims, () => finished);
  const alerts: string[] = [];
  const sentEmails: { subject: string; text: string }[] = [];
  const result = drainBookingEmails(admin, {
    configured: () => true,
    details: async () => details,
    settings: async () => ({ ...DEFAULT_EMAILS, reminder_note: "Bring an apron." }),
    words: async () => DEFAULT_EMAIL_WORDS,
    deliver: async (email) => {
      sentEmails.push(email);
      if (delivery instanceof Error) throw delivery;
      return delivery;
    },
    alert: async (_admin, _tenant, _app, text) => {
      alerts.push(text);
    },
  });
  return { result, calls, alerts, sentEmails };
}

describe("sending the booking emails that are due", () => {
  it("claims nothing while email isn't set up, so nothing is used up", async () => {
    const { admin, calls } = fakeAdmin([claim("reminder")], () => ({}));
    expect(await drainBookingEmails(admin, { configured: () => false })).toBe(0);
    expect(calls).toEqual([]);
  });

  it("sends each claim once and writes down that it went", async () => {
    const { result, calls, alerts, sentEmails } = run([claim("reminder")], {
      outcome: "sent",
      detail: "",
    });
    expect(await result).toBe(1);
    expect(sentEmails).toHaveLength(1);
    expect(sentEmails[0].text).toContain("Bring an apron.");
    expect(calls[1]).toEqual({
      fn: "finish_booking_email_send",
      args: { p_send_id: "e1", p_outcome: "sent", p_detail: "" },
    });
    expect(alerts).toEqual([]);
  });

  it("records a refusal and stays quiet while it will be tried again", async () => {
    const { result, calls, alerts } = run(
      [claim("reminder")],
      { outcome: "refused", detail: "The mail service refused it (500)." },
      { status: "failed", final: false, changed: true },
    );
    expect(await result).toBe(0);
    expect(calls[1].args).toMatchObject({ p_outcome: "refused" });
    expect(alerts).toEqual([]);
  });

  it("tells the team when a send is given up on, or may or may not have gone", async () => {
    const failed = run(
      [claim("followup")],
      { outcome: "refused", detail: "The mail service refused it (500)." },
      { status: "failed", final: true, changed: true },
    );
    await failed.result;
    expect(failed.alerts).toHaveLength(1);
    expect(failed.alerts[0]).toContain("thank-you email to Sam Shopper");
    expect(failed.alerts[0]).toContain("couldn't be sent");

    const unsure = run(
      [claim("day_of")],
      { outcome: "unsure", detail: "We never heard back from the mail service." },
      { status: "unsure", final: true, changed: true },
    );
    await unsure.result;
    expect(unsure.calls[1].args).toMatchObject({ p_outcome: "unsure" });
    expect(unsure.alerts[0]).toContain("not sure the day-of reminder");
    expect(unsure.alerts[0]).toContain("haven't sent it again");
  });

  it("a crash before the mail service is asked is a refusal, never a lost email", async () => {
    const { admin, calls } = fakeAdmin([claim("reminder")], () => ({
      status: "failed",
      final: false,
      changed: true,
    }));
    await drainBookingEmails(admin, {
      configured: () => true,
      details: async () => {
        throw new Error("database blip");
      },
      deliver: async () => {
        throw new Error("must not be reached");
      },
      alert: async () => {},
    });
    expect(calls[1].args).toMatchObject({ p_outcome: "refused" });
  });

  it("carries on with the next email when one can't be recorded", async () => {
    let n = 0;
    const { admin, calls } = fakeAdmin([claim("reminder", "e1"), claim("reminder", "e2")], () =>
      n++ === 0 ? new Error("no") : { status: "sent", final: true, changed: true },
    );
    const sent = await drainBookingEmails(admin, {
      configured: () => true,
      details: async () => details,
      settings: async () => DEFAULT_EMAILS,
      words: async () => DEFAULT_EMAIL_WORDS,
      deliver: async () => ({ outcome: "sent", detail: "" }),
      alert: async () => {},
    });
    expect(sent).toBe(1);
    expect(calls.filter((c) => c.fn === "finish_booking_email_send")).toHaveLength(2);
  });

  it("has words for every kind, with the time in the workspace's own zone", () => {
    for (const kind of ["reminder", "day_of", "followup", "cancelled"] as const) {
      const email = emailFor(kind, details, { ...DEFAULT_EMAILS, day_of_note: "Door code 12." });
      expect(email.to).toBe("sam@example.com");
      expect(email.subject).toContain("Rug Tufting");
    }
    const dayOf = emailFor("day_of", details, { ...DEFAULT_EMAILS, day_of_note: "Door code 12." });
    expect(dayOf.text).toContain("Door code 12.");
    expect(dayOf.text).toContain("10:00");
    expect(emailFor("cancelled", details, DEFAULT_EMAILS).text).toContain("has been cancelled");
  });

  it("goes out in the business's own words, with replies to its own address", () => {
    const email = emailFor(
      "reminder",
      details,
      { ...DEFAULT_EMAILS, reminder_note: "Bring an apron." },
      {
        version: 1,
        reply_to: "studio@alice.example",
        messages: {
          reminder: { subject: "Soon: {{workshop}}", body: "Hi {{first_name}}! {{note}}" },
        },
      },
    );
    expect(email).toEqual({
      to: "sam@example.com",
      subject: "Soon: Rug Tufting",
      text: "Hi Sam! Bring an apron.",
      replyTo: "studio@alice.example",
    });
  });

  it("an email whose words can't be read is a refusal, tried again later", async () => {
    const { admin, calls } = fakeAdmin([claim("reminder")], () => ({
      status: "failed",
      final: false,
      changed: true,
    }));
    await drainBookingEmails(admin, {
      configured: () => true,
      details: async () => details,
      settings: async () => DEFAULT_EMAILS,
      words: async () => {
        throw new Error("database blip");
      },
      deliver: async () => {
        throw new Error("must not be reached");
      },
      alert: async () => {},
    });
    expect(calls[1].args).toMatchObject({ p_outcome: "refused" });
  });
});

describe("how a send went", () => {
  const env = { ...process.env };
  afterEach(() => {
    process.env = { ...env };
    vi.restoreAllMocks();
  });
  const message = { to: "sam@example.com", subject: "Hi", text: "Hello" };
  const on = () => {
    process.env.POSTMARK_SERVER_TOKEN = "test";
    process.env.EMAIL_FROM = "studio@example.com";
    vi.spyOn(console, "error").mockImplementation(() => {});
  };
  const answer = (status: number, body: object = {}) =>
    (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

  it("is off when email isn't set up", async () => {
    delete process.env.POSTMARK_SERVER_TOKEN;
    expect((await deliverEmail(message, answer(200))).outcome).toBe("off");
  });

  it("tells sent, refused and a dead address apart", async () => {
    on();
    expect((await deliverEmail(message, answer(200))).outcome).toBe("sent");
    expect((await deliverEmail(message, answer(500))).outcome).toBe("refused");
    expect((await deliverEmail(message, answer(422, { ErrorCode: 400 }))).outcome).toBe("refused");
    expect((await deliverEmail(message, answer(422, { ErrorCode: 406 }))).outcome).toBe("rejected");
    expect((await deliverEmail(message, answer(422, { ErrorCode: 300 }))).outcome).toBe("rejected");
  });

  it("passes the business's reply-to address along, and only a plain one", async () => {
    on();
    const bodies: Record<string, unknown>[] = [];
    const capture = (async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    await deliverEmail({ ...message, replyTo: "hello@studio.example" }, capture);
    await deliverEmail({ ...message, replyTo: "a@b.example, c@d.example" }, capture);
    await deliverEmail(message, capture);
    expect(bodies[0].ReplyTo).toBe("hello@studio.example");
    expect(bodies[1]).not.toHaveProperty("ReplyTo");
    expect(bodies[2]).not.toHaveProperty("ReplyTo");
  });

  it("is unsure when the answer never came, unless the request never left", async () => {
    on();
    const dropped = (async () => {
      throw new TypeError("fetch failed", { cause: { code: "ECONNRESET" } });
    }) as unknown as typeof fetch;
    const neverLeft = (async () => {
      throw new TypeError("fetch failed", { cause: { code: "ENOTFOUND" } });
    }) as unknown as typeof fetch;
    expect((await deliverEmail(message, dropped)).outcome).toBe("unsure");
    expect((await deliverEmail(message, neverLeft)).outcome).toBe("refused");
  });
});
