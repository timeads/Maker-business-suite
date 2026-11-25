import type { RichDoc } from "../rich";

/**
 * A topic is read by the whole team and may be dropped into a reply to
 * somebody else, so nothing that points at one customer may end up in it.
 * Claude is told so; this is the second lock, in code, run over the
 * conversation before it is sent and over everything that comes back before
 * it is saved: email addresses, phone-like numbers, order and tracking
 * numbers, street addresses and the customer's own name.
 */

export type ScrubFacts = {
  /** The customer's name as the ticket has it ("Pat Example"); more than one is fine. */
  names: string[];
};

const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9-]+(?:\.[A-Z0-9-]+)+/gi;
/** "#1042", "# 20431". */
const HASH_NUMBER = /#\s?\d{3,}\b/g;
/** "order 10432", "order no. TTW-10432", "invoice #883", "tracking 1Z…". The word stays, the number goes. */
const NAMED_NUMBER =
  /\b(order|invoice|receipt|ticket|tracking|confirmation|reference|ref)(\s*(?:number|num|no\.?|id|code)?\s*[:#]?\s*)(?=[A-Z0-9-]*\d{3})[A-Z0-9][A-Z0-9-]{2,}/gi;
const UPS_TRACKING = /\b1Z[0-9A-Z]{16}\b/gi;
/** Nine or more digits, however they are spaced or dashed: phone numbers, tracking, card numbers. */
const LONG_NUMBER = /(?<![\w.])\+?\(?\d[\d\s().-]{7,}\d(?![\w])/g;
const STREET =
  /\b\d{1,6}\s+(?:[A-Z][\w'.-]*\s+){1,4}(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Lane|Ln|Drive|Dr|Court|Ct|Way|Place|Pl|Terrace|Highway|Hwy)\b\.?(?:,?\s+(?:Apt|Apartment|Unit|Suite|Ste|#)\.?\s*[\w-]+)?/g;

/**
 * First names that are also everyday words. One of these on its own is left
 * alone unless it stands mid-sentence with a capital, so "it will jam" is
 * never rewritten for a customer called Will.
 */
const EVERYDAY = new Set(
  "will may mark rose art grace hope joy june april august bill pat rob sue jack don ray dawn faith penny iris ivy lily daisy olive amber ruby pearl jade sky summer autumn winter chase grant miles dean earl frank guy lance pierce wade drew cliff dale glen heath reed rich rusty sandy stone wood bob tom tim jim sam max ben dan ken lee kim van page rod gene norm skip buck cat fox wren robin jay".split(
    " ",
  ),
);

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function nameRules(facts: ScrubFacts): RegExp[] {
  const rules: RegExp[] = [];
  const seen = new Set<string>();
  for (const raw of facts.names) {
    const full = raw.replace(/\s+/g, " ").trim();
    if (full.length < 3 || full.includes("@")) continue;
    const parts = full.split(" ").filter((part) => /^\p{L}[\p{L}'’-]+$/u.test(part));
    if (parts.length > 1 && !seen.has(full.toLowerCase())) {
      seen.add(full.toLowerCase());
      // The whole name, in any letter case, with any spacing between its parts.
      rules.push(
        new RegExp(
          `(?<![\\p{L}\\p{N}])${parts.map(escape).join("\\s+")}(?:['’]s)?(?![\\p{L}\\p{N}])`,
          "giu",
        ),
      );
    }
    for (const part of parts) {
      const key = part.toLowerCase();
      if (part.length < 3 || seen.has(key)) continue;
      seen.add(key);
      const capital = escape(part[0].toUpperCase() + part.slice(1).toLowerCase());
      rules.push(
        EVERYDAY.has(key)
          ? // Only with a capital, and only when it doesn't begin a sentence or a line.
            new RegExp(`(?<=[\\p{L}\\p{N},;:] )${capital}(?:['’]s)?(?![\\p{L}\\p{N}])`, "gu")
          : new RegExp(`(?<![\\p{L}\\p{N}])${escape(part)}(?:['’]s)?(?![\\p{L}\\p{N}])`, "giu"),
      );
    }
  }
  return rules;
}

const digits = (text: string) => text.replace(/\D/g, "").length;

/** One piece of text with everything that points at a customer taken out. */
export function scrub(text: string, facts: ScrubFacts = { names: [] }): string {
  let out = text
    .replace(EMAIL, "(email removed)")
    .replace(UPS_TRACKING, "(number removed)")
    .replace(NAMED_NUMBER, (_all, word: string) => `${word} (number removed)`)
    .replace(HASH_NUMBER, "(number removed)")
    .replace(STREET, "(address removed)")
    .replace(LONG_NUMBER, (match) => (digits(match) >= 9 ? "(number removed)" : match));
  for (const rule of nameRules(facts)) {
    out = out.replace(rule, (match) => (/['’]s$/.test(match) ? "the customer's" : "the customer"));
  }
  return out.replace(/(\(number removed\))(?:\s*\1)+/g, "$1");
}

/** The same over a document: every run's text, nothing else touched. */
export function scrubDoc(doc: RichDoc, facts: ScrubFacts = { names: [] }): RichDoc {
  const runs = <R extends { text: string }>(list: R[]) =>
    list.map((run) => ({ ...run, text: scrub(run.text, facts) }));
  return doc.map((block) =>
    block.t === "p"
      ? { ...block, runs: runs(block.runs) }
      : { ...block, items: block.items.map(runs) },
  );
}

/** Whether a piece of text still holds something `scrub` would take out. For tests and a last check. */
export const needsScrub = (text: string, facts: ScrubFacts = { names: [] }): boolean =>
  scrub(text, facts) !== text;
