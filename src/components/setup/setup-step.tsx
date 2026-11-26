import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

/**
 * One step of a guided setup: its number, name, whether anything is still
 * open (worked out from the facts, never stored), and the small form that
 * does it. Every step can be skipped: the next one is just below.
 */
export function SetupStepCard({
  id,
  number,
  title,
  description,
  open,
  current,
  next,
  children,
}: {
  id: string;
  number: number;
  title: string;
  description?: React.ReactNode;
  /** Items still open in this step. */
  open: number;
  /** The first step with something open: where a person lands. */
  current: boolean;
  /** The step after this one, for "Skip for now". */
  next?: { id: string; title: string };
  children: React.ReactNode;
}) {
  return (
    <Card id={id} className={current ? "ring-ochre/60 scroll-mt-4 ring-2" : "scroll-mt-4"}>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="text-base">
            <span className="text-muted-foreground mr-2 tabular-nums">{number}.</span>
            {title}
          </CardTitle>
          {open > 0 ? (
            <Badge tone="waiting">{open === 1 ? "1 thing to do" : `${open} things to do`}</Badge>
          ) : (
            <Badge tone="good">Nothing to do</Badge>
          )}
        </div>
        {description && <CardDescription className="font-read">{description}</CardDescription>}
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {children}
        {next && (
          <a href={`#${next.id}`} className="text-muted-foreground w-fit text-sm hover:underline">
            {open > 0 ? "Skip for now" : "Next"}: {next.title} ↓
          </a>
        )}
      </CardContent>
    </Card>
  );
}
