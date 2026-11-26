"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";
import { DECISIONS, DECISION_WORDS, type Decision } from "@/lib/dashboard/recurring";
import { decideCharge } from "./cutter-actions";

/** One charge's decision and note, saved on its own. */
export function ChargeDecision({
  slug,
  chargeKey,
  payee,
  monthlyCents,
  decision,
  note,
}: {
  slug: string;
  chargeKey: string;
  payee: string;
  monthlyCents: number;
  decision: Decision | null;
  note: string;
}) {
  const [choice, setChoice] = useState<string>(decision ?? "");
  const [words, setWords] = useState(note);
  const [said, setSaid] = useState<{ error?: string; message?: string }>({});
  const [pending, start] = useTransition();
  const changed = choice !== (decision ?? "") || words !== note;

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <Select
          aria-label={`What to do about ${payee}`}
          className="h-8 w-40"
          value={choice}
          onChange={(e) => setChoice(e.target.value)}
        >
          <option value="">Not decided</option>
          {DECISIONS.map((one) => (
            <option key={one} value={one}>
              {DECISION_WORDS[one]}
            </option>
          ))}
        </Select>
        <Input
          aria-label={`Note about ${payee}`}
          className="h-8 w-48"
          placeholder="A note for the team"
          maxLength={500}
          value={words}
          onChange={(e) => setWords(e.target.value)}
        />
        <Button
          size="sm"
          variant="outline"
          disabled={pending || !changed}
          onClick={() =>
            start(async () => {
              setSaid(
                await decideCharge(slug, {
                  key: chargeKey,
                  decision: choice === "" ? null : choice,
                  note: words,
                  payee,
                  monthly_cents: monthlyCents,
                }),
              );
            })
          }
        >
          {pending ? "Saving…" : "Save"}
        </Button>
      </div>
      {(said.error || said.message) && (
        <span
          role={said.error ? "alert" : "status"}
          className={said.error ? "text-brick text-xs" : "text-muted-foreground text-xs"}
        >
          {said.error ?? said.message}
        </span>
      )}
    </div>
  );
}
