"use client";

import { useState, useTransition } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { FormMessage } from "@/components/ui/form-message";
import { bringWording, type WordingState } from "./wording-actions";

/** Message wording from the earlier app: a look first, then "Bring these in". */
export function WordingImporter({ slug }: { slug: string }) {
  const [file, setFile] = useState<{ name: string; text: string } | null>(null);
  const [state, setState] = useState<WordingState>({});
  const [pending, start] = useTransition();
  return (
    <div className="flex flex-col gap-3">
      <input
        type="file"
        accept=".csv,text/csv,text/plain"
        aria-label="Message wording file"
        className="border-input bg-card file:bg-secondary file:text-secondary-foreground h-9 rounded-md border text-sm file:mr-3 file:h-full file:border-0 file:px-3 file:text-sm"
        onChange={async (event) => {
          const chosen = event.target.files?.[0];
          setState({});
          if (!chosen) return setFile(null);
          const text = await chosen.text();
          setFile({ name: chosen.name, text });
          start(async () => setState(await bringWording(slug, text, false)));
        }}
      />
      {pending && <p className="text-muted-foreground text-sm">Reading…</p>}
      <FormMessage>{state.error}</FormMessage>
      <FormMessage kind="success">{state.done}</FormMessage>
      {state.look && !state.done && (
        <div className="flex flex-col gap-3">
          <ul className="divide-border flex flex-col divide-y text-sm">
            {state.look.rows.map((row) => (
              <li key={row.line} className="flex flex-col gap-1 py-2">
                <p className="flex flex-wrap items-center gap-2">
                  <span className="text-muted-foreground tabular-nums">Line {row.line}</span>
                  <Badge tone="open">{row.channel === "email" ? "Email" : "Text"}</Badge>
                  <span className="font-semibold">{row.into.join(" and ")}</span>
                </p>
                {row.subject && <p className="font-read font-semibold">{row.subject}</p>}
                <p className="font-read whitespace-pre-line">{row.body}</p>
                {row.notes.map((note) => (
                  <p key={note} className="text-muted-foreground text-xs">
                    {note}
                  </p>
                ))}
              </li>
            ))}
          </ul>
          {state.look.problems.length > 0 && (
            <div className="flex flex-col gap-1 text-sm">
              <p className="font-semibold">Left out</p>
              {state.look.problems.map((problem) => (
                <p key={`${problem.line}-${problem.reason}`} className="text-muted-foreground">
                  Line {problem.line}: {problem.reason}
                </p>
              ))}
            </div>
          )}
          {file && state.look.rows.length > 0 && (
            <Button
              type="button"
              className="w-fit"
              disabled={pending}
              onClick={() => start(async () => setState(await bringWording(slug, file.text, true)))}
            >
              {pending ? "Bringing them in…" : "Bring these in"}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
