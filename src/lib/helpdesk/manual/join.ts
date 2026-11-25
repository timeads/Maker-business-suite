import { tidyDoc, type RichDoc, type RichRun } from "../rich";
import { facetValues, type TopicFacets } from "./config";
import { joinFacets } from "./plan";
import { mergeAdditions, splitSections, type Addition } from "./sections";

/**
 * Putting two topics together, and copying one under another label. Both are
 * done in code, by rules a person can predict: no model rewrites anything.
 */

const text = (runs: RichRun[]) =>
  runs
    .map((run) => run.text)
    .join("")
    .replace(/\s+/g, " ")
    .trim();

/** A topic's body as points under its headings; writing above the first heading goes under `fallback`. */
export function bodyAsAdditions(doc: RichDoc, fallback: string): Addition[] {
  const out: Addition[] = [];
  for (const section of splitSections(doc)) {
    const points: string[] = [];
    for (const block of section.blocks) {
      if (block.t === "p") {
        const line = text(block.runs);
        if (line) points.push(line);
      } else {
        for (const item of block.items) {
          const line = text(item);
          if (line) points.push(line);
        }
      }
    }
    if (points.length > 0) out.push({ section: section.heading ?? fallback, points });
  }
  return out;
}

export type Joinable = { body: RichDoc; facets: TopicFacets };

/**
 * `from` folded into `into`. Nothing written in `into` is changed, moved or
 * removed: each thing `from` says that `into` doesn't already say is added as
 * a point under the same heading (a heading `into` lacks is added where the
 * workspace's order puts it). Labels are joined without repeats.
 */
export function joinTopics(
  into: Joinable,
  from: Joinable,
  sections: readonly string[],
): { body: RichDoc; facets: TopicFacets; added: number } {
  const fallback = sections[sections.length - 1] ?? "Notes";
  const { doc, added } = mergeAdditions(into.body, bodyAsAdditions(from.body, fallback), sections);
  return { body: tidyDoc(doc), facets: joinFacets(into.facets, from.facets), added };
}

/**
 * A topic's labels for a copy made "for another <label>": the values of that
 * one label are replaced by what was typed; every other label is kept.
 * Null when nothing usable was typed, or it is what the topic already has.
 */
export function copyFacets(
  facets: TopicFacets,
  facetId: string,
  typed: string,
): TopicFacets | null {
  const next = facetValues(facetId, typed);
  if (next.length === 0) return null;
  const had = facets
    .filter((f) => f.facet === facetId)
    .map((f) => f.value.toLowerCase())
    .sort()
    .join("\n");
  const now = next
    .map((f) => f.value.toLowerCase())
    .sort()
    .join("\n");
  if (had === now) return null;
  return [...facets.filter((f) => f.facet !== facetId), ...next].slice(0, 16);
}

/** The copy's starting title: the original's, with the new label after it. */
export const copyTitle = (title: string, values: TopicFacets): string =>
  `${title.trim()} (${values.map((f) => f.value).join(", ")})`.slice(0, 160);
