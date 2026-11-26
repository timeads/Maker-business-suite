import { describe, expect, it } from "vitest";
import type { Fetch } from "../connections/types";
import { createTwilioClient } from "./twilio-client";

// Made-up keys of the right shape. Never a real credential.
const ACCESS = {
  accountSid: `AC${"1".repeat(32)}`,
  authToken: "2".repeat(32),
  sender: "+12155550199",
};
const SID = `SM${"3".repeat(32)}`;

function fakeTwilio(answer: { status: number; body?: unknown } | Error) {
  const asked: { url: string; method: string; headers: Record<string, string>; body: string }[] =
    [];
  const fetchImpl = (async (url: unknown, init?: RequestInit) => {
    asked.push({
      url: String(url),
      method: String(init?.method),
      headers: init?.headers as Record<string, string>,
      body: String(init?.body ?? ""),
    });
    if (answer instanceof Error) throw answer;
    return new Response(JSON.stringify(answer.body ?? {}), { status: answer.status });
  }) as unknown as Fetch;
  return { fetchImpl, asked };
}

describe("the Twilio client", () => {
  it("sends one form-encoded text from the workspace's number, with its own keys", async () => {
    const { fetchImpl, asked } = fakeTwilio({ status: 201, body: { sid: SID, status: "queued" } });
    const result = await createTwilioClient(ACCESS, fetchImpl).sendText("+12155550134", "Hi & bye");
    expect(result).toEqual({ outcome: "sent", sid: SID, detail: "" });
    expect(asked).toHaveLength(1);
    expect(asked[0].url).toBe(
      `https://api.twilio.com/2010-04-01/Accounts/${ACCESS.accountSid}/Messages.json`,
    );
    expect(asked[0].method).toBe("POST");
    expect(asked[0].headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
    expect(asked[0].headers.Authorization).toBe(
      `Basic ${Buffer.from(`${ACCESS.accountSid}:${ACCESS.authToken}`).toString("base64")}`,
    );
    expect(Object.fromEntries(new URLSearchParams(asked[0].body))).toEqual({
      To: "+12155550134",
      Body: "Hi & bye",
      From: "+12155550199",
    });
  });

  it("uses a Messaging Service when that is what the business gave", async () => {
    const { fetchImpl, asked } = fakeTwilio({ status: 201, body: { sid: SID } });
    const service = `MG${"4".repeat(32)}`;
    await createTwilioClient({ ...ACCESS, sender: service }, fetchImpl).sendText(
      "+12155550134",
      "x",
    );
    const form = new URLSearchParams(asked[0].body);
    expect(form.get("MessagingServiceSid")).toBe(service);
    expect(form.has("From")).toBe(false);
  });

  it("tells a refusal that may pass from one that won't, in Twilio's words", async () => {
    const busy = fakeTwilio({ status: 429, body: { code: 20429, message: "Too Many Requests" } });
    expect(await createTwilioClient(ACCESS, busy.fetchImpl).sendText("+12155550134", "x")).toEqual({
      outcome: "refused",
      detail: "Twilio said: Too Many Requests (error 20429)",
      code: 20429,
    });
    const stopped = fakeTwilio({
      status: 400,
      body: { code: 21610, message: "Attempt to send to unsubscribed recipient" },
    });
    expect(
      await createTwilioClient(ACCESS, stopped.fetchImpl).sendText("+12155550134", "x"),
    ).toMatchObject({ outcome: "rejected", code: 21610 });
  });

  it("never says a text failed when it can't know: no answer, or Twilio's own trouble, is unsure", async () => {
    const gone = fakeTwilio(new Error("socket hang up"));
    expect(
      (await createTwilioClient(ACCESS, gone.fetchImpl).sendText("+12155550134", "x")).outcome,
    ).toBe("unsure");
    const down = fakeTwilio({ status: 503 });
    expect(
      (await createTwilioClient(ACCESS, down.fetchImpl).sendText("+12155550134", "x")).outcome,
    ).toBe("unsure");
    const odd = fakeTwilio({ status: 201, body: { nothing: true } });
    expect(
      (await createTwilioClient(ACCESS, odd.fetchImpl).sendText("+12155550134", "x")).outcome,
    ).toBe("unsure");
  });

  it("asks nothing for a number it can't text, or with no sender set up", async () => {
    const { fetchImpl, asked } = fakeTwilio({ status: 201, body: { sid: SID } });
    expect((await createTwilioClient(ACCESS, fetchImpl).sendText("2155550134", "x")).outcome).toBe(
      "rejected",
    );
    expect(
      (await createTwilioClient({ ...ACCESS, sender: "" }, fetchImpl).sendText("+12155550134", "x"))
        .outcome,
    ).toBe("refused");
    expect(asked).toHaveLength(0);
  });

  it("never repeats the auth token in what it writes down", async () => {
    const leaky = fakeTwilio({
      status: 400,
      body: { code: 1, message: `Bad token ${ACCESS.authToken}` },
    });
    const result = await createTwilioClient(ACCESS, leaky.fetchImpl).sendText("+12155550134", "x");
    expect(result.detail).not.toContain(ACCESS.authToken);
  });

  it("looks at the account with one GET, and nothing else", async () => {
    const { fetchImpl, asked } = fakeTwilio({
      status: 200,
      body: { friendly_name: "Studio", status: "active", type: "Full" },
    });
    expect(await createTwilioClient(ACCESS, fetchImpl).checkAccount()).toEqual({
      name: "Studio",
      status: "active",
      trial: false,
    });
    expect(asked.map((a) => `${a.method} ${a.url}`)).toEqual([
      `GET https://api.twilio.com/2010-04-01/Accounts/${ACCESS.accountSid}.json`,
    ]);
    const refused = fakeTwilio({ status: 401, body: { code: 20003, message: "Authenticate" } });
    await expect(
      createTwilioClient(ACCESS, refused.fetchImpl).checkAccount(),
    ).rejects.toMatchObject({
      status: 401,
    });
  });

  it("won't be made for something that isn't an Account SID", () => {
    expect(() => createTwilioClient({ ...ACCESS, accountSid: "../../x" })).toThrow();
  });
});
