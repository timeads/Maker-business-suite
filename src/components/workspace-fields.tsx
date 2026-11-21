"use client";

import { useEffect, useRef } from "react";
import { Input, Label, Select } from "@/components/ui/input";

type Props = {
  timezones: string[];
  currencies: { code: string; label: string }[];
  defaults?: { name: string; timezone: string; currency: string };
  disabled?: boolean;
};

/** Name, timezone and currency inputs shared by onboarding and workspace settings. */
export function WorkspaceFields({ timezones, currencies, defaults, disabled }: Props) {
  const timezoneRef = useRef<HTMLSelectElement>(null);

  // New workspaces start on the visitor's own timezone.
  useEffect(() => {
    if (defaults || !timezoneRef.current) return;
    const guess = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (guess && timezones.includes(guess)) timezoneRef.current.value = guess;
  }, [defaults, timezones]);

  return (
    <>
      <div className="flex flex-col gap-2">
        <Label htmlFor="name">Business name</Label>
        <Input
          id="name"
          name="name"
          defaultValue={defaults?.name}
          placeholder="Wild Thread Studio"
          maxLength={80}
          required
          disabled={disabled}
        />
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-2">
          <Label htmlFor="timezone">Timezone</Label>
          <Select
            id="timezone"
            name="timezone"
            ref={timezoneRef}
            defaultValue={defaults?.timezone ?? "America/New_York"}
            disabled={disabled}
          >
            {timezones.map((tz) => (
              <option key={tz} value={tz}>
                {tz.replaceAll("_", " ")}
              </option>
            ))}
          </Select>
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="currency">Currency</Label>
          <Select
            id="currency"
            name="currency"
            defaultValue={defaults?.currency ?? "USD"}
            disabled={disabled}
          >
            {currencies.map((c) => (
              <option key={c.code} value={c.code}>
                {c.label}
              </option>
            ))}
          </Select>
        </div>
      </div>
    </>
  );
}
