import { z } from "zod";

/**
 * A reply with simple formatting, as a small document rather than as HTML.
 * The editor in the browser hands one of these over; the server checks it
 * with this schema and writes the email's HTML and its plain-text part
 * itself. So the only HTML that ever leaves is HTML built here, from this
 * short list: paragraphs, line breaks, bold, italic, underline, strike,
 * bulleted and numbered lists, and links to http(s) or mailto addresses.
 * Nothing a customer wrote is ever passed through as markup.
 */

const LINK = /^(https?:\/\/|mailto:)[^\s<>"']{1,500}$/i;

const runSchema = z.object({
  text: z.string().max(20_000),
  b: z.boolean().optional(),
  i: z.boolean().optional(),
  u: z.boolean().optional(),
  s: z.boolean().optional(),
  href: z.string().regex(LINK).optional(),
});
export type RichRun = z.infer<typeof runSchema>;

const runs = z.array(runSchema).max(400);
const blockSchema = z.discriminatedUnion("t", [
  z.object({ t: z.literal("p"), runs }),
  z.object({ t: z.literal("ul"), items: z.array(runs).max(100) }),
  z.object({ t: z.literal("ol"), items: z.array(runs).max(100) }),
]);
export type RichBlock = z.infer<typeof blockSchema>;

export const richDocSchema = z.array(blockSchema).max(400);
export type RichDoc = z.infer<typeof richDocSchema>;

/** A stored or submitted document, or null when it isn't one. */
export function parseRichDoc(value: unknown): RichDoc | null {
  const parsed = richDocSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export const isSafeLink = (href: string): boolean => LINK.test(href.trim());

const escapeHtml = (text: string) =>
  text.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );

function runHtml(run: RichRun): string {
  let html = escapeHtml(run.text).replace(/\n/g, "<br>");
  if (!html) return "";
  if (run.b) html = `<strong>${html}</strong>`;
  if (run.i) html = `<em>${html}</em>`;
  if (run.u) html = `<u>${html}</u>`;
  if (run.s) html = `<s>${html}</s>`;
  if (run.href && isSafeLink(run.href)) html = `<a href="${escapeHtml(run.href)}">${html}</a>`;
  return html;
}

/** The email's HTML part. Every character of text is escaped; every tag is one of ours. */
export function richToHtml(doc: RichDoc): string {
  return doc
    .map((block) => {
      if (block.t === "p") return `<p>${block.runs.map(runHtml).join("") || "<br>"}</p>`;
      const items = block.items.map((item) => `<li>${item.map(runHtml).join("")}</li>`).join("");
      return `<${block.t}>${items}</${block.t}>`;
    })
    .join("");
}

const runText = (run: RichRun) =>
  run.href && run.href !== run.text && `mailto:${run.text}` !== run.href
    ? `${run.text} (${run.href})`
    : run.text;

/** The plain-text part, and what is kept as the message's words. */
export function richToText(doc: RichDoc): string {
  return doc
    .map((block) => {
      if (block.t === "p") return block.runs.map(runText).join("");
      return block.items
        .map((item, i) => `${block.t === "ol" ? `${i + 1}.` : "•"} ${item.map(runText).join("")}`)
        .join("\n");
    })
    .join("\n\n")
    .replace(/ /g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Plain text as a document: blank lines part paragraphs, single breaks stay inside one. */
export function textToRich(text: string): RichDoc {
  return text
    .replace(/\r\n?/g, "\n")
    .split(/\n{2,}/)
    .map((part) => part.replace(/^\n+|\n+$/g, ""))
    .filter((part) => part.length > 0)
    .map((part) => ({ t: "p" as const, runs: [{ text: part }] }));
}

/** Whether any formatting is used at all; a plain reply needs no HTML part. */
export function isPlain(doc: RichDoc): boolean {
  return doc.every(
    (block) =>
      block.t === "p" &&
      block.runs.every((run) => !run.b && !run.i && !run.u && !run.s && !run.href),
  );
}

/** Drops empty runs, joins neighbours that look the same, and trims empty paragraphs off both ends. */
export function tidyDoc(doc: RichDoc): RichDoc {
  const same = (a: RichRun, b: RichRun) =>
    !!a.b === !!b.b && !!a.i === !!b.i && !!a.u === !!b.u && !!a.s === !!b.s && a.href === b.href;
  const tidyRuns = (list: RichRun[]) => {
    const out: RichRun[] = [];
    for (const run of list) {
      if (!run.text) continue;
      const last = out[out.length - 1];
      if (last && same(last, run)) last.text += run.text;
      else out.push({ ...run });
    }
    return out;
  };
  const blocks: RichDoc = doc.map((block) =>
    block.t === "p"
      ? { t: "p", runs: tidyRuns(block.runs) }
      : { t: block.t, items: block.items.map(tidyRuns).filter((item) => item.length > 0) },
  );
  const empty = (block: RichBlock) =>
    block.t === "p" ? block.runs.every((run) => !run.text.trim()) : block.items.length === 0;
  while (blocks.length > 0 && empty(blocks[0])) blocks.shift();
  while (blocks.length > 0 && empty(blocks[blocks.length - 1])) blocks.pop();
  return blocks.filter((block) => block.t === "p" || block.items.length > 0);
}
