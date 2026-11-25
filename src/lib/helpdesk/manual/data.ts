import type { SupabaseClient } from "@supabase/supabase-js";
import { HELPDESK_MODULE } from "../config";
import { parseRichDoc, type RichDoc } from "../rich";
import {
  MANUAL_KEY,
  parseManual,
  parseTopicFacets,
  type ManualConfig,
  type TopicFacets,
} from "./config";
import type { Entry } from "./search";
import { docText, type Addition } from "./sections";

/**
 * What the manual's pages read, as the signed-in member (row-level security
 * decides what comes back). Nothing here asks a model anything.
 */

export type Topic = {
  id: string;
  title: string;
  summary: string;
  body: RichDoc;
  facets: TopicFacets;
  status: "draft" | "published";
  source: "ai" | "person";
  useInDrafts: boolean;
  personEdited: boolean;
  lastBuiltAt: string | null;
  updatedAt: string;
};

export type Article = {
  id: string;
  title: string;
  body: RichDoc;
  tags: string[];
  shareable: boolean;
  updatedAt: string;
  /** internal: for the team only. draft: a help article in the making. published: on the public help centre. */
  publicState: "internal" | "draft" | "published";
  /** The last part of its public address, once it has one. */
  slug: string | null;
  category: string | null;
  /** The line for lists and search results on the help centre. */
  summary: string;
  publicUpdatedAt: string | null;
  helpfulYes: number;
  helpfulNo: number;
};

type TopicRow = {
  id: string;
  title: string;
  summary: string;
  body: unknown;
  facets: unknown;
  status: string;
  source: string;
  use_in_drafts: boolean;
  person_edited_at: string | null;
  last_built_at: string | null;
  updated_at: string;
};
const TOPIC_COLUMNS =
  "id, title, summary, body, facets, status, source, use_in_drafts, person_edited_at, last_built_at, updated_at";

const toTopic = (row: TopicRow): Topic => ({
  id: row.id,
  title: row.title,
  summary: row.summary,
  body: parseRichDoc(row.body) ?? [],
  facets: parseTopicFacets(row.facets),
  status: row.status === "published" ? "published" : "draft",
  source: row.source === "ai" ? "ai" : "person",
  useInDrafts: row.use_in_drafts,
  personEdited: row.person_edited_at !== null,
  lastBuiltAt: row.last_built_at,
  updatedAt: row.updated_at,
});

type ArticleRow = {
  id: string;
  title: string;
  body: unknown;
  tags: string[] | null;
  shareable: boolean;
  updated_at: string;
  public_state: string;
  slug: string | null;
  category: string | null;
  summary: string | null;
  public_updated_at: string | null;
  helpful_yes: number | null;
  helpful_no: number | null;
};
const ARTICLE_COLUMNS =
  "id, title, body, tags, shareable, updated_at, public_state, slug, category, summary, public_updated_at, helpful_yes, helpful_no";
const toArticle = (row: ArticleRow): Article => ({
  id: row.id,
  title: row.title,
  body: parseRichDoc(row.body) ?? [],
  tags: row.tags ?? [],
  shareable: row.shareable,
  updatedAt: row.updated_at,
  publicState:
    row.public_state === "published" || row.public_state === "draft"
      ? row.public_state
      : "internal",
  slug: row.slug,
  category: row.category,
  summary: row.summary ?? "",
  publicUpdatedAt: row.public_updated_at,
  helpfulYes: row.helpful_yes ?? 0,
  helpfulNo: row.helpful_no ?? 0,
});

export async function loadManualConfig(
  supabase: SupabaseClient,
  tenantId: string,
): Promise<ManualConfig> {
  const { data } = await supabase
    .from("configs")
    .select("body")
    .eq("tenant_id", tenantId)
    .eq("module", HELPDESK_MODULE)
    .eq("key", MANUAL_KEY)
    .maybeSingle();
  return parseManual(data?.body);
}

export async function loadTopics(supabase: SupabaseClient, tenantId: string): Promise<Topic[]> {
  const { data } = await supabase
    .from("manual_topics")
    .select(TOPIC_COLUMNS)
    .eq("tenant_id", tenantId)
    .order("title")
    .limit(500);
  return ((data ?? []) as TopicRow[]).map(toTopic);
}

export async function loadTopic(
  supabase: SupabaseClient,
  tenantId: string,
  id: string,
): Promise<Topic | null> {
  if (!/^[0-9a-f-]{36}$/.test(id)) return null;
  const { data } = await supabase
    .from("manual_topics")
    .select(TOPIC_COLUMNS)
    .eq("tenant_id", tenantId)
    .eq("id", id)
    .maybeSingle();
  return data ? toTopic(data as TopicRow) : null;
}

export async function loadArticles(supabase: SupabaseClient, tenantId: string): Promise<Article[]> {
  const { data } = await supabase
    .from("manual_articles")
    .select(ARTICLE_COLUMNS)
    .eq("tenant_id", tenantId)
    .order("title")
    .limit(500);
  return ((data ?? []) as ArticleRow[]).map(toArticle);
}

export async function loadArticle(
  supabase: SupabaseClient,
  tenantId: string,
  id: string,
): Promise<Article | null> {
  if (!/^[0-9a-f-]{36}$/.test(id)) return null;
  const { data } = await supabase
    .from("manual_articles")
    .select(ARTICLE_COLUMNS)
    .eq("tenant_id", tenantId)
    .eq("id", id)
    .maybeSingle();
  return data ? toArticle(data as ArticleRow) : null;
}

export type Suggestion = {
  id: string;
  additions: Addition[];
  newFacets: TopicFacets;
  ticketIds: string[];
  createdAt: string;
};

/** What a row's `additions` holds, as points we can show; anything else is dropped. */
export function parseAdditions(value: unknown): Addition[] {
  if (!Array.isArray(value)) return [];
  const out: Addition[] = [];
  for (const one of value) {
    const section = typeof one?.section === "string" ? one.section.slice(0, 60) : "";
    const points = Array.isArray(one?.points)
      ? one.points.filter((p: unknown) => typeof p === "string").map((p: string) => p.slice(0, 400))
      : [];
    if (section && points.length > 0) out.push({ section, points: points.slice(0, 12) });
  }
  return out.slice(0, 12);
}

export async function loadSuggestions(
  supabase: SupabaseClient,
  tenantId: string,
  topicId: string,
): Promise<Suggestion[]> {
  const { data } = await supabase
    .from("manual_suggestions")
    .select("id, additions, new_facets, ticket_ids, created_at")
    .eq("tenant_id", tenantId)
    .eq("topic_id", topicId)
    .eq("status", "pending")
    .order("created_at");
  return (
    (data ?? []) as {
      id: string;
      additions: unknown;
      new_facets: unknown;
      ticket_ids: string[] | null;
      created_at: string;
    }[]
  ).map((row) => ({
    id: row.id,
    additions: parseAdditions(row.additions),
    newFacets: parseTopicFacets(row.new_facets),
    ticketIds: row.ticket_ids ?? [],
    createdAt: row.created_at,
  }));
}

export const topicEntry = (topic: Topic): Entry => ({
  id: topic.id,
  kind: "topic",
  title: topic.title,
  summary: topic.summary,
  labels: topic.facets.map((f) => f.value),
  text: docText(topic.body),
});

export const articleEntry = (article: Article): Entry => ({
  id: article.id,
  kind: "article",
  title: article.title,
  summary: "",
  labels: article.tags,
  text: docText(article.body),
});

/** How many topics may be handed to a reply draft, and how much of each. */
export const DRAFT_TOPICS = 3;
export const DRAFT_TOPIC_CHARS = 3000;

/** "Nov 3, 2026" on the workspace's own clock. */
export function manualDay(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(iso));
}
