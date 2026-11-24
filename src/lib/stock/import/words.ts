import type { ImportKind } from "./files";

/** How many came out new, changed, or already as the file says. */
export type ImportCounts = {
  new: number;
  changed: number;
  same: number;
  suppliers_added?: number;
  lines?: number;
  unmatched?: number;
};

export const plural = (n: number, one: string, many = `${one}s`) =>
  `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

/** What the counts mean for each kind of file, in the words on the page. */
export function countLines(kind: ImportKind, counts: ImportCounts, done: boolean): string[] {
  const will = (now: string, then: string) => (done ? then : now);
  const lines: string[] = [];
  const add = (n: number | undefined, text: (n: number) => string) => {
    if (n && n > 0) lines.push(text(n));
  };
  if (kind === "suppliers") {
    add(counts.new, (n) => `${plural(n, "new supplier")} ${will("to add", "added")}`);
    add(counts.changed, (n) => `${plural(n, "supplier")} ${will("to change", "changed")}`);
    add(counts.same, (n) => `${plural(n, "supplier")} already as the file says`);
  } else if (kind === "items") {
    add(counts.changed, (n) => `${plural(n, "item")} ${will("to change", "changed")}`);
    add(counts.same, (n) => `${plural(n, "item")} already as the file says`);
  } else if (kind === "orders") {
    add(
      counts.new,
      (n) =>
        `${plural(n, "order")} ${will("to bring in", "brought in")}${counts.lines ? `, with ${plural(counts.lines, "line")}` : ""}`,
    );
    add(
      counts.same,
      (n) => `${plural(n, "order")} already here, left as ${n === 1 ? "it is" : "they are"}`,
    );
  } else if (kind === "ledger") {
    add(counts.new, (n) => `${plural(n, "new entry", "new entries")} ${will("to add", "added")}`);
    add(
      counts.changed,
      (n) => `${plural(n, "entry", "entries")} ${will("to correct", "corrected")}`,
    );
    add(counts.same, (n) => `${plural(n, "entry", "entries")} already here`);
  } else if (kind === "counts") {
    add(
      counts.new,
      (n) => `${plural(n, "day's count", "days' counts")} ${will("to add", "added")}`,
    );
    add(counts.same, (n) => `${plural(n, "day")} left as ${n === 1 ? "it is" : "they are"}`);
  } else {
    add(counts.new, (n) => `${plural(n, "delivery", "deliveries")} ${will("to add", "added")}`);
    add(counts.same, (n) => `${plural(n, "delivery", "deliveries")} already here`);
    add(
      counts.unmatched,
      (n) =>
        `${plural(n, "delivery", "deliveries")} left out: no order brought in from a spreadsheet has that reference and item`,
    );
  }
  add(
    counts.suppliers_added,
    (n) =>
      `${plural(n, "supplier")} named in the file ${will("will be added", n === 1 ? "was added" : "were added")}`,
  );
  if (lines.length === 0) lines.push("Nothing in this file would change anything.");
  return lines;
}
