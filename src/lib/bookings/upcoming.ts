import { z } from "zod";
import type { ShopPage } from "./shop-page";
import { zoneLabel } from "./slots";

/**
 * "Upcoming classes": a list of open workshop dates for the shop's own
 * workshops page (config "bookings" / "upcoming", off until switched on).
 * The list is drawn by a second small script, `public/upcoming-classes.js`,
 * that reads `/api/book/upcoming`. Pure, so the snippet, the answer and the
 * link check are tested without a page.
 */
export const UPCOMING_KEY = "upcoming";

const words = (max: number) => z.string().trim().max(max);

export const upcomingSchema = z.object({
  version: z.literal(1),
  /** Off: the endpoint answers "not found" and the snippet shows its own message. */
  on: z.boolean().default(false),
  title: words(80).default("Upcoming classes"),
  /** How many dates the list shows at most. */
  max_dates: z.number().int().min(1).max(50).default(12),
  show_seats_left: z.boolean().default(true),
  button_words: words(40).default("Book a place"),
  /** What the list says when nothing is open. */
  empty_message: words(200).default("No classes are open for booking just now. Check back soon!"),
});
export type Upcoming = z.infer<typeof upcomingSchema>;

export const DEFAULT_UPCOMING: Upcoming = upcomingSchema.parse({ version: 1 });

export function parseUpcoming(body: unknown): Upcoming {
  const parsed = upcomingSchema.safeParse(body);
  return parsed.success ? parsed.data : DEFAULT_UPCOMING;
}

/**
 * A product page address the list may link to: https, on a plain host name,
 * no user name or password, no odd port. Anything else is dropped, so the
 * list only ever points at the shop's own pages as the sync stored them.
 */
export function safeProductUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 1000) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.port) return null;
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(url.hostname)) return null;
    return url.toString();
  } catch {
    return null;
  }
}

export type UpcomingRow = {
  id: string;
  starts_at: string;
  ends_at: string;
  service: string;
  location: string | null;
  seats_left: number;
  product_url: string | null;
};

export type UpcomingClass = {
  id: string;
  service: string;
  /** "Sat, Mar 6" */
  day: string;
  /** "10:00 AM – 1:00 PM ET" */
  time: string;
  where: string;
  /** Left out when the business chose not to show it. */
  seats_left?: number;
  url: string | null;
};

export type UpcomingAnswer = {
  found: true;
  title: string;
  empty_message: string;
  button: string;
  accent: string;
  classes: UpcomingClass[];
};

const clock = (instant: string, timeZone: string) =>
  new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "2-digit" }).format(
    new Date(instant),
  );

/** What the endpoint answers: words worked out here, so the script only places them. */
export function upcomingAnswer(
  settings: Upcoming,
  page: Pick<ShopPage, "accent">,
  rows: UpcomingRow[],
  timeZone: string,
): UpcomingAnswer {
  return {
    found: true,
    title: settings.title,
    empty_message: settings.empty_message,
    button: settings.button_words || "Book a place",
    accent: page.accent,
    classes: rows.slice(0, settings.max_dates).map((row) => {
      const zone = zoneLabel(timeZone, row.starts_at);
      return {
        id: row.id,
        service: row.service,
        day: new Intl.DateTimeFormat("en-US", {
          timeZone,
          weekday: "short",
          month: "short",
          day: "numeric",
        }).format(new Date(row.starts_at)),
        time: `${clock(row.starts_at, timeZone)} – ${clock(row.ends_at, timeZone)}${zone ? ` ${zone}` : ""}`,
        where: row.location?.trim() ?? "",
        ...(settings.show_seats_left ? { seats_left: row.seats_left } : {}),
        url: safeProductUrl(row.product_url),
      };
    }),
  };
}

const html = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
/** Liquid would read `{{` or `{%` in our words as its own. */
const noLiquid = (text: string) => text.replace(/\{(?=[{%])/g, "{ ");

/**
 * The snippet for the workshops page. A box of the list's usual height is
 * kept from the first paint, so the page doesn't jump when the list arrives;
 * a plain message with a way to reach the business waits unseen and shows by
 * itself after a few seconds if the list never takes over (script blocked,
 * our server down). The script shows it at once when it knows it failed.
 */
export function upcomingSnippet(
  page: Pick<ShopPage, "contact_url" | "contact_email">,
  where: { slug: string; site: string },
): string {
  const href = page.contact_url || (page.contact_email && `mailto:${page.contact_email}`);
  const contact = href
    ? ` <a href="${html(href)}">Get in touch</a> and we'll tell you what's coming up.`
    : " Please get in touch and we'll tell you what's coming up.";
  return `{% comment %} Upcoming classes {% endcomment %}
<style>
  [data-mbs-upcoming] { display: block; min-height: 320px; }
  [data-mbs-upcoming] .mbs-fallback {
    margin: 0; visibility: hidden; animation: mbs-fallback 0s linear 6s forwards;
  }
  [data-mbs-upcoming].mbs-failed .mbs-fallback { visibility: visible; animation: none; }
  @keyframes mbs-fallback { to { visibility: visible; } }
</style>
<div data-mbs-upcoming data-workspace="${html(where.slug)}">
  <p class="mbs-fallback">We couldn't show the class dates just now.${noLiquid(contact)}</p>
</div>
<script src="${html(where.site)}/upcoming-classes.js" defer></script>`;
}
