import { splitSections, docText, type Section } from "../manual/sections";
import { searchEntries, type Entry } from "../manual/search";
import type { RichDoc, RichRun } from "../rich";
import type { HelpCategory } from "./config";

/**
 * What the public pages are drawn from, worked out from a published article.
 * Pure: no database, no request. Everything a visitor sees passes through
 * here, so the rules about what a public page may carry live in one place:
 * only https links, only the article's own pictures from the public bucket,
 * and words as words (the page draws them as React text, never as markup).
 */

export type PublicPicture = { url: string; alt: string; caption: string; section: string };

export type PublicArticle = {
  id: string;
  slug: string;
  title: string;
  summary: string;
  category: string | null;
  body: RichDoc;
  updatedAt: string;
  publishedAt: string | null;
  pictures: PublicPicture[];
};

/** An article as lists and search results need it: no body. */
export type PublicCard = {
  slug: string;
  title: string;
  summary: string;
  category: string | null;
  updatedAt: string;
};

/** A link a public page may carry: https only. Anything else is shown as its words. */
export const isPublicLink = (href: string | undefined): href is string =>
  typeof href === "string" && /^https:\/\/[^\s<>"']{1,500}$/i.test(href.trim());

/** The document with every link that isn't https taken off (its words stay). */
export function publicDoc(doc: RichDoc): RichDoc {
  const clean = (runs: RichRun[]): RichRun[] =>
    runs.map((run) => {
      if (isPublicLink(run.href)) return { ...run, href: run.href.trim() };
      const { href: _href, ...rest } = run;
      return rest;
    });
  return doc.map((block) =>
    block.t === "p"
      ? { ...block, runs: clean(block.runs) }
      : { ...block, items: block.items.map(clean) },
  );
}

/** Where the public bucket's files are served from. Paths are ours: <workspace>/<article>/<id>.<ext>. */
export const PICTURE_PATH = /^[0-9a-f-]{36}\/[0-9a-f-]{36}\/[0-9a-f-]{36}\.(jpg|png|webp|gif)$/;
export const HELP_BUCKET = "help-centre";

export function publicPictureUrl(storagePath: string, base: string): string | null {
  if (!PICTURE_PATH.test(storagePath)) return null;
  return `${base.replace(/\/+$/, "")}/storage/v1/object/public/${HELP_BUCKET}/${storagePath}`;
}

/** The line for search engines and link previews: the summary, else the opening words. */
export function describe(article: Pick<PublicArticle, "summary" | "body">, max = 160): string {
  const text = (article.summary.trim() || docText(article.body)).replace(/\s+/g, " ").trim();
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), max - 30)).trimEnd()}…`;
}

export type PlacedSection = Section & { pictures: PublicPicture[] };

/**
 * The article's sections with each picture under the heading it was given.
 * A picture whose heading isn't in the article any more goes to the end, so
 * rewording a heading never loses one.
 */
export function placePictures(doc: RichDoc, pictures: PublicPicture[]): PlacedSection[] {
  const sections: PlacedSection[] = splitSections(doc).map((s) => ({ ...s, pictures: [] }));
  if (sections.length === 0 || sections[0].heading !== null) {
    sections.unshift({ heading: null, blocks: [], pictures: [] });
  }
  const stray: PublicPicture[] = [];
  for (const picture of pictures) {
    const wanted = picture.section.trim().toLowerCase();
    const home = wanted
      ? sections.find((s) => s.heading !== null && s.heading.trim().toLowerCase() === wanted)
      : sections[0];
    if (home) home.pictures.push(picture);
    else stray.push(picture);
  }
  if (stray.length > 0) sections[sections.length - 1].pictures.push(...stray);
  return sections.filter((s) => s.heading !== null || s.blocks.length > 0 || s.pictures.length > 0);
}

export type CategoryGroup = { id: string | null; label: string; articles: PublicCard[] };

/**
 * Articles under the workspace's categories, in the workspace's order. One
 * whose category is gone, or that never had one, goes under "More help" (or
 * simply "Articles" when there are no categories at all). Empty groups are
 * left out.
 */
export function groupByCategory(cards: PublicCard[], categories: HelpCategory[]): CategoryGroup[] {
  const known = new Set(categories.map((c) => c.id));
  const groups: CategoryGroup[] = categories.map((c) => ({
    id: c.id,
    label: c.label,
    articles: cards.filter((card) => card.category === c.id),
  }));
  const rest = cards.filter((card) => !card.category || !known.has(card.category));
  if (rest.length > 0) {
    groups.push({
      id: null,
      label: groups.some((g) => g.articles.length > 0) ? "More help" : "Articles",
      articles: rest,
    });
  }
  return groups.filter((g) => g.articles.length > 0);
}

export const MAX_QUERY = 80;

/** What a visitor typed, as something safe to search with and to show back. */
export const tidyQuery = (typed: unknown): string =>
  (typeof typed === "string" ? typed : "")
    .replace(/[\u0000-\u001f\u007f<>]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_QUERY);

/** Word search over published articles: every word typed must be found. No model is asked. */
export function searchPublic(
  articles: (PublicCard & { text: string })[],
  query: string,
  limit = 20,
): PublicCard[] {
  const entries: (Entry & { card: PublicCard })[] = articles.map((a) => ({
    id: a.slug,
    kind: "article",
    title: a.title,
    summary: a.summary,
    labels: [],
    text: a.text,
    card: {
      slug: a.slug,
      title: a.title,
      summary: a.summary,
      category: a.category,
      updatedAt: a.updatedAt,
    },
  }));
  const asked = tidyQuery(query);
  if (!asked) return [];
  return searchEntries(entries, asked)
    .slice(0, limit)
    .map((entry) => entry.card);
}

const xml = (text: string) =>
  text.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]!,
  );

/** The sitemap of one workspace's help centre: its home and every published article. */
export function sitemapXml(
  origin: string,
  workspace: string,
  cards: Pick<PublicCard, "slug" | "updatedAt">[],
): string {
  const base = `${origin.replace(/\/+$/, "")}/help-centre/${workspace}`;
  const day = (iso: string) => {
    const at = new Date(iso);
    return Number.isNaN(at.getTime()) ? null : at.toISOString().slice(0, 10);
  };
  const urls = [
    `<url><loc>${xml(base)}</loc></url>`,
    ...cards.map((card) => {
      const when = day(card.updatedAt);
      return `<url><loc>${xml(`${base}/${card.slug}`)}</loc>${when ? `<lastmod>${when}</lastmod>` : ""}</url>`;
    }),
  ];
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join("\n")}\n</urlset>\n`;
}

/** "November 3, 2026", on the workspace's own clock. */
export function longDay(iso: string, timeZone: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "";
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    month: "long",
    day: "numeric",
    year: "numeric",
  }).format(at);
}

/** How often one visitor may do each thing, and over how long. */
export const LIMITS = {
  search: { limit: 30, seconds: 60 },
  /** One answer per article per visitor per day. */
  vote: { limit: 1, seconds: 86_400 },
  /** And not more than twenty answers a day across all articles. */
  votes: { limit: 20, seconds: 86_400 },
} as const;
