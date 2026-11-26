"use client";

import { useActionState, useMemo, useState } from "react";
import { FormMessage } from "@/components/ui/form-message";
import { Input, Label } from "@/components/ui/input";
import { SubmitButton } from "@/components/ui/submit-button";
import { idFrom } from "@/lib/dashboard/lines";
import type { LineSuggestion } from "@/lib/dashboard/setup";
import { saveBusinessLines, type RevenueState } from "../actions";

type Pick = LineSuggestion & { key: string; on: boolean; name: string; amount: string };

const firstName = (s: LineSuggestion) => (s.match === "workshop" ? "Workshops" : s.word);
const WHERE: Record<LineSuggestion["match"], string> = {
  workshop: "Workshops sold through your shop",
  product_type: "Products of this type",
  order_tag: "Orders with this tag",
};

/**
 * Step 2 with nothing set yet: lines suggested from what the shop's sales
 * already carry, as ticks to confirm or rename. Saved through the same
 * action as Settings → Money → Revenue and business lines; nothing is made
 * up, and nothing is saved until the person presses save.
 */
export function LinePicker({
  slug,
  suggestions,
}: {
  slug: string;
  suggestions: (LineSuggestion & { amount: string })[];
}) {
  const [picks, setPicks] = useState<Pick[]>(() =>
    suggestions.map((s, i) => ({ ...s, key: `${s.match}:${i}`, on: false, name: firstName(s) })),
  );
  const [rest, setRest] = useState("Everything else");
  const [state, action] = useActionState<RevenueState, FormData>(
    saveBusinessLines.bind(null, slug),
    {},
  );
  const chosen = picks.filter((p) => p.on && p.name.trim() !== "");

  // One line per name (two ticks named the same are one line with two rules).
  const body = useMemo(() => {
    const taken = new Set<string>();
    const lines: { id: string; name: string }[] = [];
    const idOf = new Map<string, string>();
    const add = (name: string) => {
      const key = name.trim().toLowerCase();
      if (!idOf.has(key)) {
        const id = idFrom(name, taken);
        taken.add(id);
        idOf.set(key, id);
        lines.push({ id, name: name.trim() });
      }
      return idOf.get(key)!;
    };
    const rules = chosen.map((p, i) => ({
      id: `rule-${i + 1}`,
      match: p.match,
      words: p.match === "workshop" ? [] : [p.word],
      line: add(p.name),
    }));
    const defaultLine = chosen.length ? add(rest.trim() || "Everything else") : null;
    return JSON.stringify({ lines, default_line: defaultLine, rules });
  }, [chosen, rest]);

  if (picks.length === 0) {
    return (
      <p className="text-muted-foreground text-sm">
        Your recent sales don&apos;t carry tags or product types to suggest lines from. You can
        still make them by hand in Settings.
      </p>
    );
  }
  return (
    <form action={action} className="flex flex-col gap-4">
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-sm font-medium">
          Tick the ones that are a part of your business, and name them your way
        </legend>
        {picks.map((p) => (
          <div key={p.key} className="flex flex-wrap items-center gap-3 text-sm">
            <input
              type="checkbox"
              className="size-4"
              aria-label={`Use ${firstName(p)}`}
              checked={p.on}
              onChange={(event) =>
                setPicks((all) =>
                  all.map((x) => (x.key === p.key ? { ...x, on: event.target.checked } : x)),
                )
              }
            />
            <span className="min-w-44 flex-1">
              <span className="font-medium">{firstName(p)}</span>
              <span className="text-muted-foreground block text-xs">
                {WHERE[p.match]} · {p.amount} lately
              </span>
            </span>
            <Input
              className="w-48"
              aria-label={`Name for ${firstName(p)}`}
              value={p.name}
              maxLength={40}
              disabled={!p.on}
              onChange={(event) =>
                setPicks((all) =>
                  all.map((x) => (x.key === p.key ? { ...x, name: event.target.value } : x)),
                )
              }
            />
          </div>
        ))}
      </fieldset>
      <div className="flex flex-col gap-1">
        <Label htmlFor="rest-line">Where everything else goes</Label>
        <Input
          id="rest-line"
          className="w-60"
          value={rest}
          maxLength={40}
          onChange={(event) => setRest(event.target.value)}
        />
      </div>
      <input type="hidden" name="body" value={body} />
      <FormMessage>{state.error}</FormMessage>
      <FormMessage kind="success">{state.message}</FormMessage>
      <SubmitButton
        variant="dark"
        pendingText="Saving…"
        className="w-fit"
        disabled={chosen.length === 0}
      >
        {chosen.length === 0
          ? "Tick a line to start"
          : `Save ${chosen.length === 1 ? "this line" : "these lines"}`}
      </SubmitButton>
    </form>
  );
}
