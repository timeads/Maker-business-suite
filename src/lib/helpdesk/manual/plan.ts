import { tidyDoc, type RichDoc } from "../rich";
import type { TopicFacets } from "./config";
import { freshAdditions, mergeAdditions, type Addition } from "./sections";

/**
 * What to do with one reading of a conversation. Decided here, in code, from
 * the reading and the topic as it stands; Claude proposes points and nothing
 * more. The rule that matters most: a topic a person has edited is never
 * changed by a reading. What the reading would add waits as a suggested
 * update for a person to accept, edit or dismiss. (The database holds the
 * same rule in `apply_manual_reading`, so a person's edit made while a
 * reading was underway is safe as well.)
 */

export type TopicState = {
  id: string;
  title: string;
  summary: string;
  body: RichDoc;
  facets: TopicFacets;
  /** Whether a person has written or changed it. */
  personEdited: boolean;
};

export type Reading = {
  /** The existing topic it belongs to, by an id the code shortlisted; null for a new topic. */
  topicId: string | null;
  title: string;
  summary: string;
  facets: TopicFacets;
  additions: Addition[];
};

export type Planned =
  | { kind: "new"; title: string; summary: string; body: RichDoc; facets: TopicFacets }
  | {
      kind: "update";
      topicId: string;
      summary: string;
      body: RichDoc;
      facets: TopicFacets;
      additions: Addition[];
      newFacets: TopicFacets;
    }
  | { kind: "suggest"; topicId: string; additions: Addition[]; newFacets: TopicFacets }
  /** It belongs to a topic that already says all of it: only the link is kept. */
  | { kind: "seen"; topicId: string }
  | { kind: "nothing" };

const facetKey = (f: TopicFacets[number]) => `${f.facet}\n${f.value.toLowerCase()}`;

/** Facet values a topic doesn't have yet. */
export function newFacets(have: TopicFacets, proposed: TopicFacets): TopicFacets {
  const seen = new Set(have.map(facetKey));
  const out: TopicFacets = [];
  for (const facet of proposed) {
    if (seen.has(facetKey(facet))) continue;
    seen.add(facetKey(facet));
    out.push(facet);
  }
  return out;
}

export const joinFacets = (have: TopicFacets, more: TopicFacets): TopicFacets =>
  [...have, ...newFacets(have, more)].slice(0, 16);

export function planReading(
  reading: Reading,
  topic: TopicState | null,
  sections: readonly string[],
): Planned {
  if (!topic) {
    if (!reading.title.trim()) return { kind: "nothing" };
    const { doc, added } = mergeAdditions([], reading.additions, sections);
    if (added === 0) return { kind: "nothing" };
    return {
      kind: "new",
      title: reading.title.trim(),
      summary: reading.summary.trim(),
      body: tidyDoc(doc),
      facets: joinFacets([], reading.facets),
    };
  }
  const additions = freshAdditions(topic.body, reading.additions);
  const facets = newFacets(topic.facets, reading.facets);
  if (additions.length === 0 && facets.length === 0) return { kind: "seen", topicId: topic.id };
  if (topic.personEdited) {
    return { kind: "suggest", topicId: topic.id, additions, newFacets: facets };
  }
  return {
    kind: "update",
    topicId: topic.id,
    // The title and a summary already written stay as they are.
    summary: topic.summary.trim() || reading.summary.trim(),
    body: mergeAdditions(topic.body, additions, sections).doc,
    facets: joinFacets(topic.facets, facets),
    additions,
    newFacets: facets,
  };
}

/** A suggested update laid over the topic as it stands today, for "Accept". */
export function applySuggestion(
  topic: Pick<TopicState, "body" | "facets">,
  suggestion: { additions: Addition[]; newFacets: TopicFacets },
  sections: readonly string[],
): { body: RichDoc; facets: TopicFacets; added: number } {
  const { doc, added } = mergeAdditions(topic.body, suggestion.additions, sections);
  return { body: doc, facets: joinFacets(topic.facets, suggestion.newFacets), added };
}
