"use client";

import { useActionState, useState } from "react";
import { FormMessage } from "@/components/ui/form-message";
import { Input, Label } from "@/components/ui/input";
import { SubmitButton } from "@/components/ui/submit-button";
import type { BusinessLine } from "@/lib/dashboard/lines";
import type { ProjectionSettings } from "@/lib/dashboard/projection";
import { saveProjectionSettings, type MoneySettingsState } from "./money-settings-actions";

/** Settings → Money → Projection: a yearly rate for each line, cost of goods and running costs. */
export function ProjectionForm({
  slug,
  settings,
  lines,
}: {
  slug: string;
  settings: ProjectionSettings;
  lines: readonly BusinessLine[];
}) {
  const [state, action] = useActionState<MoneySettingsState, FormData>(
    saveProjectionSettings.bind(null, slug),
    {},
  );
  const [rates, setRates] = useState<Record<string, string>>(() => ({
    ...Object.fromEntries(
      lines.map((l) => [
        `line:${l.id}`,
        String(settings.line_growth[l.id] ?? settings.other_growth),
      ]),
    ),
    other: String(settings.other_growth),
    cogs: String(settings.cogs_growth),
    fixed: String(settings.fixed_growth),
  }));
  const whole = (text: string | undefined) => {
    const n = Number((text ?? "").trim());
    return Number.isInteger(n) ? n : NaN;
  };
  const body = {
    line_growth: Object.fromEntries(lines.map((l) => [l.id, whole(rates[`line:${l.id}`])])),
    other_growth: whole(rates.other),
    cogs_growth: whole(rates.cogs),
    fixed_growth: whole(rates.fixed),
  };
  const field = (key: string, label: string, hint?: string) => (
    <div key={key} className="grid gap-1 sm:grid-cols-[1fr_8rem] sm:items-center">
      <Label htmlFor={`rate-${key}`} className="font-normal">
        {label}
        {hint && <span className="text-muted-foreground block text-xs">{hint}</span>}
      </Label>
      <div className="flex items-center gap-1">
        <Input
          id={`rate-${key}`}
          inputMode="numeric"
          value={rates[key] ?? ""}
          onChange={(e) => setRates({ ...rates, [key]: e.target.value })}
        />
        <span className="text-muted-foreground text-sm">%</span>
      </div>
    </div>
  );
  return (
    <form action={action} className="flex flex-col gap-3">
      <input type="hidden" name="body" value={JSON.stringify(body)} />
      {lines.map((l) => field(`line:${l.id}`, `${l.name} revenue`, "Growth a year"))}
      {field(
        "other",
        lines.length ? "Revenue with no line" : "Revenue",
        lines.length ? "Used too for a line you leave out above" : "Growth a year",
      )}
      {field("cogs", "Cost of goods", "Growth a year")}
      {field("fixed", "Running costs", "Rent, help, subscriptions… growth a year")}
      <FormMessage>{state.error}</FormMessage>
      <FormMessage kind="success">{state.message}</FormMessage>
      <SubmitButton variant="outline" pendingText="Saving…" className="sm:w-fit">
        Save the rates
      </SubmitButton>
    </form>
  );
}
