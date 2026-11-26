import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { signedString, twilioSignature, validTwilioSignature } from "./signature";

// A made-up token of the right shape, never a real one.
const TOKEN = "0".repeat(16) + "f".repeat(16);
const URL_ = "https://app.example.test/api/webhooks/twilio";
const form = () =>
  new URLSearchParams({
    MessageSid: `SM${"a".repeat(32)}`,
    AccountSid: `AC${"b".repeat(32)}`,
    From: "+12155550134",
    To: "+12155550199",
    Body: "STOP",
  });

describe("Twilio's request signature", () => {
  it("signs the address followed by every field, sorted by name, with nothing between", () => {
    const params = form();
    expect(signedString(URL_, params)).toBe(
      `${URL_}AccountSidAC${"b".repeat(32)}BodySTOPFrom+12155550134MessageSidSM${"a".repeat(32)}To+12155550199`,
    );
    const expected = createHmac("sha1", TOKEN).update(signedString(URL_, params)).digest("base64");
    expect(twilioSignature(TOKEN, URL_, params)).toBe(expected);
  });

  it("accepts Twilio's own signature and nothing else", () => {
    const params = form();
    const good = twilioSignature(TOKEN, URL_, params);
    expect(validTwilioSignature(TOKEN, URL_, params, good)).toBe(true);
    // Another token, another address, a changed field, or no signature at all.
    expect(validTwilioSignature("1".repeat(32), URL_, params, good)).toBe(false);
    expect(validTwilioSignature(TOKEN, `${URL_}?x=1`, params, good)).toBe(false);
    const changed = form();
    changed.set("Body", "START");
    expect(validTwilioSignature(TOKEN, URL_, changed, good)).toBe(false);
    expect(validTwilioSignature(TOKEN, URL_, params, null)).toBe(false);
    expect(validTwilioSignature(TOKEN, URL_, params, "not base64!")).toBe(false);
    expect(validTwilioSignature("", URL_, params, good)).toBe(false);
  });

  it("includes the query of the address Twilio was given", () => {
    const params = form();
    const withQuery = `${URL_}?w=1`;
    expect(
      validTwilioSignature(TOKEN, withQuery, params, twilioSignature(TOKEN, withQuery, params)),
    ).toBe(true);
  });

  it("accepts the address with the standard port written out, as a proxy may give it", () => {
    const params = form();
    const signed = twilioSignature(
      TOKEN,
      "https://app.example.test:443/api/webhooks/twilio",
      params,
    );
    expect(validTwilioSignature(TOKEN, URL_, params, signed)).toBe(true);
  });

  it("keeps every value of a field that comes more than once", () => {
    const params = new URLSearchParams([
      ["b", "2"],
      ["a", "z"],
      ["a", "y"],
    ]);
    expect(signedString("u", params)).toBe("uayazb2");
  });
});
