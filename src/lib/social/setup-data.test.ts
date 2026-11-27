import { afterEach, describe, expect, it, vi } from "vitest";
import "../connections/registry";
import { linkedinConfigured } from "../connections/providers/linkedin";
import { tiktokConfigured } from "../connections/providers/tiktok";
import { networksOffered } from "./setup-data";

describe("networksOffered", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("offers TikTok and LinkedIn by the same keys as their providers", () => {
    for (const [key, secret, on] of [
      ["", "", false],
      ["k", "", false],
      ["k", "s", true],
    ] as const) {
      vi.stubEnv("TIKTOK_CLIENT_KEY", key);
      vi.stubEnv("TIKTOK_CLIENT_SECRET", secret);
      vi.stubEnv("LINKEDIN_CLIENT_ID", key);
      vi.stubEnv("LINKEDIN_CLIENT_SECRET", secret);
      expect(networksOffered.tiktok()).toBe(tiktokConfigured());
      expect(networksOffered.linkedin()).toBe(linkedinConfigured());
      expect(networksOffered.tiktok()).toBe(on);
    }
  });
});
