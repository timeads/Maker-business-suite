import { describe, expect, it } from "vitest";
import { safeNextPath } from "./safe-redirect";

describe("safeNextPath", () => {
  it("keeps same-site paths", () => {
    expect(safeNextPath("/w/alice-rugs/settings?tab=team")).toBe("/w/alice-rugs/settings?tab=team");
    expect(safeNextPath("/invite/abc123")).toBe("/invite/abc123");
  });

  it("refuses anything that could leave the site", () => {
    for (const bad of [
      "https://evil.test",
      "//evil.test",
      "/\\evil.test",
      "javascript:alert(1)",
      "evil",
      "",
      null,
      undefined,
      42,
      "/ok\nSet-Cookie: x",
    ]) {
      expect(safeNextPath(bad)).toBe("/app");
    }
  });
});
