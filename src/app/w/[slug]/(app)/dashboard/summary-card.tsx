import { Card, CardContent } from "@/components/ui/card";
import { SECTION_WORDS, type SummarySectionText } from "@/lib/dashboard/summary";
import { SummaryButton } from "./summary-button";

/**
 * Money's monthly summary, folded: the last complete month, as Claude worded
 * it around figures code worked out. Owners and admins only; never sent
 * anywhere. Who pressed and when, and a plain warning to check it.
 */
export function SummaryCard({
  slug,
  monthWords,
  summary,
  canWrite,
}: {
  slug: string;
  monthWords: string;
  summary: { sections: SummarySectionText[]; writtenOn: string; writtenBy: string } | null;
  canWrite: boolean;
}) {
  return (
    <Card>
      <CardContent>
        <details open={false} className="group">
          <summary className="flex cursor-pointer flex-wrap items-baseline justify-between gap-2">
            <span className="font-semibold">Monthly summary · {monthWords}</span>
            <span className="text-muted-foreground text-xs">
              {summary
                ? `Written on ${summary.writtenOn} by ${summary.writtenBy}`
                : "Not written yet"}
            </span>
          </summary>
          <div className="mt-3 flex flex-col gap-4">
            <p className="border-ochre/30 bg-ochre-soft text-ochre-text rounded-md border px-3 py-2 text-xs">
              Written by AI from your figures — check before acting. Every amount comes from your
              books and shop as Money shows them; the words around them are Claude&apos;s. It&apos;s
              never sent to anyone.
            </p>
            {summary ? (
              summary.sections.map((section) => (
                <section key={section.section} className="flex flex-col gap-1">
                  <h3 className="text-sm font-semibold">{SECTION_WORDS[section.section]}</h3>
                  <ul className="font-read flex list-disc flex-col gap-1 pl-5 text-sm">
                    {section.points.map((point, i) => (
                      <li key={i}>{point.text}</li>
                    ))}
                  </ul>
                </section>
              ))
            ) : (
              <p className="text-muted-foreground text-sm">
                A few plain sentences on how {monthWords} went, what&apos;s worth a closer look, and
                where you could spend less, from the figures on this page.
              </p>
            )}
            {canWrite && <SummaryButton slug={slug} again={summary !== null} />}
          </div>
        </details>
      </CardContent>
    </Card>
  );
}
