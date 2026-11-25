/**
 * Finding topics and articles by their words. Plain text matching, done in
 * the app over what the member has already read: no model is asked, on a
 * page load or anywhere else. Three callers, one ranking:
 *  - the search box (every word typed must be found),
 *  - the shortlist of existing topics shown to Claude with a conversation,
 *  - the few topics suggested beside a conversation.
 */

export type Entry = {
  id: string;
  kind: "topic" | "article";
  title: string;
  summary: string;
  /** Facet values or tags. */
  labels: string[];
  /** The body as plain text. */
  text: string;
};

const STOP = new Set(
  "the a an and or but if then so to of in on at for from by with without about into over under is are was were be been being am do does did done have has had having it its this that these those i you he she we they me my your our their them his her not no yes can could would should will just very really also too more most some any all each please thanks thank hello hi hey dear regards best sincerely kind there here when where what which who how why got get getting one two new now still after before again when sent email message reply order".split(
    " ",
  ),
);

/** A text's words, lower case, without the ones every email has; plurals folded together. */
export function words(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (raw.length < 2 || STOP.has(raw)) continue;
    out.push(raw.length > 3 && raw.endsWith("s") && !raw.endsWith("ss") ? raw.slice(0, -1) : raw);
  }
  return out;
}

type Indexed = {
  entry: Entry;
  title: Set<string>;
  labels: Set<string>;
  summary: Set<string>;
  text: Set<string>;
};

const index = (entry: Entry): Indexed => ({
  entry,
  title: new Set(words(entry.title)),
  labels: new Set(entry.labels.flatMap(words)),
  summary: new Set(words(entry.summary)),
  text: new Set(words(entry.text)),
});

const WEIGHT = { title: 6, labels: 5, summary: 3, text: 1 } as const;

/** A typed word matches a word that starts with it, once it is three letters long. */
function has(set: Set<string>, word: string, prefix: boolean): boolean {
  if (set.has(word)) return true;
  if (!prefix || word.length < 3) return false;
  for (const one of set) if (one.startsWith(word)) return true;
  return false;
}

function wordScore(doc: Indexed, word: string, prefix: boolean): number {
  if (has(doc.title, word, prefix)) return WEIGHT.title;
  if (has(doc.labels, word, prefix)) return WEIGHT.labels;
  if (has(doc.summary, word, prefix)) return WEIGHT.summary;
  if (has(doc.text, word, prefix)) return WEIGHT.text;
  return 0;
}

/**
 * The search box: every word typed must be somewhere in the entry; a word in
 * the title counts for most, then a label, the summary, the body. An empty
 * search keeps the order given.
 */
export function searchEntries<E extends Entry>(entries: E[], query: string): E[] {
  const asked = [...new Set(words(query))];
  if (asked.length === 0) return query.trim() ? [] : entries;
  const scored: { entry: E; score: number; at: number }[] = [];
  entries.forEach((entry, at) => {
    const doc = index(entry);
    let score = 0;
    for (const word of asked) {
      const one = wordScore(doc, word, true);
      if (one === 0) return;
      score += one;
    }
    scored.push({ entry, score, at });
  });
  return scored.sort((a, b) => b.score - a.score || a.at - b.at).map((row) => row.entry);
}

export type Match<E extends Entry> = { entry: E; score: number; shared: string[] };

/**
 * The entries closest to a long piece of text (a conversation). Each word the
 * two share counts by where the entry has it and by how rare it is among the
 * entries, so "needle" in three topics says more than "machine" in all of
 * them. An entry needs `minShared` shared words in its title, labels or
 * summary to count at all.
 */
export function closestEntries<E extends Entry>(
  entries: E[],
  text: string,
  options: { limit: number; minShared?: number },
): Match<E>[] {
  const asked = new Set(words(text));
  if (asked.size === 0 || entries.length === 0) return [];
  const docs = entries.map(index);
  const seenIn = new Map<string, number>();
  for (const doc of docs) {
    for (const word of new Set([...doc.title, ...doc.labels, ...doc.summary, ...doc.text])) {
      if (asked.has(word)) seenIn.set(word, (seenIn.get(word) ?? 0) + 1);
    }
  }
  const rarity = (word: string) => Math.log(1 + docs.length / (seenIn.get(word) ?? 1));
  const minShared = options.minShared ?? 1;
  const out: (Match<E> & { at: number })[] = [];
  docs.forEach((doc, at) => {
    let score = 0;
    const shared: string[] = [];
    for (const word of asked) {
      const one = wordScore(doc, word, false);
      if (one === 0) continue;
      score += one * rarity(word);
      if (one > WEIGHT.text) shared.push(word);
    }
    if (shared.length < minShared) return;
    out.push({ entry: entries[at], score, shared, at });
  });
  return out
    .sort((a, b) => b.score - a.score || a.at - b.at)
    .slice(0, options.limit)
    .map(({ entry, score, shared }) => ({ entry, score, shared }));
}
