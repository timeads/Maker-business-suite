import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { allSettingsPaths } from "./nav";
import {
  MOVED_SETTINGS,
  SHIPPING_ANCHORS,
  movedSettingsPath,
  shippingAnchorPath,
} from "./redirects";

const WORKSPACE = join(process.cwd(), "src/app/w/[slug]");
/** A route's page, in the padded group or beside it. */
const hasPage = (path: string) =>
  existsSync(join(WORKSPACE, "(app)", path, "page.tsx")) ||
  existsSync(join(WORKSPACE, path, "page.tsx"));

describe("moved settings", () => {
  it("sends every old address to a page that exists", () => {
    expect(MOVED_SETTINGS.length).toBeGreaterThan(0);
    for (const [, to] of MOVED_SETTINGS) {
      expect(hasPage(to), to).toBe(true);
      expect(allSettingsPaths().map((path) => `settings/${path}`)).toContain(to);
    }
  });

  it("has nothing left at an old address, so the redirect is the only answer", () => {
    for (const [from] of MOVED_SETTINGS) expect(hasPage(from), from).toBe(false);
  });

  it("never points an old address at another old address", () => {
    const old = new Set(MOVED_SETTINGS.map(([from]) => from));
    for (const [, to] of MOVED_SETTINGS) expect(old.has(to)).toBe(false);
  });

  it("maps each old path inside its own workspace", () => {
    expect(movedSettingsPath("/w/alice-rugs/shipping/settings")).toBe(
      "/w/alice-rugs/settings/shipping",
    );
    expect(movedSettingsPath("/w/alice-rugs/stock/settings")).toBe("/w/alice-rugs/settings/stock");
    expect(movedSettingsPath("/w/alice-rugs/stock/settings/import")).toBe(
      "/w/alice-rugs/settings/stock/import",
    );
    expect(movedSettingsPath("/w/alice-rugs/stock/balances/email")).toBe(
      "/w/alice-rugs/settings/stock/bills",
    );
    expect(movedSettingsPath("/w/alice-rugs/stock/michaels/settings")).toBe(
      "/w/alice-rugs/settings/stock/michaels",
    );
    expect(movedSettingsPath("/w/alice-rugs/bookings/settings")).toBe(
      "/w/alice-rugs/settings/bookings",
    );
    expect(movedSettingsPath("/w/alice-rugs/helpdesk/settings/")).toBe(
      "/w/alice-rugs/settings/helpdesk",
    );
  });

  it("leaves everything else alone", () => {
    for (const path of [
      "/w/alice-rugs/settings",
      "/w/alice-rugs/settings/shipping",
      "/w/alice-rugs/shipping",
      "/w/alice-rugs/shipping/settings/extra",
      "/w/alice-rugs/stock/balances",
      "/w/settings/stock",
      "/shipping/settings",
      "/api/w/x/shipping/settings",
    ]) {
      expect(movedSettingsPath(path), path).toBeNull();
    }
    // A workspace that happens to be called "shipping" is still a workspace.
    expect(movedSettingsPath("/w/shipping/settings")).toBeNull();
  });
});

describe("Shipping's old anchors", () => {
  it("each lead to a screen that exists, with the anchor kept", () => {
    for (const [anchor, path] of Object.entries(SHIPPING_ANCHORS)) {
      expect(hasPage(`settings/${path}`), path).toBe(true);
      expect(shippingAnchorPath("alice", `#${anchor}`)).toBe(`/w/alice/settings/${path}#${anchor}`);
    }
  });
  it("sends the print buttons' old link to the printing screen", () => {
    expect(shippingAnchorPath("alice", "#printing")).toBe(
      "/w/alice/settings/shipping/printing#printing",
    );
  });
  it("ignores no anchor, an unknown one, and names that only look like one", () => {
    expect(shippingAnchorPath("alice", "")).toBeNull();
    expect(shippingAnchorPath("alice", "#boxes")).toBeNull();
    expect(shippingAnchorPath("alice", "#constructor")).toBeNull();
  });
});
