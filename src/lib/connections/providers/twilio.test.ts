import { describe, expect, it } from "vitest";
import type { Fetch } from "../types";
import { createTwilioAdapter } from "./twilio";

// Made-up keys of the right shape. Never a real credential.
const SID = `AC${"5".repeat(32)}`;
const TOKEN = "6".repeat(32);

function twilio(status: number, body: unknown) {
  const asked: string[] = [];
  const fetchImpl = (async (url: unknown, init?: RequestInit) => {
    asked.push(`${init?.method} ${String(url)}`);
    return new Response(JSON.stringify(body), { status });
  }) as unknown as Fetch;
  return { adapter: createTwilioAdapter(fetchImpl), asked };
}

describe("connecting Twilio", () => {
  it("checks the keys with one look at the account and keeps the token in the token", async () => {
    const { adapter, asked } = twilio(200, {
      friendly_name: "Studio",
      status: "active",
      type: "Full",
    });
    const account = await adapter.connectWithKey!({
      account_sid: SID,
      auth_token: TOKEN,
      sender: "+1 (215) 555-0199",
    });
    expect(asked).toEqual([`GET https://api.twilio.com/2010-04-01/Accounts/${SID}.json`]);
    expect(account.externalAccountId).toBe(SID);
    expect(account.token).toEqual({ access_token: TOKEN, secrets: { sender: "+12155550199" } });
    // Nothing secret where members can read it.
    expect(JSON.stringify(account.metadata)).not.toContain(TOKEN);
    expect(account.metadata).toEqual({
      sender: "+12155550199",
      sender_kind: "number",
      trial: false,
    });
  });

  it("explains what's wrong before asking Twilio anything", async () => {
    const { adapter, asked } = twilio(200, {});
    await expect(
      adapter.connectWithKey!({ account_sid: "AC123", auth_token: TOKEN, sender: "+12155550199" }),
    ).rejects.toThrow(/starts with AC/);
    await expect(
      adapter.connectWithKey!({ account_sid: SID, auth_token: "short", sender: "+12155550199" }),
    ).rejects.toThrow(/auth token/);
    // A sender without its country code is refused, never guessed.
    await expect(
      adapter.connectWithKey!({ account_sid: SID, auth_token: TOKEN, sender: "2155550199" }),
    ).rejects.toThrow(/country code/);
    expect(asked).toEqual([]);
  });

  it("takes a Messaging Service id as the sender", async () => {
    const { adapter } = twilio(200, { status: "active", type: "Trial" });
    const service = `MG${"7".repeat(32)}`;
    const account = await adapter.connectWithKey!({
      account_sid: SID,
      auth_token: TOKEN,
      sender: service,
    });
    expect(account.metadata).toMatchObject({
      sender: service,
      sender_kind: "service",
      trial: true,
    });
    expect(adapter.statusNote!(account.metadata ?? {}, "2026-11-26")?.tone).toBe("waiting");
  });

  it("says so when Twilio doesn't accept the keys, or the account can't send", async () => {
    await expect(
      twilio(401, { code: 20003 }).adapter.connectWithKey!({
        account_sid: SID,
        auth_token: TOKEN,
        sender: "+12155550199",
      }),
    ).rejects.toThrow(/didn't accept/);
    await expect(
      twilio(200, { status: "suspended" }).adapter.connectWithKey!({
        account_sid: SID,
        auth_token: TOKEN,
        sender: "+12155550199",
      }),
    ).rejects.toThrow(/suspended/);
  });
});
