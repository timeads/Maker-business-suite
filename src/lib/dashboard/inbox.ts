/**
 * The expense inbox's address: which expenses it shows, kept in the URL so a
 * view can be shared and the back button works. Pure.
 */

export const INBOX_VIEWS = ["to_sort", "sorted", "set_aside", "all"] as const;
export type InboxView = (typeof INBOX_VIEWS)[number];

export const VIEW_NAMES: Record<InboxView, string> = {
  to_sort: "To sort",
  sorted: "Sorted",
  set_aside: "Set aside",
  all: "All",
};

export const INBOX_PAGE = 50;

export type InboxQuery = {
  view: InboxView;
  /** Words to look for in the payee, accounts, memo and line descriptions. */
  q: string;
  /** YYYY-MM, or null for every month. */
  month: string | null;
  page: number;
};

const first = (value: string | string[] | undefined) =>
  Array.isArray(value) ? value[0] : (value ?? "");

export function parseInboxQuery(params: Record<string, string | string[] | undefined>): InboxQuery {
  const view = first(params.view);
  const month = first(params.month);
  const page = Number.parseInt(first(params.page), 10);
  return {
    view: (INBOX_VIEWS as readonly string[]).includes(view) ? (view as InboxView) : "to_sort",
    q: first(params.q).trim().replace(/\s+/g, " ").slice(0, 80),
    month: /^\d{4}-(0[1-9]|1[0-2])$/.test(month) ? month : null,
    page: Number.isFinite(page) && page > 0 && page <= 1000 ? page : 1,
  };
}

/** The inbox's address with some of its query changed. Leaving a filter changes the page back to 1. */
export function inboxHref(base: string, query: InboxQuery, change: Partial<InboxQuery>): string {
  const next = { ...query, page: 1, ...change };
  const params = new URLSearchParams();
  if (next.view !== "to_sort") params.set("view", next.view);
  if (next.q) params.set("q", next.q);
  if (next.month) params.set("month", next.month);
  if (next.page > 1) params.set("page", String(next.page));
  const text = params.toString();
  return text ? `${base}?${text}` : base;
}

/** The first day of a month and of the month after, for a date filter. */
export function monthBounds(month: string): { from: string; to: string } {
  const [year, m] = month.split("-").map(Number);
  const next = m === 12 ? `${year + 1}-01` : `${year}-${String(m + 1).padStart(2, "0")}`;
  return { from: `${month}-01`, to: `${next}-01` };
}

/** Words for a LIKE pattern: the wildcards and the escape itself are taken literally. */
export function likePattern(words: string): string {
  return `%${words.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/** "October 2026". */
export function monthName(month: string): string {
  const [year, m] = month.split("-").map(Number);
  return new Intl.DateTimeFormat("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(year, m - 1, 1)));
}
