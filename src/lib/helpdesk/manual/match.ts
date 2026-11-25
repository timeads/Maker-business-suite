import type { SupabaseClient } from "@supabase/supabase-js";
import { splitQuote } from "../thread";
import type { RichDoc } from "../rich";
import {
  DRAFT_TOPICS,
  DRAFT_TOPIC_CHARS,
  articleEntry,
  loadArticles,
  loadManualConfig,
  loadTopics,
  topicEntry,
  type Topic,
} from "./data";
import { closestEntries } from "./search";
import { docText } from "./sections";

/**
 * The published topics that fit a conversation, found by its words (the
 * subject and the customer's latest message) against the topics' words. No
 * model is asked: this runs on a page load, as the member.
 */

export type TopicMatch = { id: string; title: string; summary: string; labels: string[] };

export function conversationWords(
  subject: string,
  messages: { direction: string; body: string }[],
): string {
  const latest = [...messages].reverse().find((m) => m.direction === "inbound");
  return `${subject}\n${latest ? splitQuote(latest.body).own.slice(0, 4000) : ""}`;
}

/** The closest few published topics. Two shared words in a title, label or summary, at least. */
export function pickTopics(topics: Topic[], words: string, limit: number): Topic[] {
  const published = topics.filter((topic) => topic.status === "published");
  const byId = new Map(published.map((topic) => [topic.id, topic]));
  return closestEntries(published.map(topicEntry), words, { limit, minShared: 2 }).map((match) =>
    byId.get(match.entry.id)!,
  );
}

/** For the details rail: the manual's name and up to three topics that match. Never throws. */
export async function loadRailTopics(
  supabase: SupabaseClient,
  tenantId: string,
  subject: string,
  messages: { direction: string; body: string }[],
): Promise<{ name: string; topics: TopicMatch[] }> {
  try {
    const [config, topics] = await Promise.all([
      loadManualConfig(supabase, tenantId),
      loadTopics(supabase, tenantId),
    ]);
    return {
      name: config.name,
      topics: pickTopics(topics, conversationWords(subject, messages), 3).map((topic) => ({
        id: topic.id,
        title: topic.title,
        summary: topic.summary,
        labels: topic.facets.map((f) => f.value).slice(0, 3),
      })),
    };
  } catch {
    return { name: "Manual", topics: [] };
  }
}

/**
 * For the "AI" reply draft: the few published topics and articles that match,
 * as reference, when the workspace allows it. Their text only, cut to length.
 */
export async function loadDraftTopics(
  supabase: SupabaseClient,
  tenantId: string,
  subject: string,
  messages: { direction: string; body: string }[],
): Promise<{ title: string; text: string }[]> {
  try {
    const config = await loadManualConfig(supabase, tenantId);
    if (!config.use_in_drafts) return [];
    const [topics, articles] = await Promise.all([
      loadTopics(supabase, tenantId),
      loadArticles(supabase, tenantId),
    ]);
    const bodies = new Map<string, RichDoc>();
    const entries = [
      ...topics
        .filter((topic) => topic.status === "published" && topic.useInDrafts)
        .map((topic) => {
          bodies.set(topic.id, topic.body);
          return topicEntry(topic);
        }),
      ...articles.map((article) => {
        bodies.set(article.id, article.body);
        return articleEntry(article);
      }),
    ];
    return closestEntries(entries, conversationWords(subject, messages), {
      limit: DRAFT_TOPICS,
      minShared: 2,
    }).map((match) => ({
      title: match.entry.title,
      text: docText(bodies.get(match.entry.id) ?? []).slice(0, DRAFT_TOPIC_CHARS),
    }));
  } catch {
    return [];
  }
}
