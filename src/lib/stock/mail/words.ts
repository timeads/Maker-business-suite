import { centsText, type ReadDocument } from "./extract";

/** What was read from a message, in a line: "invoice HM-1001 · 123.45; statement · balance 310.40". */
export function documentsSummary(documents: readonly ReadDocument[]): string {
  return documents
    .map((d) =>
      d.kind === "invoice"
        ? `invoice ${d.reference ?? "(no number)"}${d.amountCents ? ` · ${centsText(d.amountCents)}` : ""}`
        : d.kind === "statement"
          ? `statement${d.balanceCents !== null ? ` · balance ${centsText(d.balanceCents)}` : ""}`
          : d.kind === "payment"
            ? `payment${d.amountCents ? ` · ${centsText(d.amountCents)}` : ""}`
            : "something else",
    )
    .join("; ");
}

/** "Last automatic read 3 Nov, 6:02 am · 3 new · 1 to check", from one look's counts. */
export function readCountsWords(counts: {
  filed: number;
  toCheck: number;
  capped: boolean;
}): string {
  const parts = [`${counts.filed} new`];
  if (counts.toCheck > 0) parts.push(`${counts.toCheck} to check`);
  if (counts.capped) parts.push("stopped at a limit");
  return parts.join(" · ");
}
