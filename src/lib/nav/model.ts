import type { Attention } from "@/lib/attention";
import { VIEWS } from "@/lib/helpdesk/views";
import { MODULES, type ModuleKey } from "@/lib/modules";
import { settingsNav, type SettingsSection, type SettingsViewer } from "@/lib/settings/nav";

/**
 * The one description of how a workspace is laid out: the tools on the hub
 * rail, and for each tool the menu its panel holds, as groups of places.
 * Pure, so who sees what, and which row is lit for an address, can be tested
 * without a page. Settings is one more tool here; its sections still come
 * from `settingsNav()`.
 *
 * Every address in the model is what follows `/w/<slug>/` ("" is Home).
 */
/** The cookie that remembers, per browser, that the menu panel is folded away ("closed"). */
export const PANEL_COOKIE = "mbs-panel";

export type ToolKey = "home" | "assistant" | ModuleKey | "connections" | "settings";

export type NavViewer = SettingsViewer & {
  /** Whether this workspace has connected a Michaels seller account. */
  michaels: boolean;
};

export type NavMatch = {
  /** The address this place owns, with everything beneath it. */
  path: string;
  /** Only this very address, not the pages beneath it. */
  exact?: boolean;
  /**
   * Words in the address that must be set so (`?view=mine`). With
   * `fallback`, an address without the word counts as well.
   */
  query?: { key: string; value: string; fallback?: boolean }[];
  /** Words in the address that switch the place off while present (a search). */
  unless?: string[];
};

export type ItemIcon =
  | "chart"
  | "tag"
  | "user"
  | "help"
  | "inbox"
  | "clock"
  | "moon"
  | "at"
  | "check"
  | "layers"
  | "folder";

export type NavItem = {
  id: string;
  label: string;
  /** Where it goes: a path inside the workspace, query included. */
  to: string;
  match: NavMatch;
  count?: number;
  icon?: ItemIcon;
  /**
   * Laid over the place you are in rather than being a place (a tag): lit by
   * its own words in the address, and pressing it again takes it off.
   */
  filter?: boolean;
  /** Words carried over from the current address when it is the same page. */
  keep?: string[];
  /** Extra words the panel's search box matches, lower case. */
  keywords?: string[];
  children?: NavItem[];
};

export type NavGroup = {
  id: string;
  name?: string;
  items: NavItem[];
  /** A "+" beside the group's name: where a new one of these is made. Keeps an empty group on show. */
  add?: { label: string; to: string };
};

export type NavTool = {
  key: ToolKey;
  name: string;
  /** Where its icon on the rail goes. */
  to: string;
  /** Which stretch of the rail it sits in. */
  place: "top" | "tools" | "workspace";
  /** `soon`: on the plan, screens not shipped. `locked`: not on the plan. */
  state: "open" | "soon" | "locked";
  /** Things waiting, for the rail. */
  count?: number;
  /**
   * `menu`: the panel is drawn from `menu`. `page`: the tool's own page draws
   * its list where the panel goes (Messages). `none`: the tool is one place.
   */
  panel: "menu" | "page" | "none";
  /** The tool whose menu this one borrows (Connections sits in Settings). */
  panelOf?: ToolKey;
  menu: NavGroup[];
  /** The tool's section in workspace Settings, linked at the foot of its panel. */
  settings?: { to: string };
  /** Placeholder of the panel's search box, where it has one. */
  search?: string;
  /** Addresses outside `to` that belong to this tool, shown without the panel. */
  bare?: string[];
};

const place = (id: string, label: string, to: string, more: Partial<NavItem> = {}): NavItem => ({
  id,
  label,
  to,
  match: { path: to },
  ...more,
});
/** The first screen of a tool: its own address and nothing beneath it. */
const first = (id: string, label: string, to: string, more: Partial<NavItem> = {}): NavItem =>
  place(id, label, to, { match: { path: to, exact: true }, ...more });

const count = (n: number | undefined) => (n && n > 0 ? { count: n } : {});

function shippingMenu(attention: Attention): NavGroup[] {
  return [
    {
      id: "shipping.main",
      items: [
        first("shipping.to-ship", "To ship", "shipping", count(attention.shipping)),
        place("shipping.all", "All orders", "shipping/all"),
        place("shipping.scan", "Scan & pack", "shipping/scan"),
        place("shipping.batches", "Label batches", "shipping/batches"),
        place("shipping.rates", "Rate calculator", "shipping/rates"),
        place("shipping.sent", "Sent", "shipping/sent"),
      ],
    },
  ];
}

function stockMenu(viewer: NavViewer): NavGroup[] {
  const items = [
    first("stock.to-order", "To order", "stock"),
    place("stock.items", "Everything", "stock/items"),
    place("stock.orders", "Orders", "stock/orders"),
    place("stock.suppliers", "Suppliers", "stock/suppliers"),
  ];
  if (viewer.manager) {
    items.push(
      place("stock.balances", "Balances", "stock/balances"),
      place("stock.spend", "Spend", "stock/spend"),
    );
  }
  if (viewer.michaels) {
    items.push(
      place("stock.michaels", "Michaels", "stock/michaels", {
        children: [
          first("stock.michaels.overview", "Overview", "stock/michaels"),
          place("stock.michaels.listings", "Listings", "stock/michaels/listings"),
          place("stock.michaels.would-send", "Would send", "stock/michaels/would-send"),
          place("stock.michaels.orders", "Orders", "stock/michaels/orders"),
        ],
      }),
    );
  }
  return [{ id: "stock.main", items }];
}

/** The groups the inbox fills once it has read them: folders, saved views and tags. */
export const HELPDESK_FOLDERS_GROUP = "helpdesk.folders";
export const HELPDESK_VIEWS_GROUP = "helpdesk.views";
export const HELPDESK_TAGS_GROUP = "helpdesk.tags";

const VIEW_ICONS: Record<(typeof VIEWS)[number]["key"], ItemIcon> = {
  mine: "user",
  unassigned: "help",
  open: "inbox",
  pending: "clock",
  snoozed: "moon",
  mentions: "at",
  closed: "check",
  all: "layers",
};

/** A row for one way of looking at the inbox: `view` is the word in the address. */
function helpdeskView(id: string, label: string, view: string, icon: ItemIcon): NavItem {
  return {
    id,
    label,
    to: view === "open" ? "helpdesk" : `helpdesk?view=${view}`,
    match: {
      path: "helpdesk",
      exact: true,
      query: [{ key: "view", value: view, fallback: view === "open" }],
      unless: ["q"],
    },
    keep: ["tag"],
    icon,
  };
}

function helpdeskMenu(viewer: NavViewer, attention: Attention): NavGroup[] {
  const built = VIEWS.map((view) => ({
    ...helpdeskView(`helpdesk.${view.key}`, view.label, view.key, VIEW_ICONS[view.key]),
    ...(view.key === "open" ? count(attention.helpdesk) : {}),
  }));
  return [
    {
      id: "helpdesk.top",
      items: [place("helpdesk.reports", "How we're doing", "helpdesk/reports", { icon: "chart" })],
    },
    {
      id: "helpdesk.tickets",
      name: "Tickets",
      items: built.filter((item) => item.id !== "helpdesk.all"),
    },
    {
      id: "helpdesk.more",
      name: "More",
      items: built.filter((item) => item.id === "helpdesk.all"),
    },
    {
      id: HELPDESK_FOLDERS_GROUP,
      name: "Folders",
      items: [],
      // Folders are made by owners and admins; anyone files into them.
      ...(viewer.manager ? { add: { label: "New folder", to: "settings/helpdesk#folders" } } : {}),
    },
    { id: HELPDESK_VIEWS_GROUP, name: "Views", items: [] },
    { id: HELPDESK_TAGS_GROUP, name: "Tags", items: [] },
  ];
}

/** The workspace's folders as rows for the help desk panel. */
export function helpdeskFolderItems(folders: { id: string; name: string }[]): NavItem[] {
  return folders.map((folder) =>
    helpdeskView(`helpdesk.f.${folder.id}`, folder.name, `f:${folder.id}`, "folder"),
  );
}

/** The workspace's saved views as rows for the help desk panel. */
export function helpdeskSavedViewItems(views: { id: string; name: string }[]): NavItem[] {
  return views.map((view) =>
    helpdeskView(`helpdesk.v.${view.id}`, view.name, `v:${view.id}`, "layers"),
  );
}

/** The inbox's tags as rows for the help desk panel. */
export function helpdeskTagItems(tags: string[]): NavItem[] {
  return tags.map((tag) => ({
    id: `helpdesk.tag.${tag}`,
    label: tag,
    to: `helpdesk?tag=${encodeURIComponent(tag)}`,
    match: { path: "helpdesk", exact: true, query: [{ key: "tag", value: tag }] },
    icon: "tag" as const,
    filter: true,
    keep: ["view", "q"],
  }));
}

function settingsMenu(viewer: SettingsViewer): NavGroup[] {
  const to = (section: Pick<SettingsSection, "path" | "outside">) =>
    section.outside ?? (section.path ? `settings/${section.path}` : "settings");
  const item = (section: SettingsSection): NavItem => ({
    id: `settings.${section.id}`,
    label: section.name,
    to: to(section),
    // The first page is only itself; every other section owns what is beneath it.
    match: { path: to(section), ...(to(section) === "settings" ? { exact: true } : {}) },
    keywords: section.keywords,
    ...(section.children ? { children: section.children.map(item) } : {}),
  });
  return settingsNav(viewer).map((group) => ({
    id: `settings.group.${group.name.toLowerCase()}`,
    name: group.name,
    items: group.sections.map(item),
  }));
}

/** Each tool's section in Settings, by the id `settingsNav()` gives it. */
const SETTINGS_SECTION: Partial<Record<ToolKey, string>> = {
  shipping: "shipping",
  stock: "stock",
  bookings: "bookings",
  helpdesk: "helpdesk",
  social: "social",
  dashboard: "money",
  messages: "messages",
  assistant: "assistant",
};

/** The tools this person has, in rail order, each with its menu. */
export function buildNav(viewer: NavViewer, attention: Attention = {}): NavTool[] {
  const sections = settingsNav(viewer).flatMap((group) => group.sections);
  const settingsFor = (key: ToolKey) => {
    const section = sections.find((one) => one.id === SETTINGS_SECTION[key]);
    return section ? { settings: { to: `settings/${section.path}` } } : {};
  };
  const menus: Record<ModuleKey, Pick<NavTool, "panel" | "menu" | "bare">> = {
    messages: { panel: "page", menu: [] },
    dashboard: {
      panel: "menu",
      menu: [{ id: "dashboard.main", items: [place("dashboard.home", "Dashboard", "dashboard")] }],
    },
    helpdesk: { panel: "menu", menu: helpdeskMenu(viewer, attention) },
    bookings: {
      panel: "menu",
      menu: [
        {
          id: "bookings.main",
          items: [
            first("bookings.coming-up", "Coming up", "bookings"),
            place("bookings.calendar", "Calendar", "bookings/calendar"),
            place("bookings.customers", "Customers", "bookings/customers"),
          ],
        },
      ],
    },
    social: {
      panel: "menu",
      menu: [
        {
          id: "social.main",
          items: [
            first("social.calendar", "Calendar", "social"),
            place("social.assets", "Assets", "social/library"),
            place("social.emails", "Emails", "social/emails"),
            place("social.projects", "Projects", "social/projects"),
            place("social.plan", "Plan", "social/plan"),
            place("social.links", "Link page", "social/links"),
          ],
        },
      ],
      // The email builder takes the whole window.
      bare: ["emails"],
    },
    stock: { panel: "menu", menu: stockMenu(viewer) },
    shipping: { panel: "menu", menu: shippingMenu(attention) },
  };

  const open = MODULES.filter((m) => m.available && viewer.can(`module.${m.key}`));
  const shut = MODULES.filter((m) => !(m.available && viewer.can(`module.${m.key}`)));

  return [
    { key: "home", name: "Home", to: "", place: "top", state: "open", panel: "none", menu: [] },
    {
      key: "assistant",
      name: "Assistant",
      to: "assistant",
      place: "top",
      state: "open",
      panel: "menu",
      menu: [{ id: "assistant.main", items: [place("assistant.chat", "Chat", "assistant")] }],
      ...settingsFor("assistant"),
    },
    ...open.map((m): NavTool => ({
      key: m.key,
      name: m.name,
      to: m.key,
      place: "tools",
      state: "open",
      ...count(attention[m.key]),
      ...menus[m.key],
      ...settingsFor(m.key),
    })),
    ...shut.map((m): NavTool => ({
      key: m.key,
      name: m.name,
      to: m.key,
      place: "tools",
      state: viewer.can(`module.${m.key}`) ? "soon" : "locked",
      panel: "none",
      menu: [],
    })),
    {
      key: "connections",
      name: "Connections",
      to: "connections",
      place: "workspace",
      state: "open",
      panel: "menu",
      panelOf: "settings",
      menu: [],
    },
    {
      key: "settings",
      name: "Settings",
      to: "settings",
      place: "workspace",
      state: "open",
      panel: "menu",
      menu: settingsMenu(viewer),
      search: "Find a setting",
    },
  ];
}

const clean = (path: string) => path.replace(/^\/+|\/+$/g, "");
const under = (path: string, base: string) =>
  base === "" ? path === "" : path === base || path.startsWith(`${base}/`);

/**
 * Which tool an address belongs to, the tool whose menu the panel shows
 * there, and whether there is a panel at all. `path` is what follows
 * `/w/<slug>/`. Home is the answer for an address nobody owns.
 */
export function toolAt(
  tools: NavTool[],
  path: string,
): { tool: NavTool | null; menuOf: NavTool | null; panel: NavTool["panel"] } {
  const here = clean(path);
  let best: { tool: NavTool; length: number; bare: boolean } | null = null;
  for (const tool of tools) {
    if (tool.state !== "open") continue;
    for (const [base, bare] of [
      [tool.to, false] as const,
      ...(tool.bare ?? []).map((one) => [one, true] as const),
    ]) {
      if (!under(here, base)) continue;
      if (!best || base.length > best.length) best = { tool, length: base.length, bare };
    }
  }
  if (!best) {
    const home = tools.find((tool) => tool.key === "home") ?? null;
    return { tool: home, menuOf: null, panel: "none" };
  }
  if (best.bare) return { tool: best.tool, menuOf: null, panel: "none" };
  const menuOf = best.tool.panelOf
    ? (tools.find((tool) => tool.key === best.tool.panelOf) ?? null)
    : best.tool;
  if (!menuOf || menuOf.panel === "none") return { tool: best.tool, menuOf: null, panel: "none" };
  return { tool: best.tool, menuOf, panel: menuOf.panel };
}

export type Here = { path: string; query: Record<string, string> };

function score(match: NavMatch, here: Here): number | null {
  const path = clean(here.path);
  if (match.exact ? path !== match.path : !under(path, match.path)) return null;
  if ((match.unless ?? []).some((key) => here.query[key])) return null;
  for (const want of match.query ?? []) {
    const have = here.query[want.key];
    if (!have) {
      if (!want.fallback) return null;
    } else if (have !== want.value) return null;
  }
  return match.path.length * 10 + (match.query?.length ?? 0);
}

export type ActiveRows = {
  /** The row for the place you are in: a top-level row, or a row beneath one. */
  item: string | null;
  /** The top-level row it sits under, when it is a row beneath one. */
  parent: string | null;
  /** Filters switched on over it. */
  filters: string[];
};

/**
 * Which rows of a tool's menu are lit for an address. The longest matching
 * address wins, so "stock/michaels/listings" lights Listings and not Stock's
 * first screen. A page deeper in the tool that no row owns (one order, one
 * workshop) lights the tool's first screen.
 */
export function activeIn(tool: Pick<NavTool, "to" | "menu">, here: Here): ActiveRows {
  let best: { item: string; parent: string | null; score: number } | null = null;
  const filters: string[] = [];
  const consider = (item: NavItem, parent: string | null) => {
    const points = score(item.match, here);
    if (points === null) return;
    if (item.filter) filters.push(item.id);
    else if (!best || points > best.score) best = { item: item.id, parent, score: points };
  };
  const all = tool.menu.flatMap((group) => group.items);
  for (const item of all) {
    if (item.children) for (const child of item.children) consider(child, item.id);
    else consider(item, null);
  }
  const found = best as { item: string; parent: string | null } | null;
  if (found) return { item: found.item, parent: found.parent, filters };
  // Nobody owns this page: light the tool's first screen, unless we are on it
  // already (then a search or an unknown view has switched every row off).
  const path = clean(here.path);
  if (path !== tool.to && under(path, tool.to)) {
    const rows: { item: NavItem; parent: string | null }[] = [];
    for (const item of all) {
      if (item.children)
        for (const child of item.children) rows.push({ item: child, parent: item.id });
      else rows.push({ item, parent: null });
    }
    const home = rows.find(
      ({ item }) => !item.filter && item.match.path === tool.to && !item.match.query,
    );
    if (home) return { item: home.item.id, parent: home.parent, filters };
  }
  return { item: null, parent: null, filters };
}

/**
 * The address a row goes to from where you are. Words the row asks to keep
 * are carried over when it points at the page you are on; a filter that is
 * already on goes to the same place without it.
 */
export function hrefFor(slug: string, item: NavItem, here: Here, on = false): string {
  const [path, search = ""] = item.to.split("?");
  const params = new URLSearchParams(search);
  if (clean(here.path) === path) {
    for (const key of item.keep ?? []) {
      const value = here.query[key];
      if (value && !params.has(key)) params.set(key, value);
    }
  }
  if (item.filter && on) for (const want of item.match.query ?? []) params.delete(want.key);
  const text = params.toString();
  return `/w/${slug}${path ? `/${path}` : ""}${text ? `?${text}` : ""}`;
}

/** What a page has worked out for its tool's panel: counts by row, and rows for a group. */
export type PanelExtras = {
  counts?: Record<string, number>;
  items?: Record<string, NavItem[]>;
};

/** A menu with a page's own counts and rows laid in. Groups left empty are dropped, unless they carry a "+". */
export function withExtras(menu: NavGroup[], extras: PanelExtras | undefined): NavGroup[] {
  const lay = (item: NavItem): NavItem => {
    const n = extras?.counts?.[item.id];
    const { count: had, ...rest } = item;
    const now = n === undefined ? had : n;
    return {
      ...rest,
      ...(now && now > 0 ? { count: now } : {}),
      ...(item.children ? { children: item.children.map(lay) } : {}),
    };
  };
  return menu
    .map((group) => ({
      ...group,
      items: [...group.items, ...(extras?.items?.[group.id] ?? [])].map(lay),
    }))
    .filter((group) => group.items.length > 0 || group.add);
}

const words = (text: string) => text.toLowerCase().split(/\s+/).filter(Boolean);
const holds = (asked: string[], ...haystacks: string[]) => {
  const hay = haystacks.join(" ").toLowerCase();
  return asked.every((word) => hay.includes(word));
};

/**
 * The panel's search box: keeps the rows whose name or keywords hold every
 * word typed. A row that matches by its own name keeps everything beneath
 * it; otherwise only the rows beneath it that match stay. An empty search
 * changes nothing.
 */
export function filterMenu(menu: NavGroup[], text: string): NavGroup[] {
  const asked = words(text);
  if (asked.length === 0) return menu;
  return menu
    .map((group) => ({
      ...group,
      items: group.items.flatMap((item): NavItem[] => {
        const own = holds(asked, item.label, ...(item.keywords ?? []));
        if (!item.children) return own ? [item] : [];
        if (own) return [item];
        const kids = item.children.filter((child) =>
          holds(asked, item.label, child.label, ...(child.keywords ?? [])),
        );
        return kids.length > 0 ? [{ ...item, to: kids[0].to, children: kids }] : [];
      }),
    }))
    .filter((group) => group.items.length > 0);
}

/** The name of the place an address is, for the menu button: "Suppliers", "Stock › Seasons". */
export function placeName(tool: Pick<NavTool, "to" | "menu">, here: Here): string | null {
  const lit = activeIn(tool, here);
  if (!lit.item) return null;
  for (const item of tool.menu.flatMap((group) => group.items)) {
    if (item.id === lit.item) return item.label;
    const child = item.children?.find((one) => one.id === lit.item);
    if (child) return `${item.label} › ${child.label}`;
  }
  return null;
}
