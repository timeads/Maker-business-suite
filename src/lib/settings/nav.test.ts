import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Feature } from "../entitlements";
import {
  activeSettings,
  allSettingsPaths,
  filterSettings,
  settingsHref,
  settingsNav,
  type SettingsGroup,
  type SettingsViewer,
} from "./nav";

const EVERYTHING: Feature[] = [
  "module.messages",
  "module.dashboard",
  "module.helpdesk",
  "module.bookings",
  "module.social",
  "module.stock",
  "module.shipping",
  "michaels",
];

function viewer(over: Partial<SettingsViewer> & { features?: Feature[] } = {}): SettingsViewer {
  const { features = EVERYTHING, ...rest } = over;
  return {
    can: (feature) => features.includes(feature),
    manager: true,
    canWrite: true,
    gmailOrders: true,
    ...rest,
  };
}

const ids = (groups: SettingsGroup[], name: string) =>
  (groups.find((group) => group.name === name)?.sections ?? []).map((section) => section.id);
const kids = (groups: SettingsGroup[], id: string) =>
  (
    groups.flatMap((group) => group.sections).find((section) => section.id === id)?.children ?? []
  ).map((child) => child.id);

describe("settingsNav", () => {
  it("gives an owner on a full plan the workspace's sections and every tool", () => {
    const nav = settingsNav(viewer());
    expect(nav.map((group) => group.name)).toEqual(["Workspace", "Tools"]);
    expect(ids(nav, "Workspace")).toEqual([
      "workspace",
      "team",
      "billing",
      "brand",
      "look",
      "connections",
    ]);
    expect(ids(nav, "Tools")).toEqual([
      "shipping",
      "stock",
      "bookings",
      "helpdesk",
      "social",
      "money",
      "messages",
      "assistant",
    ]);
    expect(kids(nav, "shipping")).toEqual([
      "shipping.from",
      "shipping.rules",
      "shipping.slip",
      "shipping.printing",
    ]);
    expect(kids(nav, "bookings")).toEqual([
      "bookings.emails",
      "bookings.shop-page",
      "bookings.import",
    ]);
    expect(kids(nav, "helpdesk")).toEqual([
      "helpdesk.desk",
      "helpdesk.channels",
      "helpdesk.auto-replies",
      "helpdesk.manual",
      "helpdesk.help-centre",
    ]);
    expect(kids(nav, "stock")).toEqual([
      "stock.planning",
      "stock.seasons",
      "stock.order-emails",
      "stock.bills",
      "stock.import",
      "stock.michaels",
    ]);
  });

  it("leaves out a tool the plan doesn't include", () => {
    const nav = settingsNav(viewer({ features: ["module.helpdesk", "module.messages"] }));
    expect(ids(nav, "Tools")).toEqual(["helpdesk", "messages", "assistant"]);
  });

  it("shows only the workspace and the Assistant before a plan is picked", () => {
    const nav = settingsNav(viewer({ features: [] }));
    expect(ids(nav, "Workspace")).toHaveLength(6);
    expect(ids(nav, "Tools")).toEqual(["assistant"]);
  });

  it("gives the rest of the team Shipping's printing only, and opens Shipping on it", () => {
    const nav = settingsNav(viewer({ manager: false }));
    expect(kids(nav, "shipping")).toEqual(["shipping.printing"]);
    const shipping = nav[1].sections.find((section) => section.id === "shipping");
    expect(shipping?.path).toBe("shipping/printing");
  });

  it("keeps the manager-only Stock screens from the rest of the team", () => {
    const nav = settingsNav(viewer({ manager: false }));
    expect(kids(nav, "stock")).toEqual(["stock.planning", "stock.seasons", "stock.michaels"]);
    expect(kids(nav, "bookings")).toEqual(["bookings.emails", "bookings.shop-page"]);
  });

  it("treats a manager of a read-only workspace as before: no Shipping forms, no order emails", () => {
    const nav = settingsNav(viewer({ canWrite: false }));
    expect(kids(nav, "shipping")).toEqual(["shipping.printing"]);
    expect(kids(nav, "stock")).toEqual([
      "stock.planning",
      "stock.seasons",
      "stock.bills",
      "stock.import",
      "stock.michaels",
    ]);
  });

  it("offers order emails only where sending from Gmail is set up on the site", () => {
    expect(kids(settingsNav(viewer({ gmailOrders: false })), "stock")).not.toContain(
      "stock.order-emails",
    );
  });

  it("shows Michaels under Stock only with its own entitlement", () => {
    const without = EVERYTHING.filter((feature) => feature !== "michaels");
    expect(kids(settingsNav(viewer({ features: without })), "stock")).not.toContain(
      "stock.michaels",
    );
    // Michaels alone, without Stock on the plan, shows nothing.
    expect(ids(settingsNav(viewer({ features: ["michaels"] })), "Tools")).toEqual(["assistant"]);
  });

  it("has a page for every path it can link to", () => {
    const root = join(process.cwd(), "src/app/w/[slug]/(app)/settings");
    for (const path of allSettingsPaths()) {
      expect(existsSync(join(root, path, "page.tsx")), `settings/${path}`).toBe(true);
    }
    expect(existsSync(join(process.cwd(), "src/app/w/[slug]/(app)/connections/page.tsx"))).toBe(
      true,
    );
  });
});

describe("settingsHref", () => {
  it("builds addresses inside the workspace", () => {
    expect(settingsHref("alice", { path: "" })).toBe("/w/alice/settings");
    expect(settingsHref("alice", { path: "stock/import" })).toBe("/w/alice/settings/stock/import");
    expect(settingsHref("alice", { path: "", outside: "connections" })).toBe(
      "/w/alice/connections",
    );
  });
});

describe("activeSettings", () => {
  const nav = settingsNav(viewer());
  it("lights the first page for the bare address, and nothing else", () => {
    expect(activeSettings(nav, "")).toEqual({ section: "workspace", child: null });
    expect(activeSettings(nav, "/")).toEqual({ section: "workspace", child: null });
  });
  it("lights the tool and its screen", () => {
    expect(activeSettings(nav, "/shipping")).toEqual({
      section: "shipping",
      child: "shipping.from",
    });
    expect(activeSettings(nav, "/shipping/rules")).toEqual({
      section: "shipping",
      child: "shipping.rules",
    });
  });
  it("prefers the longest match, so a screen under Stock isn't taken for Planning", () => {
    expect(activeSettings(nav, "/stock/import")).toEqual({
      section: "stock",
      child: "stock.import",
    });
    expect(activeSettings(nav, "/stock")).toEqual({ section: "stock", child: "stock.planning" });
  });
  it("doesn't confuse look-alike paths", () => {
    expect(activeSettings(nav, "/teamwork")).toEqual({ section: null, child: null });
  });
});

describe("filterSettings", () => {
  const nav = settingsNav(viewer());
  const found = (query: string) =>
    filterSettings(nav, query).flatMap((group) =>
      group.sections.flatMap((section) => [
        section.id,
        ...(section.children ?? []).map((child) => child.id),
      ]),
    );

  it("changes nothing for an empty search", () => {
    expect(filterSettings(nav, "  ")).toBe(nav);
  });
  it("finds a section by its name, whatever the capitals", () => {
    expect(found("BRAND kit")).toEqual(["brand"]);
  });
  it("finds a screen by a keyword and keeps it under its tool", () => {
    expect(found("zebra")).toEqual(["shipping", "shipping.printing"]);
    expect(found("csv")).toEqual(["stock", "stock.import", "bookings", "bookings.import"]);
  });
  it("opens the tool on the screen that matched", () => {
    const [group] = filterSettings(nav, "zebra");
    expect(group.sections[0].path).toBe("shipping/printing");
  });
  it("keeps every screen when the tool itself is what was typed", () => {
    expect(found("shipping")).toEqual([
      "shipping",
      "shipping.from",
      "shipping.rules",
      "shipping.slip",
      "shipping.printing",
    ]);
  });
  it("needs every word, and lets the tool's name be one of them", () => {
    expect(found("stock holidays")).toEqual(["stock", "stock.seasons"]);
    expect(found("stock zebra")).toEqual([]);
  });
  it("finds things in more than one place", () => {
    expect(found("signature")).toEqual(["shipping", "shipping.from", "shipping.rules"]);
  });
  it("never finds what the person can't see", () => {
    const member = settingsNav(viewer({ manager: false }));
    expect(filterSettings(member, "csv")).toEqual([]);
  });
  it("drops a group with nothing left in it", () => {
    expect(filterSettings(nav, "zebra").map((group) => group.name)).toEqual(["Tools"]);
  });
});
