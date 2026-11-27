import { describe, expect, it } from "vitest";
import type { Feature } from "../entitlements";
import {
  HELPDESK_TAGS_GROUP,
  activeIn,
  buildNav,
  filterMenu,
  HELPDESK_FOLDERS_GROUP,
  HELPDESK_VIEWS_GROUP,
  helpdeskFolderItems,
  helpdeskSavedViewItems,
  helpdeskTagItems,
  hrefFor,
  placeName,
  toolAt,
  withExtras,
  type NavTool,
  type NavViewer,
} from "./model";

const EVERYTHING: Feature[] = [
  "module.messages",
  "module.dashboard",
  "module.helpdesk",
  "module.bookings",
  "module.social",
  "module.stock",
  "module.shipping",
  "michaels",
  "texts",
];

function viewer(over: Partial<NavViewer> & { features?: Feature[] } = {}): NavViewer {
  const { features = EVERYTHING, ...rest } = over;
  return {
    can: (feature) => features.includes(feature),
    manager: true,
    canWrite: true,
    gmailOrders: true,
    michaels: false,
    ...rest,
  };
}

const tool = (tools: NavTool[], key: string) => tools.find((one) => one.key === key)!;
const labels = (one: NavTool) => one.menu.flatMap((group) => group.items.map((i) => i.label));
const at = (path: string, query: Record<string, string> = {}) => ({ path, query });

describe("buildNav: the rail", () => {
  it("lists Home, Assistant, every tool on the plan, then Connections and Settings", () => {
    expect(buildNav(viewer()).map((one) => one.key)).toEqual([
      "home",
      "assistant",
      "messages",
      "dashboard",
      "helpdesk",
      "bookings",
      "social",
      "stock",
      "shipping",
      "connections",
      "settings",
    ]);
  });

  it("keeps a tool that isn't on the plan on the rail, locked and with no menu", () => {
    const tools = buildNav(viewer({ features: ["module.dashboard", "module.helpdesk"] }));
    expect(tools.filter((one) => one.state === "open" && one.place === "tools")).toHaveLength(2);
    const stock = tool(tools, "stock");
    expect(stock.state).toBe("locked");
    expect(stock.menu).toEqual([]);
    expect(stock.panel).toBe("none");
    // Open tools come first, as on the old rail.
    expect(tools.map((one) => one.key).slice(2, 4)).toEqual(["dashboard", "helpdesk"]);
  });

  it("puts what is waiting on the rail and on the row it belongs to", () => {
    const tools = buildNav(viewer(), { shipping: 12, helpdesk: 3, messages: 2, social: 1 });
    expect(tool(tools, "shipping").count).toBe(12);
    expect(tool(tools, "shipping").menu[0].items[0]).toMatchObject({ label: "To ship", count: 12 });
    expect(tool(tools, "helpdesk").menu[1].items[2]).toMatchObject({ label: "Open", count: 3 });
    expect(tool(tools, "messages").count).toBe(2);
    expect(tool(tools, "stock").count).toBeUndefined();
  });
});

describe("buildNav: each tool's menu", () => {
  it("Shipping has its six places", () => {
    expect(labels(tool(buildNav(viewer()), "shipping"))).toEqual([
      "To ship",
      "All orders",
      "Scan & pack",
      "Label batches",
      "Rate calculator",
      "Sent",
    ]);
  });

  it("Stock shows Balances and Spend to managers only", () => {
    expect(labels(tool(buildNav(viewer()), "stock"))).toEqual([
      "To order",
      "Everything",
      "Orders",
      "Suppliers",
      "Balances",
      "Spend",
    ]);
    expect(labels(tool(buildNav(viewer({ manager: false })), "stock"))).toEqual([
      "To order",
      "Everything",
      "Orders",
      "Suppliers",
    ]);
  });

  it("Stock shows Michaels, with its four pages, only once it is connected", () => {
    const stock = tool(buildNav(viewer({ michaels: true })), "stock");
    const michaels = stock.menu[0].items.at(-1)!;
    expect(michaels.label).toBe("Michaels");
    expect(michaels.children?.map((child) => child.label)).toEqual([
      "Overview",
      "Listings",
      "Would send",
      "Orders",
    ]);
  });

  it("Help desk has its numbers first, the views the team knows, and groups the inbox fills", () => {
    const desk = tool(buildNav(viewer()), "helpdesk");
    expect(desk.menu.map((group) => group.name)).toEqual([
      undefined,
      "Tickets",
      "More",
      "Folders",
      "Views",
      "Tags",
    ]);
    expect(desk.menu[0].items[0].to).toBe("helpdesk/reports");
    // The manual sits beside the numbers, under a neutral name until the workspace gives it one.
    expect(desk.menu[0].items[1]).toMatchObject({ label: "Manual", to: "helpdesk/manual" });
    const named = tool(buildNav(viewer({ manualName: "Care guide" })), "helpdesk");
    expect(named.menu[0].items[1].label).toBe("Care guide");
    expect(desk.menu[1].items.map((item) => item.label)).toEqual([
      "Your tickets",
      "Unassigned",
      "Open",
      "In progress",
      "Snoozed",
      "Mentions",
      "Closed",
    ]);
    expect(desk.menu[1].items[0].to).toBe("helpdesk?view=mine");
    expect(desk.menu[2].items.map((item) => item.label)).toEqual([
      "All tickets",
      "Archived",
      "Spam",
      "Trash",
    ]);
    expect(desk.menu[2].items.map((item) => item.to)).toEqual([
      "helpdesk?view=all",
      "helpdesk?view=archived",
      "helpdesk?view=spam",
      "helpdesk?view=trash",
    ]);
    expect(desk.menu[3].add?.to).toBe("helpdesk?new=folder");
    const member = tool(buildNav(viewer({ manager: false })), "helpdesk");
    expect(member.menu[3].add).toBeUndefined();
  });

  it("a folder and a saved view are rows lit by their own word in the address", () => {
    const desk = tool(buildNav(viewer()), "helpdesk");
    const id = "33333333-3333-4333-8333-333333333333";
    const menu = withExtras(desk.menu, {
      items: {
        [HELPDESK_FOLDERS_GROUP]: helpdeskFolderItems([{ id, name: "Repairs" }]),
        [HELPDESK_VIEWS_GROUP]: helpdeskSavedViewItems([{ id: "vip", name: "VIP" }]),
      },
      counts: { [`helpdesk.f.${id}`]: 4 },
    });
    expect(menu.map((group) => group.name)).toEqual([
      undefined,
      "Tickets",
      "More",
      "Folders",
      "Views",
    ]);
    expect(menu[3].items[0]).toMatchObject({
      label: "Repairs",
      count: 4,
      to: `helpdesk?view=f:${id}`,
    });
    const lit = (view: string) =>
      activeIn({ to: desk.to, menu }, { path: "helpdesk", query: { view } }).item;
    expect(lit(`f:${id}`)).toBe(`helpdesk.f.${id}`);
    expect(lit("v:vip")).toBe("helpdesk.v.vip");
  });

  it("Bookings, Social, Money and Assistant carry their old tabs", () => {
    const tools = buildNav(viewer());
    expect(labels(tool(tools, "bookings"))).toEqual([
      "Coming up",
      "Calendar",
      "All bookings",
      "Runsheet",
      "Customers",
      "Messages sent",
      "Classroom supplies",
      "Vendors",
      "Budget",
    ]);
    // The budget is money: owners and admins only.
    expect(labels(tool(buildNav(viewer({ manager: false })), "bookings"))).not.toContain("Budget");
    // "Needs a date" is a place only while a shop order is waiting for one.
    const waiting = tool(buildNav(viewer(), { bookings: 2 }), "bookings");
    expect(labels(waiting)).toEqual([
      "Coming up",
      "Needs a date",
      "Calendar",
      "All bookings",
      "Runsheet",
      "Customers",
      "Messages sent",
      "Classroom supplies",
      "Vendors",
      "Budget",
    ]);
    expect(waiting.count).toBe(2);
    expect(waiting.menu[0].items[1]).toMatchObject({ to: "bookings/needs-date", count: 2 });
    expect(labels(tool(tools, "social"))).toEqual([
      "Calendar",
      "Review",
      "Assets",
      "Emails",
      "Projects",
      "Plan",
      "Link page",
    ]);
    expect(labels(tool(tools, "dashboard"))).toEqual([
      "Dashboard",
      "Expenses to sort",
      "Orders",
      "Statements",
      "Invoices",
      "Projection",
      "Budget",
      "Cost cutter",
      "Set up",
      "Payoff plan",
      "Debts",
      "What if…",
    ]);
    expect(labels(tool(tools, "assistant"))).toEqual(["Chat"]);
  });

  it("Messages draws its own list, and Home is one place", () => {
    const tools = buildNav(viewer());
    expect(tool(tools, "messages").panel).toBe("page");
    expect(tool(tools, "home").panel).toBe("none");
  });

  it("links each tool to its own section of Settings", () => {
    const tools = buildNav(viewer());
    expect(tool(tools, "shipping").settings).toEqual({ to: "settings/shipping" });
    expect(tool(tools, "stock").settings).toEqual({ to: "settings/stock" });
    expect(tool(tools, "dashboard").settings).toEqual({ to: "settings/money" });
    expect(tool(tools, "assistant").settings).toEqual({ to: "settings/assistant" });
    expect(tool(tools, "settings").settings).toBeUndefined();
    expect(tool(tools, "home").settings).toBeUndefined();
  });

  it("opens a tool's settings on the first screen this person can see", () => {
    // A member can't change the ship-from address; printing is theirs.
    const tools = buildNav(viewer({ manager: false }));
    expect(tool(tools, "shipping").settings).toEqual({ to: "settings/shipping/printing" });
  });

  it("Settings is one more tool: its groups and sections, by plan and role", () => {
    const settings = tool(buildNav(viewer()), "settings");
    expect(settings.menu.map((group) => group.name)).toEqual(["Workspace", "Tools"]);
    expect(settings.menu[0].items.map((item) => item.label)).toEqual([
      "Workspace",
      "People",
      "Plan & billing",
      "Brand kit",
      "Look",
      "Connections",
    ]);
    expect(settings.menu[0].items.at(-1)!.to).toBe("connections");
    const shipping = settings.menu[1].items.find((item) => item.label === "Shipping")!;
    expect(shipping.children?.map((child) => child.to)).toEqual([
      "settings/shipping",
      "settings/shipping/rules",
      "settings/shipping/slip",
      "settings/shipping/printing",
    ]);
    const small = tool(buildNav(viewer({ features: ["module.dashboard"] })), "settings");
    expect(small.menu[1].items.map((item) => item.label)).toEqual(["Money", "Assistant"]);
  });
});

describe("toolAt", () => {
  const tools = buildNav(viewer());
  const key = (path: string) => toolAt(tools, path).tool?.key;

  it("finds the tool for an address", () => {
    expect(key("")).toBe("home");
    expect(key("stock/suppliers/abc")).toBe("stock");
    expect(key("shipping")).toBe("shipping");
    expect(key("settings/stock/import")).toBe("settings");
    expect(key("helpdesk/reports")).toBe("helpdesk");
    expect(key("somewhere-else")).toBe("home");
  });

  it("says whether there is a panel, and whose menu it holds", () => {
    expect(toolAt(tools, "").panel).toBe("none");
    expect(toolAt(tools, "stock").panel).toBe("menu");
    expect(toolAt(tools, "messages").panel).toBe("page");
    // Connections has its own icon and sits in the Settings menu.
    const connections = toolAt(tools, "connections");
    expect(connections.tool?.key).toBe("connections");
    expect(connections.menuOf?.key).toBe("settings");
    expect(connections.panel).toBe("menu");
  });

  it("gives the email builder to Social, without a panel", () => {
    const builder = toolAt(tools, "emails/0b0e");
    expect(builder.tool?.key).toBe("social");
    expect(builder.panel).toBe("none");
  });

  it("never lands on a tool that isn't open", () => {
    const few = buildNav(viewer({ features: ["module.dashboard"] }));
    expect(toolAt(few, "stock").tool?.key).toBe("home");
  });
});

describe("activeIn", () => {
  const tools = buildNav(viewer({ michaels: true }));
  const lit = (key: string, path: string, query: Record<string, string> = {}) =>
    activeIn(tool(tools, key), at(path, query));

  it("lights the row whose address it is", () => {
    expect(lit("shipping", "shipping").item).toBe("shipping.to-ship");
    expect(lit("shipping", "shipping/all").item).toBe("shipping.all");
    expect(lit("stock", "stock/suppliers").item).toBe("stock.suppliers");
  });

  it("lights a row for the pages beneath it", () => {
    expect(lit("stock", "stock/suppliers/abc").item).toBe("stock.suppliers");
    expect(lit("stock", "stock/balances/invoice/9").item).toBe("stock.balances");
  });

  it("lights the tool's first screen for a page no row owns", () => {
    expect(lit("shipping", "shipping/orders/abc").item).toBe("shipping.to-ship");
    expect(lit("bookings", "bookings/sessions/abc").item).toBe("bookings.coming-up");
    expect(lit("social", "social/new").item).toBe("social.calendar");
  });

  it("counts the social posts waiting for review on the Review row", () => {
    const social = tool(buildNav(viewer(), { socialReview: 4 }), "social");
    const row = social.menu[0].items.find((item) => item.id === "social.review")!;
    expect(row).toMatchObject({ to: "social/review", count: 4 });
    expect(tool(buildNav(viewer()), "social").menu[0].items[1].count).toBeUndefined();
  });

  it("counts the expenses waiting to be sorted on Money's inbox row, and lights it", () => {
    const money = tool(buildNav(viewer(), { expensesToSort: 12 }), "dashboard");
    const row = money.menu[0].items.find((item) => item.id === "dashboard.expenses")!;
    expect(row).toMatchObject({ to: "dashboard/expenses", count: 12 });
    expect(money.count).toBeUndefined();
    expect(lit("dashboard", "dashboard/expenses").item).toBe("dashboard.expenses");
    expect(lit("dashboard", "dashboard").item).toBe("dashboard.home");
  });

  it("shows Money's debt rows to owners and admins only", () => {
    const owner = tool(buildNav(viewer()), "dashboard");
    expect(owner.menu.map((group) => group.name)).toEqual([undefined, "Debt payoff"]);
    expect(labels({ ...owner, menu: [owner.menu[1]] })).toEqual([
      "Payoff plan",
      "Debts",
      "What if…",
    ]);
    const member = tool(buildNav(viewer({ manager: false })), "dashboard");
    expect(member.menu).toHaveLength(1);
    expect(JSON.stringify(member)).not.toContain("debts");
    expect(lit("dashboard", "dashboard/debts/accounts").item).toBe("dashboard.debts.accounts");
    expect(lit("dashboard", "dashboard/debts").item).toBe("dashboard.debts.plan");
  });

  it("lets the longest address win, with the row it sits under", () => {
    expect(lit("stock", "stock/michaels")).toMatchObject({
      item: "stock.michaels.overview",
      parent: "stock.michaels",
    });
    expect(lit("stock", "stock/michaels/listings")).toMatchObject({
      item: "stock.michaels.listings",
      parent: "stock.michaels",
    });
    expect(lit("settings", "settings/stock/import")).toMatchObject({
      item: "settings.stock.import",
      parent: "settings.stock",
    });
    expect(lit("settings", "settings")).toMatchObject({ item: "settings.workspace", parent: null });
    expect(lit("settings", "connections").item).toBe("settings.connections");
  });

  it("reads the help desk's folder from the address", () => {
    expect(lit("helpdesk", "helpdesk").item).toBe("helpdesk.open");
    expect(lit("helpdesk", "helpdesk", { view: "mine", t: "12" }).item).toBe("helpdesk.mine");
    expect(lit("helpdesk", "helpdesk", { view: "closed" }).item).toBe("helpdesk.closed");
    expect(lit("helpdesk", "helpdesk/reports").item).toBe("helpdesk.reports");
  });

  it("lights no folder during a search", () => {
    expect(lit("helpdesk", "helpdesk", { q: "rug" }).item).toBeNull();
  });

  it("lights a tag as a filter over the folder", () => {
    const desk = tool(tools, "helpdesk");
    const menu = withExtras(desk.menu, {
      items: { [HELPDESK_TAGS_GROUP]: helpdeskTagItems(["repairs", "vip"]) },
    });
    const rows = activeIn({ to: desk.to, menu }, at("helpdesk", { view: "mine", tag: "vip" }));
    expect(rows.item).toBe("helpdesk.mine");
    expect(rows.filters).toEqual(["helpdesk.tag.vip"]);
  });
});

describe("hrefFor", () => {
  const desk = tool(buildNav(viewer()), "helpdesk");
  const [mine, , open] = desk.menu[1].items;
  const [vip] = helpdeskTagItems(["vip"]);

  it("builds the address inside the workspace", () => {
    const stock = tool(buildNav(viewer()), "stock");
    expect(hrefFor("wild", stock.menu[0].items[0], at("stock"))).toBe("/w/wild/stock");
    expect(hrefFor("wild", stock.menu[0].items[3], at(""))).toBe("/w/wild/stock/suppliers");
  });

  it("keeps the tag when changing folder, and drops the open conversation and search", () => {
    const here = at("helpdesk", { view: "closed", tag: "vip", t: "12", q: "rug" });
    expect(hrefFor("wild", mine, here)).toBe("/w/wild/helpdesk?view=mine&tag=vip");
    expect(hrefFor("wild", open, here)).toBe("/w/wild/helpdesk?tag=vip");
  });

  it("carries nothing over from another page", () => {
    expect(hrefFor("wild", mine, at("helpdesk/reports", { tag: "vip" }))).toBe(
      "/w/wild/helpdesk?view=mine",
    );
  });

  it("puts a tag on over the folder, and takes it off when pressed again", () => {
    const here = at("helpdesk", { view: "mine" });
    expect(hrefFor("wild", vip, here)).toBe("/w/wild/helpdesk?tag=vip&view=mine");
    expect(hrefFor("wild", vip, at("helpdesk", { view: "mine", tag: "vip" }), true)).toBe(
      "/w/wild/helpdesk?view=mine",
    );
  });

  it("escapes a tag's own characters", () => {
    const [odd] = helpdeskTagItems(["a&b c"]);
    expect(hrefFor("wild", odd, at(""))).toBe("/w/wild/helpdesk?tag=a%26b+c");
    expect(activeIn(desk, at("helpdesk", { tag: "a&b c" })).filters).toEqual([]);
  });
});

describe("withExtras", () => {
  const desk = tool(buildNav(viewer(), { helpdesk: 3 }), "helpdesk");

  it("drops a group nobody filled", () => {
    expect(withExtras(desk.menu, undefined).map((group) => group.name)).toEqual([
      undefined,
      "Tickets",
      "More",
      "Folders",
    ]);
    const member = tool(buildNav(viewer({ manager: false })), "helpdesk");
    expect(withExtras(member.menu, undefined).map((group) => group.name)).toEqual([
      undefined,
      "Tickets",
      "More",
    ]);
  });

  it("lays a page's counts over the layout's, and leaves out zeros", () => {
    const menu = withExtras(desk.menu, {
      counts: { "helpdesk.open": 7, "helpdesk.mine": 5, "helpdesk.snoozed": 0 },
    });
    const count = (id: string) => menu[1].items.find((item) => item.id === id)?.count;
    expect(count("helpdesk.open")).toBe(7);
    expect(count("helpdesk.mine")).toBe(5);
    expect(count("helpdesk.snoozed")).toBeUndefined();
  });
});

describe("filterMenu", () => {
  const settings = tool(buildNav(viewer()), "settings");
  const names = (text: string) =>
    filterMenu(settings.menu, text).flatMap((group) =>
      group.items.flatMap((item) => [
        item.label,
        ...(item.children ?? []).map((c) => `› ${c.label}`),
      ]),
    );

  it("changes nothing for an empty search", () => {
    expect(filterMenu(settings.menu, "  ")).toBe(settings.menu);
  });

  it("finds a screen by its keywords and keeps it under its tool", () => {
    expect(names("zebra")).toEqual(["Shipping", "› Printing on this computer"]);
  });

  it("keeps every screen of a tool matched by name", () => {
    expect(names("bookings")).toEqual([
      "Bookings",
      "› Emails & questions",
      "› Email words",
      "› Text reminders",
      "› Shop product page",
      "› Order tags",
      "› Budget",
      "› Daily email",
      "› Bring your bookings across",
    ]);
    expect(names("shipping")[0]).toBe("Shipping");
    expect(names("shipping")).toHaveLength(5);
  });

  it("answers with nothing when nothing matches", () => {
    expect(filterMenu(settings.menu, "zzz")).toEqual([]);
  });
});

describe("placeName", () => {
  const tools = buildNav(viewer());
  it("names where you are", () => {
    expect(placeName(tool(tools, "stock"), at("stock/suppliers"))).toBe("Suppliers");
    expect(placeName(tool(tools, "settings"), at("settings/shipping/rules"))).toBe(
      "Shipping › Rules",
    );
    expect(placeName(tool(tools, "helpdesk"), at("helpdesk", { q: "x" }))).toBeNull();
  });
});

describe("buildNav: Instagram & Facebook in the help desk", () => {
  const tickets = (v: NavViewer) =>
    tool(buildNav(v), "helpdesk")
      .menu.find((group) => group.id === "helpdesk.tickets")!
      .items.map((item) => item.id);

  it("is a place only where those messages are switched on", () => {
    expect(tickets(viewer())).not.toContain("helpdesk.social");
    expect(tickets(viewer({ socialInbox: true }))).toContain("helpdesk.social");
  });

  it("carries the count the inbox hands over, and lights for its view", () => {
    const desk = tool(buildNav(viewer({ socialInbox: true })), "helpdesk");
    const row = desk.menu.flatMap((group) => group.items).find((i) => i.id === "helpdesk.social")!;
    expect(row).toMatchObject({ label: "Instagram & Facebook", to: "helpdesk?view=social" });
  });
});

describe("buildNav: tools per person", () => {
  const member = (tools: Feature[]) =>
    viewer({
      manager: false,
      features: ["module.messages", ...tools],
      onPlan: (feature) => EVERYTHING.includes(feature),
    });

  it("leaves a tool that isn't theirs off the rail instead of showing it locked", () => {
    const keys = buildNav(member(["module.shipping"])).map((one) => one.key);
    expect(keys).toEqual(["home", "assistant", "messages", "shipping", "connections", "settings"]);
  });

  it("keeps Home and Messages for a member with no tools", () => {
    const tools = buildNav(member([]));
    expect(tools.map((one) => one.key)).toEqual([
      "home",
      "assistant",
      "messages",
      "connections",
      "settings",
    ]);
    expect(tools.every((one) => one.state === "open")).toBe(true);
  });

  it("still shows a tool the plan lacks as locked", () => {
    const tools = buildNav(
      viewer({
        manager: false,
        features: ["module.messages", "module.stock"],
        onPlan: (feature) => ["module.messages", "module.stock"].includes(feature),
      }),
    );
    expect(tool(tools, "shipping").state).toBe("locked");
    expect(tool(tools, "stock").state).toBe("open");
  });

  it("never lists Money's settings for someone without Money", () => {
    const settings = tool(buildNav(member(["module.stock"])), "settings");
    expect(labels(settings)).not.toContain("Money");
  });
});
