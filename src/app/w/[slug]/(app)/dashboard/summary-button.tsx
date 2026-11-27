"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { writeMoneySummary, type SummaryState } from "./summary-actions";

/** "Write this month's summary" / "Write it again": only ever a person's press. */
export function SummaryButton({ slug, again }: { slug: string; again: boolean }) {
  const [said, setSaid] = useState<SummaryState>({});
  const [pending, start] = useTransition();
  return (
    <span className="flex flex-wrap items-center gap-2">
      <Button
        size="sm"
        variant="outline"
        disabled={pending}
        onClick={() => start(async () => setSaid(await writeMoneySummary(slug)))}
      >
        {pending ? "Writing…" : again ? "Write it again" : "Write this month's summary"}
      </Button>
      {(said.error || said.message) && (
        <span
          role={said.error ? "alert" : "status"}
          className={said.error ? "text-brick text-xs" : "text-muted-foreground text-xs"}
        >
          {said.error ?? said.message}
        </span>
      )}
    </span>
  );
}
