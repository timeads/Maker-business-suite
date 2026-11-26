/**
 * "Finish setting up": the generic part, for any tool (docs/setup-pattern.md).
 * A tool works out its own open items from what the workspace already has,
 * on read, and hands them here; nothing about an item is stored except a
 * person's "Not now" (`setup_not_now`), kept with a fingerprint of the facts
 * the item was about. When those facts change (a new debt needs a rate) the
 * fingerprint differs and the item is open again by itself. Pure.
 */

export type SetupItem = {
  /** Unique within the tool, lower case: `lines`, `debt.rates`. */
  id: string;
  /** What to do, in plain words: "Add the rate to 2 debts". */
  title: string;
  /** Why it matters, in one line. */
  why: string;
  /** How many things it is about, where that helps. */
  count?: number;
  /** Names it is about, where that helps (shown under the title, a few at most). */
  names?: string[];
  /** Where it is fixed: a path inside the workspace with its anchor or query. */
  to: string;
  /** The words on the link ("Add the rates"). */
  action: string;
  /**
   * The facts the item is about, as plain text (ids and counts, never figures
   * or names): "Not now" keeps only their fingerprint.
   */
  facts: string;
  /** Which step of the guided setup takes care of it. */
  step: string;
};

export type NotNow = { item: string; fingerprint: string };

/** A short, stable fingerprint of an item's facts (FNV-1a, 32 bits, base 36). */
export function fingerprint(facts: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < facts.length; i++) {
    hash ^= facts.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36);
}

/**
 * Which items are open and which a person said "Not now" to, for the facts
 * they show now. A "Not now" on older facts no longer counts.
 */
export function sortItems(
  items: readonly SetupItem[],
  notNow: readonly NotNow[],
): { open: SetupItem[]; resting: SetupItem[] } {
  const said = new Map(notNow.map((n) => [n.item, n.fingerprint]));
  const open: SetupItem[] = [];
  const resting: SetupItem[] = [];
  for (const item of items) {
    (said.get(item.id) === fingerprint(item.facts) ? resting : open).push(item);
  }
  return { open, resting };
}

const NUMBER_WORDS = ["No", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine"];

/** "3 things would make these figures truer", with the tool's own ending. */
export function cardTitle(open: number, ending = "would make these figures truer"): string {
  const n = open < NUMBER_WORDS.length ? NUMBER_WORDS[open] : String(open);
  return `${n} ${open === 1 ? "thing" : "things"} ${ending}`;
}

export type SetupStep = {
  id: string;
  title: string;
  /** Shown only to owners and admins (the database holds the same line for what they read). */
  managersOnly?: boolean;
};

/**
 * The step to land on: the first whose items are still open, else the last
 * (the review). Progress is the facts, never stored.
 */
export function firstOpenStep(steps: readonly SetupStep[], open: readonly SetupItem[]): string {
  const waiting = new Set(open.map((item) => item.step));
  return (steps.find((step) => waiting.has(step.id)) ?? steps[steps.length - 1]).id;
}

/** Open items per step, for each step's "n to do". */
export function openByStep(open: readonly SetupItem[]): Map<string, SetupItem[]> {
  const out = new Map<string, SetupItem[]>();
  for (const item of open) out.set(item.step, [...(out.get(item.step) ?? []), item]);
  return out;
}

/** "A, B and 3 more": a few names, never a long list. */
export function someNames(names: readonly string[], shown = 3): string {
  if (names.length === 0) return "";
  if (names.length <= shown) {
    return names.length === 1
      ? names[0]
      : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  }
  return `${names.slice(0, shown).join(", ")} and ${names.length - shown} more`;
}
