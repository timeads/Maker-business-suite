"use client";

import { useState } from "react";
import { Input, Label } from "@/components/ui/input";
import { addDays, formatHoldDate } from "@/lib/shipping/queue";
import { cn } from "@/lib/utils";

export type HoldChoice = { label: string; until: string | null };

/**
 * How long to hold for: a few quick choices, or any later day. `today` and
 * the choices come from the server, in the workspace's own time zone.
 */
export function HoldPicker({
  id,
  today,
  choices,
  value,
  onChange,
}: {
  id: string;
  today: string;
  choices: HoldChoice[];
  value: string | null;
  onChange: (until: string | null) => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      <span className="text-xs leading-tight font-semibold">How long</span>
      <div className="flex flex-wrap items-center gap-1.5">
        {choices.map((choice) => (
          <button
            key={choice.label}
            type="button"
            aria-pressed={value === choice.until}
            onClick={() => onChange(choice.until)}
            className={cn(
              "rounded-full border px-2.5 py-1 text-xs whitespace-nowrap transition-colors duration-150",
              value === choice.until
                ? "bg-teal border-teal font-semibold text-white"
                : "border-input text-text-2 hover:bg-hover",
            )}
          >
            {choice.label}
          </button>
        ))}
        <Label htmlFor={id} className="text-muted-foreground ml-1 font-normal">
          or pick a day
        </Label>
        <Input
          id={id}
          type="date"
          min={addDays(today, 1)}
          value={value ?? ""}
          onChange={(event) => onChange(event.target.value || null)}
          className="h-[30px] w-auto text-xs"
        />
      </div>
      <p className="text-muted-foreground text-xs">
        {value
          ? `Out of the way until ${formatHoldDate(value)}, then it's back in Ready to ship.`
          : "Stays on hold until someone releases it."}
      </p>
    </div>
  );
}

/** The picker with its own state, for a plain form: posts `until`. */
export function HoldPickerField(props: { id: string; today: string; choices: HoldChoice[] }) {
  const [until, setUntil] = useState<string | null>(null);
  return (
    <>
      <input type="hidden" name="until" value={until ?? ""} />
      <HoldPicker {...props} value={until} onChange={setUntil} />
    </>
  );
}
