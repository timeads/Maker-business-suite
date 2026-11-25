import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { cacheLife, cacheTag } from "next/cache";
import { moduleOpen } from "../module-access";
import { LOGO_TAG } from "../social/photo-match";
import { publicAssetUrl } from "../social/worker";
import { getAdminClient, withTenant } from "../supabase/admin";
import { inboundDomain, supportAddress } from "./addresses";
import { HELPDESK_MODULE } from "./config";
import { HELP_CENTRE_KEY, parseHelpCentre, type HelpCentreConfig } from "./help-centre/config";
import {
  LIMITS,
  publicDoc,
  publicPictureUrl,
  searchPublic,
  tidyQuery,
  type PublicArticle,
  type PublicCard,
  type PublicPicture,
} from "./help-centre/public";
import { docText } from "./manual/sections";
import { parseRichDoc } from "./rich";

/**
 * Everything the public help centre pages read or write. The pages have no
 * database access of their own: they call these, which use the service role,
 * always name the workspace, and hand back only what a visitor may see. The
 * database holds the same line (`help_centre_list`, `help_centre_article`
 * return published articles of a help centre that is switched on, and
 * nothing else), so a slip here still can't show a draft, an internal
 * article, a topic or another workspace's page.
 *
 * A workspace that doesn't exist, has the help desk off its plan, or hasn't
 * switched its help centre on gets the same answer: null, which the pages
 * turn into "not found".
 */

export const helpCentreConfigured = (): boolean =>
  Boolean(process.env.SUPABASE_SECRET_KEY && process.env.NEXT_PUBLIC_SUPABASE_URL);

/** The cache tag for one workspace's public pages; changing anything public clears it. */
export const helpCentreTag = (workspaceSlug: string) => `help-centre:${workspaceSlug}`;

export type HelpCentre = {
  workspace: { slug: string; name: string; timezone: string };
  config: HelpCentreConfig;
  /** The workspace's logo (its asset tagged "logo"), or null. */
  logoUrl: string | null;
  /** Where customers write, or null when there is nowhere to send them. */
  contactEmail: string | null;
};

type Found = HelpCentre & { tenantId: string };

const SLUG = /^[a-z0-9-]{1,80}$/;

/** The workspace's help centre if a visitor may see it at all. */
async function findCentre(workspaceSlug: string, admin: SupabaseClient): Promise<Found | null> {
  if (!SLUG.test(workspaceSlug)) return null;
  const { data: tenant } = await admin
    .from("tenants")
    .select("id, name, slug, timezone")
    .eq("slug", workspaceSlug)
    .maybeSingle();
  if (!tenant) return null;
  const tenantId = tenant.id as string;
  if (!(await moduleOpen(tenantId, "helpdesk", admin))) return null;
  return withTenant(
    tenantId,
    async (scope) => {
      const { data: config } = await scope
        .select("configs", "body")
        .eq("module", HELPDESK_MODULE)
        .eq("key", HELP_CENTRE_KEY)
        .maybeSingle();
      const parsed = parseHelpCentre((config as { body?: unknown } | null)?.body);
      if (!parsed.on) return null;
      // The logo is an ordinary public asset the workspace tagged "logo"; allowed to be missing.
      const { data: logos } = await scope
        .select("social_assets", "storage_path")
        .eq("hidden", false)
        .like("mime_type", "image/%")
        .contains("tags", [LOGO_TAG])
        .order("created_at", { ascending: false })
        .limit(1);
      const logo = ((logos ?? []) as unknown as { storage_path: string }[])[0]?.storage_path;
      const domain = inboundDomain();
      return {
        tenantId,
        workspace: {
          slug: tenant.slug as string,
          name: tenant.name as string,
          timezone: (tenant.timezone as string) || "UTC",
        },
        config: parsed,
        logoUrl: logo && logo.startsWith(`${tenantId}/`) ? publicAssetUrl(logo) : null,
        contactEmail:
          parsed.contact_email || (domain ? supportAddress(tenant.slug as string, domain) : null),
      };
    },
    admin,
  );
}

type ListRow = {
  slug: string;
  title: string;
  summary: string;
  category: string | null;
  body: unknown;
  updated_at: string;
};

async function listArticles(
  tenantId: string,
  admin: SupabaseClient,
): Promise<(PublicCard & { text: string })[]> {
  const { data, error } = await admin.rpc("help_centre_list", { p_tenant_id: tenantId });
  if (error) throw new Error(`Could not read the help centre: ${error.message}`);
  return ((data ?? []) as ListRow[]).map((row) => ({
    slug: row.slug,
    title: row.title,
    summary: row.summary,
    category: row.category,
    updatedAt: row.updated_at,
    text: docText(parseRichDoc(row.body) ?? []).slice(0, 20_000),
  }));
}

const strip = ({ tenantId: _tenantId, ...centre }: Found): HelpCentre => centre;

export type HelpCentreHome = HelpCentre & { articles: PublicCard[] };

/** The home page: who it is and every published article, without their words. */
export async function getHelpCentre(workspaceSlug: string): Promise<HelpCentreHome | null> {
  "use cache";
  cacheLife({ stale: 60, revalidate: 300, expire: 900 });
  cacheTag(helpCentreTag(workspaceSlug));
  if (!helpCentreConfigured()) return null;
  const admin = getAdminClient();
  const centre = await findCentre(workspaceSlug, admin);
  if (!centre) return null;
  const articles = await listArticles(centre.tenantId, admin);
  return { ...strip(centre), articles: articles.map(({ text: _text, ...card }) => card) };
}

type ArticleRow = {
  id: string;
  slug: string;
  title: string;
  summary: string;
  category: string | null;
  body: unknown;
  updated_at: string;
  published_at: string | null;
  pictures: { path: string; alt: string; caption: string; section: string }[] | null;
};

export type HelpArticleAnswer =
  | { kind: "article"; centre: HelpCentre; article: PublicArticle }
  /** It lives at another address now. */
  | { kind: "moved"; slug: string };

/** One published article by its address (or one it used to have), or null. */
export async function getHelpArticle(
  workspaceSlug: string,
  articleSlug: string,
): Promise<HelpArticleAnswer | null> {
  "use cache";
  cacheLife({ stale: 60, revalidate: 300, expire: 900 });
  cacheTag(helpCentreTag(workspaceSlug));
  if (!helpCentreConfigured() || !SLUG.test(articleSlug)) return null;
  const admin = getAdminClient();
  const centre = await findCentre(workspaceSlug, admin);
  if (!centre) return null;
  const { data, error } = await admin.rpc("help_centre_article", {
    p_tenant_id: centre.tenantId,
    p_slug: articleSlug,
  });
  if (error) throw new Error(`Could not read a help article: ${error.message}`);
  const row = data as ArticleRow | null;
  if (!row) return null;
  if (row.slug !== articleSlug) return { kind: "moved", slug: row.slug };
  const base = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const pictures: PublicPicture[] = (row.pictures ?? []).flatMap((picture) => {
    // Only files under this workspace's own folder of the public bucket.
    if (!picture.path.startsWith(`${centre.tenantId}/${row.id}/`)) return [];
    const url = publicPictureUrl(picture.path, base);
    return url
      ? [{ url, alt: picture.alt, caption: picture.caption, section: picture.section }]
      : [];
  });
  return {
    kind: "article",
    centre: strip(centre),
    article: {
      id: row.id,
      slug: row.slug,
      title: row.title,
      summary: row.summary,
      category: row.category,
      body: publicDoc(parseRichDoc(row.body) ?? []),
      updatedAt: row.updated_at,
      publishedAt: row.published_at,
      pictures,
    },
  };
}

/**
 * A fingerprint of the visitor for counting how often they ask, good for one
 * day and one workspace. Salted with a secret only the server holds; the
 * address itself is never stored or logged.
 */
export function visitorKey(tenantId: string, address: string, now = new Date()): string {
  return createHash("sha256")
    .update(
      [
        "help-centre",
        process.env.SUPABASE_SECRET_KEY ?? "",
        tenantId,
        now.toISOString().slice(0, 10),
        address.trim().toLowerCase() || "unknown",
      ].join("|"),
    )
    .digest("hex")
    .slice(0, 40);
}

/** The visitor's address as the proxy in front of us reports it. */
export const visitorAddress = (headers: { get(name: string): string | null }): string =>
  (headers.get("x-forwarded-for") ?? "").split(",")[0].trim().slice(0, 60) ||
  (headers.get("x-real-ip") ?? "").trim().slice(0, 60);

async function allowed(
  admin: SupabaseClient,
  tenantId: string,
  kind: string,
  key: string,
  rule: { limit: number; seconds: number },
): Promise<boolean> {
  const { data, error } = await admin.rpc("help_centre_allow", {
    p_tenant_id: tenantId,
    p_kind: kind,
    p_key: key,
    p_limit: rule.limit,
    p_seconds: rule.seconds,
  });
  // If the count can't be kept, the answer is no: a public page never runs unmetered.
  return !error && data === true;
}

export type SearchAnswer =
  { kind: "results"; query: string; results: PublicCard[] } | { kind: "slow_down"; query: string };

/**
 * Word search over one workspace's published articles. Plain matching in the
 * app, no model, and only so many searches a minute from one visitor.
 */
export async function searchHelpCentre(
  workspaceSlug: string,
  typed: string,
  address: string,
  admin: SupabaseClient = getAdminClient(),
): Promise<SearchAnswer | null> {
  const query = tidyQuery(typed);
  if (!helpCentreConfigured()) return null;
  const centre = await findCentre(workspaceSlug, admin);
  if (!centre) return null;
  if (!query) return { kind: "results", query, results: [] };
  const key = visitorKey(centre.tenantId, address);
  if (!(await allowed(admin, centre.tenantId, "search", key, LIMITS.search))) {
    return { kind: "slow_down", query };
  }
  return {
    kind: "results",
    query,
    results: searchPublic(await listArticles(centre.tenantId, admin), query),
  };
}

export type VoteAnswer = "counted" | "already" | "gone";

/** "Was this helpful?": counts a yes or a no, once per article per visitor per day. */
export async function voteOnHelpArticle(
  workspaceSlug: string,
  articleSlug: string,
  helpful: boolean,
  address: string,
  admin: SupabaseClient = getAdminClient(),
): Promise<VoteAnswer> {
  if (!helpCentreConfigured() || !SLUG.test(articleSlug)) return "gone";
  const centre = await findCentre(workspaceSlug, admin);
  if (!centre) return "gone";
  const key = visitorKey(centre.tenantId, address);
  if (!(await allowed(admin, centre.tenantId, "votes", key, LIMITS.votes))) return "already";
  // One answer per article: the article is folded into the fingerprint.
  const perArticle = createHash("sha256")
    .update(`${key}|${articleSlug}`)
    .digest("hex")
    .slice(0, 40);
  if (!(await allowed(admin, centre.tenantId, "vote", perArticle, LIMITS.vote))) return "already";
  const { data, error } = await admin.rpc("help_centre_vote", {
    p_tenant_id: centre.tenantId,
    p_slug: articleSlug,
    p_helpful: helpful,
  });
  return !error && data === true ? "counted" : "gone";
}
