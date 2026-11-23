"use client";

import { useMemo } from "react";
import { AlertTriangle, CheckCircle2, Lightbulb, Wand2, XCircle } from "lucide-react";
import { toast } from "./ui";
import { Button } from "@/components/ui/button";
import { optimize, type Suggestion, type SuggestionLevel } from "@/lib/design";
import { cn } from "@/lib/utils";
import { useBuilder } from "./context";

const LEVELS: Record<SuggestionLevel, { name: string; icon: typeof XCircle; tone: string }> = {
  error: { name: "To fix", icon: XCircle, tone: "text-brick" },
  warn: { name: "Worth a look", icon: AlertTriangle, tone: "text-ochre-text" },
  tip: { name: "Tips", icon: Lightbulb, tone: "text-muted-foreground" },
};

function Card({ found }: { found: Suggestion }) {
  const { dispatch, select } = useBuilder();
  const { icon: Icon, tone } = LEVELS[found.level];
  const show = () => {
    if (!found.blockId) return;
    select({ kind: "block", id: found.blockId });
    requestAnimationFrame(() =>
      document
        .querySelector(`[data-block="${found.blockId}"]`)
        ?.scrollIntoView({ block: "center", behavior: "smooth" }),
    );
  };
  const fix = () => {
    for (const action of found.fix ?? []) dispatch(action);
    toast.success("Fixed. Undo brings it back.");
  };
  return (
    <li
      className="bg-card space-y-2 rounded-md border p-3"
      data-suggestion={found.rule}
      data-level={found.level}
    >
      <div className="flex items-start gap-2">
        <Icon className={cn("mt-0.5 h-4 w-4 shrink-0", tone)} aria-hidden />
        <div className="min-w-0 space-y-1">
          <p className="text-sm leading-snug font-medium">{found.title}</p>
          <p className="text-muted-foreground text-xs leading-relaxed">{found.detail}</p>
        </div>
      </div>
      {(found.blockId || found.fix) && (
        <div className="flex flex-wrap justify-end gap-2">
          {found.blockId && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs"
              onClick={show}
            >
              Show me
            </Button>
          )}
          {found.fix && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-7 px-2 text-xs"
              onClick={fix}
            >
              <Wand2 className="mr-1 h-3 w-3" /> {found.fixLabel ?? "Fix"}
            </Button>
          )}
        </div>
      )}
    </li>
  );
}

/** Everything in the email worth fixing before it is sent, most serious first, each with a way to see it and, where there is a safe one, to fix it. */
export function OptimizePanel() {
  const { doc } = useBuilder();
  const found = useMemo(() => optimize(doc), [doc]);
  return (
    <div className="space-y-4 p-4" data-optimize>
      <div>
        <h2 className="text-sm font-bold">Optimize</h2>
        <p className="text-muted-foreground text-xs">
          Things worth fixing before you send, found by looking over the email. The list keeps up as
          you change it.
        </p>
      </div>
      {found.length === 0 ? (
        <div
          className="text-muted-foreground flex flex-col items-center gap-2 rounded-md border border-dashed p-6 text-center text-sm"
          role="status"
        >
          <CheckCircle2 className="text-mint-ink h-6 w-6" aria-hidden />
          Nothing to fix. Send yourself a test before sending to customers.
        </div>
      ) : (
        (Object.keys(LEVELS) as SuggestionLevel[]).map((level) => {
          const group = found.filter((s) => s.level === level);
          return group.length === 0 ? null : (
            <section key={level} className="space-y-2" aria-label={LEVELS[level].name}>
              <h3 className="text-xs font-bold">
                {LEVELS[level].name} ({group.length})
              </h3>
              <ul className="space-y-2">
                {group.map((s) => (
                  <Card key={s.id} found={s} />
                ))}
              </ul>
            </section>
          );
        })
      )}
    </div>
  );
}
