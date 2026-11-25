import { tidyDoc, type RichBlock, type RichDoc, type RichRun } from "../rich";

/**
 * A topic's body is one small document (lib/helpdesk/rich.ts). Its sections
 * are marked the plainest way that document can: a short paragraph that is
 * bold from end to end is a heading, and what follows belongs to it. So the
 * same editor writes a topic as writes a reply, and "add this to What to do"
 * can be done by code instead of by asking a model to rewrite the page.
 */

export type Section = { heading: string | null; blocks: RichDoc };

const text = (runs: RichRun[]) => runs.map((run) => run.text).join("");

/** The heading a block is, or null when it is ordinary writing. */
export function headingOf(block: RichBlock): string | null {
  if (block.t !== "p" || block.runs.length === 0) return null;
  if (!block.runs.every((run) => run.b && !run.href)) return null;
  const words = text(block.runs).trim();
  if (!words || words.length > 60 || words.includes("\n")) return null;
  return words;
}

export const headingBlock = (heading: string): RichBlock => ({
  t: "p",
  runs: [{ text: heading, b: true }],
});

/** The document as its sections, in order. Writing before the first heading has none. */
export function splitSections(doc: RichDoc): Section[] {
  const out: Section[] = [];
  for (const block of doc) {
    const heading = headingOf(block);
    if (heading !== null) {
      out.push({ heading, blocks: [] });
      continue;
    }
    if (out.length === 0) out.push({ heading: null, blocks: [] });
    out[out.length - 1].blocks.push(block);
  }
  return out;
}

export function joinSections(sections: Section[]): RichDoc {
  return sections.flatMap((section) => [
    ...(section.heading === null ? [] : [headingBlock(section.heading)]),
    ...section.blocks,
  ]);
}

/** What Claude (or anyone) proposes to add: plain points under a named section. */
export type Addition = { section: string; points: string[] };

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** A point with its case, spacing and punctuation taken off, to spot one said twice. */
export const pointKey = (point: string) =>
  point
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

function sectionPoints(section: Section): Set<string> {
  const keys = new Set<string>();
  for (const block of section.blocks) {
    if (block.t === "p") {
      for (const line of text(block.runs).split("\n")) keys.add(pointKey(line));
    } else {
      for (const item of block.items) keys.add(pointKey(text(item)));
    }
  }
  keys.delete("");
  return keys;
}

/**
 * Adds points to a document, each under its section, and says how many went
 * in. Nothing already written is changed, moved or removed: a point is put
 * at the end of its section's last list (or in a new list there), a section
 * that isn't in the document yet is put where `order` says it belongs, and a
 * point the section already makes is left out.
 */
export function mergeAdditions(
  doc: RichDoc,
  additions: Addition[],
  order: readonly string[],
): { doc: RichDoc; added: number } {
  const sections = splitSections(doc).map((section) => ({
    heading: section.heading,
    blocks: section.blocks.map((block) =>
      block.t === "p"
        ? { ...block, runs: block.runs.map((run) => ({ ...run })) }
        : { ...block, items: block.items.map((item) => item.map((run) => ({ ...run }))) },
    ),
  }));
  const rank = (heading: string | null) => {
    if (heading === null) return -1;
    const at = order.findIndex((name) => same(name, heading));
    return at === -1 ? order.length : at;
  };
  let added = 0;
  for (const addition of additions) {
    const points = addition.points.map((point) => point.trim()).filter(Boolean);
    if (!addition.section.trim() || points.length === 0) continue;
    let section = sections.find((s) => s.heading !== null && same(s.heading, addition.section));
    if (!section) {
      section = { heading: addition.section.trim(), blocks: [] };
      const mine = rank(section.heading);
      // Before the first section that comes later in the usual order; else at the end.
      const before = sections.findIndex(
        (s) => rank(s.heading) > mine && rank(s.heading) < order.length,
      );
      if (before === -1 || mine >= order.length) sections.push(section);
      else sections.splice(before, 0, section);
    }
    const have = sectionPoints(section);
    const fresh: string[] = [];
    for (const point of points) {
      const key = pointKey(point);
      if (!key || have.has(key)) continue;
      have.add(key);
      fresh.push(point);
    }
    if (fresh.length === 0) continue;
    const last = section.blocks[section.blocks.length - 1];
    const items = fresh.map((point) => [{ text: point }]);
    if (last && last.t === "ul") last.items.push(...items);
    else section.blocks.push({ t: "ul", items });
    added += fresh.length;
  }
  return { doc: added > 0 ? tidyDoc(joinSections(sections)) : doc, added };
}

/** The additions that would really add something to a document, as `mergeAdditions` sees it. */
export function freshAdditions(doc: RichDoc, additions: Addition[]): Addition[] {
  const sections = splitSections(doc);
  const out: Addition[] = [];
  for (const addition of additions) {
    const section = sections.find((s) => s.heading !== null && same(s.heading, addition.section));
    const have = section ? sectionPoints(section) : new Set<string>();
    const points: string[] = [];
    for (const point of addition.points) {
      const key = pointKey(point);
      if (!key || have.has(key)) continue;
      have.add(key);
      points.push(point.trim());
    }
    if (points.length > 0) out.push({ section: addition.section.trim(), points });
  }
  return out;
}

/** A section's words as plain text, for dropping into a reply. */
export function sectionText(section: Section): string {
  return section.blocks
    .map((block) =>
      block.t === "p"
        ? text(block.runs)
        : block.items
            .map((item, i) => `${block.t === "ol" ? `${i + 1}.` : "•"} ${text(item)}`)
            .join("\n"),
    )
    .join("\n\n")
    .trim();
}

/** The whole document as plain text, headings on their own lines. For search and for prompts. */
export function docText(doc: RichDoc): string {
  return splitSections(doc)
    .map((section) => [section.heading, sectionText(section)].filter(Boolean).join("\n"))
    .join("\n\n")
    .trim();
}
