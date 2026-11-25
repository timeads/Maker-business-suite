import type { Feature } from "@/lib/entitlements";
import { MODULES, type ModuleKey } from "@/lib/modules";

/**
 * The one list of what lives under workspace Settings: the workspace's own
 * sections, then one entry per tool with that tool's settings screens beneath
 * it. Pure, so who sees what can be tested without a page.
 *
 * `path` is what follows `/w/<slug>/settings/` ("" is the first page). A
 * section with `outside` instead lives elsewhere in the workspace
 * (Connections) and is only linked from here.
 */
export type SettingsViewer = {
  /** The plan's answer, straight from `getEntitlements()`. */
  can: (feature: Feature) => boolean;
  /** Owner or admin. */
  manager: boolean;
  /** False once the plan has ended and the workspace is read-only. */
  canWrite: boolean;
  /** Whether sending orders from Gmail is offered on this site at all. */
  gmailOrders: boolean;
};

export type SettingsSection = {
  id: string;
  name: string;
  path: string;
  /** A path under `/w/<slug>/` for a section that isn't under Settings. */
  outside?: string;
  /** Extra words the search box matches, lower case. */
  keywords: string[];
  children?: SettingsSection[];
};

export type SettingsGroup = { name: string; sections: SettingsSection[] };

type Rule = (viewer: SettingsViewer) => boolean;
type Def = Omit<SettingsSection, "children"> & {
  /** The tool this entry belongs to: hidden unless the plan includes it. */
  module?: ModuleKey;
  show?: Rule;
  children?: (Omit<SettingsSection, "children"> & { show?: Rule })[];
};

const everyone: Rule = () => true;
const managers: Rule = (viewer) => viewer.manager;
/** Who the tool's settings screen let change things before the move. */
const managersWhoCanWrite: Rule = (viewer) => viewer.manager && viewer.canWrite;

const WORKSPACE: Def[] = [
  {
    id: "workspace",
    name: "Workspace",
    path: "",
    keywords: ["name", "time zone", "timezone", "currency", "general", "basics"],
  },
  {
    id: "team",
    name: "People",
    path: "team",
    keywords: ["team", "invite", "members", "teammate", "roles", "owner", "admin"],
  },
  {
    id: "billing",
    name: "Plan & billing",
    path: "billing",
    keywords: ["plan", "payment", "card", "subscription", "trial", "extra tool", "stripe"],
  },
  {
    id: "brand",
    name: "Brand kit",
    path: "brand",
    keywords: ["colours", "colors", "voice", "tone", "logo", "fonts", "brand"],
  },
  {
    id: "look",
    name: "Look",
    path: "look",
    keywords: ["appearance", "dark", "light", "theme", "brand colours", "brand colors"],
  },
  {
    id: "connections",
    name: "Connections",
    path: "",
    outside: "connections",
    keywords: ["shop", "shopify", "quickbooks", "gmail", "stripe", "ups", "easypost", "redo"],
  },
];

const TOOLS: Def[] = [
  {
    id: "shipping",
    name: "Shipping",
    path: "shipping",
    module: "shipping",
    keywords: ["parcels", "labels", "packing"],
    children: [
      {
        id: "shipping.from",
        name: "Ship-from & boxes",
        path: "shipping",
        show: managersWhoCanWrite,
        keywords: [
          "address",
          "ship from",
          "boxes",
          "envelopes",
          "weight",
          "tell my shop",
          "pickups",
          "recording parcels",
          "signature",
          "carrier",
        ],
      },
      {
        id: "shipping.rules",
        name: "Rules",
        path: "shipping/rules",
        show: managersWhoCanWrite,
        keywords: ["signature", "hold", "service", "box", "remember how i pack", "packing memory"],
      },
      {
        id: "shipping.slip",
        name: "Packing slip",
        path: "shipping/slip",
        show: managersWhoCanWrite,
        keywords: ["slip", "designer", "logo", "barcode", "thank-you", "footer"],
      },
      {
        id: "shipping.printing",
        name: "Printing on this computer",
        path: "shipping/printing",
        keywords: ["zebra", "printer", "print", "browser print", "label size", "paper"],
      },
    ],
  },
  {
    id: "stock",
    name: "Stock",
    path: "stock",
    module: "stock",
    keywords: ["reorder", "inventory", "suppliers"],
    children: [
      {
        id: "stock.planning",
        name: "Planning",
        path: "stock",
        keywords: [
          "lead time",
          "days of cover",
          "buffer",
          "hide words",
          "gift card",
          "tags",
          "never reorder",
          "busy seasons",
          "payments from books",
          "quickbooks",
          "shop count",
          "sync",
          "reads of your shop",
        ],
      },
      {
        id: "stock.seasons",
        name: "Seasons",
        path: "stock/seasons",
        keywords: ["holidays", "fair", "sale", "lift", "in stock by", "plan ahead"],
      },
      {
        id: "stock.order-emails",
        name: "Order emails",
        path: "stock/order-emails",
        show: (viewer) => managersWhoCanWrite(viewer) && viewer.gmailOrders,
        keywords: ["purchase order", "gmail", "subject", "message", "template", "wording"],
      },
      {
        id: "stock.bills",
        name: "Balances & bills by email",
        path: "stock/bills",
        show: managers,
        keywords: [
          "bills address",
          "forward",
          "invoices",
          "statements",
          "payment notices",
          "senders",
          "who to recognise",
          "read gmail",
        ],
      },
      {
        id: "stock.import",
        name: "Bring your records across",
        path: "stock/import",
        show: managers,
        keywords: ["import", "csv", "spreadsheet", "history", "migrate", "file"],
      },
      {
        id: "stock.michaels",
        name: "Michaels",
        path: "stock/michaels",
        show: (viewer) => viewer.can("michaels"),
        keywords: ["marketplace", "units held back", "watch only", "look at michaels"],
      },
    ],
  },
  {
    id: "bookings",
    name: "Bookings",
    path: "bookings",
    module: "bookings",
    keywords: [
      "confirmation",
      "reminder",
      "thank-you",
      "emails to customers",
      "extra questions",
      "booking form",
    ],
  },
  {
    id: "helpdesk",
    name: "Help desk",
    path: "helpdesk",
    module: "helpdesk",
    keywords: ["support", "inbox", "customers"],
    children: [
      {
        id: "helpdesk.desk",
        name: "Inbox & replies",
        path: "helpdesk",
        keywords: [
          "support address",
          "forwarding",
          "saved replies",
          "templates",
          "rules for new email",
          "tags",
          "priority",
          "hand off",
        ],
      },
      {
        id: "helpdesk.channels",
        name: "Channels",
        path: "helpdesk/channels",
        keywords: [
          "instagram",
          "facebook",
          "messenger",
          "direct messages",
          "dms",
          "social messages",
          "24 hours",
        ],
      },
      {
        id: "helpdesk.manual",
        name: "Manual",
        path: "helpdesk/manual",
        keywords: [
          "manual",
          "topics",
          "knowledge base",
          "articles",
          "which conversations",
          "written by ai",
          "update",
          "monthly limit",
        ],
      },
      {
        id: "helpdesk.help-centre",
        name: "Help centre",
        path: "helpdesk/help-centre",
        keywords: [
          "help centre",
          "help center",
          "public articles",
          "customers can read",
          "categories",
          "faq",
          "search engines",
          "contact us",
        ],
      },
    ],
  },
  {
    id: "social",
    name: "Social & emails",
    path: "social",
    module: "social",
    keywords: ["content plan", "topics", "link page", "saved sections", "templates", "posts"],
  },
  {
    id: "money",
    name: "Money",
    path: "money",
    module: "dashboard",
    keywords: ["dashboard", "sales", "margins", "cash", "charts", "layout"],
  },
  {
    id: "messages",
    name: "Messages",
    path: "messages",
    module: "messages",
    keywords: ["chat", "channels", "direct messages", "heads-ups"],
  },
  {
    id: "assistant",
    name: "Assistant",
    path: "assistant",
    keywords: ["claude", "ai", "proposals", "changes", "allowance"],
  },
];

const AVAILABLE = new Set<ModuleKey>(MODULES.filter((m) => m.available).map((m) => m.key));

function resolve(defs: Def[], viewer: SettingsViewer): SettingsSection[] {
  const out: SettingsSection[] = [];
  for (const { module, show = everyone, children, ...section } of defs) {
    if (module && !(AVAILABLE.has(module) && viewer.can(`module.${module}`))) continue;
    if (!show(viewer)) continue;
    if (!children) {
      out.push(section);
      continue;
    }
    const kids = children
      .filter((child) => (child.show ?? everyone)(viewer))
      .map(({ show: _show, ...child }) => child);
    if (kids.length === 0) continue;
    // A tool's own row opens the first of its screens this person can see.
    out.push({ ...section, path: kids[0].path, children: kids });
  }
  return out;
}

/** What this person sees in Settings, in order. */
export function settingsNav(viewer: SettingsViewer): SettingsGroup[] {
  return [
    { name: "Workspace", sections: resolve(WORKSPACE, viewer) },
    { name: "Tools", sections: resolve(TOOLS, viewer) },
  ].filter((group) => group.sections.length > 0);
}

/** Every path under Settings that has a page, whoever may see it. */
export function allSettingsPaths(): string[] {
  const paths = new Set<string>();
  for (const def of [...WORKSPACE, ...TOOLS]) {
    if (!def.outside) paths.add(def.path);
    for (const child of def.children ?? []) paths.add(child.path);
  }
  return [...paths];
}

/** Where a section lives, as an address inside the workspace. */
export function settingsHref(slug: string, section: Pick<SettingsSection, "path" | "outside">) {
  if (section.outside) return `/w/${slug}/${section.outside}`;
  return section.path ? `/w/${slug}/settings/${section.path}` : `/w/${slug}/settings`;
}

/**
 * Which rows are lit for an address: the tool's row and, under it, the screen.
 * `path` is what follows `/settings/` ("" for the first page). The longest
 * matching path wins, so "stock/import" lights Bring your records across and
 * not Planning.
 */
export function activeSettings(
  groups: SettingsGroup[],
  path: string,
): { section: string | null; child: string | null } {
  const clean = path.replace(/^\/+|\/+$/g, "");
  const under = (base: string) => clean === base || (base !== "" && clean.startsWith(`${base}/`));
  let best: { section: string; child: string | null; length: number } | null = null;
  for (const group of groups) {
    for (const section of group.sections) {
      if (section.outside) continue;
      const candidates = section.children
        ? section.children.map((child) => ({ child: child.id as string | null, path: child.path }))
        : [{ child: null, path: section.path }];
      for (const candidate of candidates) {
        if (!under(candidate.path)) continue;
        if (!best || candidate.path.length > best.length) {
          best = { section: section.id, child: candidate.child, length: candidate.path.length };
        }
      }
    }
  }
  return { section: best?.section ?? null, child: best?.child ?? null };
}

const words = (text: string) => text.toLowerCase().split(/\s+/).filter(Boolean);

function matches(queryWords: string[], ...haystacks: string[]) {
  const hay = haystacks.join(" ").toLowerCase();
  return queryWords.every((word) => hay.includes(word));
}

/**
 * The search box: keeps the sections whose name or keywords hold every word
 * typed. A tool that matches by its own name keeps all its screens; otherwise
 * only the screens that match stay under it. An empty search changes nothing.
 */
export function filterSettings(groups: SettingsGroup[], query: string): SettingsGroup[] {
  const asked = words(query);
  if (asked.length === 0) return groups;
  return groups
    .map((group) => ({
      name: group.name,
      sections: group.sections.flatMap((section): SettingsSection[] => {
        const own = matches(asked, section.name, ...section.keywords);
        if (!section.children) return own ? [section] : [];
        if (own) return [section];
        const kids = section.children.filter((child) =>
          matches(asked, section.name, child.name, ...child.keywords),
        );
        return kids.length > 0 ? [{ ...section, path: kids[0].path, children: kids }] : [];
      }),
    }))
    .filter((group) => group.sections.length > 0);
}
