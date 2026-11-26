"use client";

import { useActionState } from "react";
import { FormMessage } from "@/components/ui/form-message";
import { Label, Select } from "@/components/ui/input";
import { SubmitButton } from "@/components/ui/submit-button";
import type { DailyEmailSettings } from "@/lib/bookings/daily-config";
import { saveDailyEmail } from "./actions";

/** Who gets the daily email, and at what hour on the workspace's clock. */
export function DailyEmailForm({
  slug,
  settings,
  members,
  hours,
}: {
  slug: string;
  settings: DailyEmailSettings;
  members: { id: string; email: string; role: string }[];
  /** [hour, words] for the hour picker, worked out on the server. */
  hours: [number, string][];
}) {
  const [state, action] = useActionState(saveDailyEmail.bind(null, slug), {});
  return (
    <form action={action} className="flex flex-col gap-4">
      <label className="flex items-center gap-2 text-sm font-semibold">
        <input type="checkbox" name="on" defaultChecked={settings.on} />
        Send the daily email
      </label>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="daily-hour">When</Label>
        <Select id="daily-hour" name="hour" defaultValue={String(settings.hour)} className="w-40">
          {hours.map(([hour, words]) => (
            <option key={hour} value={hour}>
              {words}
            </option>
          ))}
        </Select>
      </div>
      <fieldset className="flex flex-col gap-1.5">
        <legend className="mb-1 text-xs font-semibold">Who gets it</legend>
        {members.map((m) => (
          <label key={m.id} className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              name="recipient"
              value={m.id}
              defaultChecked={settings.recipients.includes(m.id)}
            />
            <span className="font-read">{m.email}</span>
            <span className="text-muted-foreground text-xs">{m.role}</span>
          </label>
        ))}
        <p className="text-muted-foreground text-xs">
          Only people in this workspace can be chosen. Someone who leaves stops getting it.
        </p>
      </fieldset>
      <FormMessage>{state.error}</FormMessage>
      <FormMessage kind="success">{state.message}</FormMessage>
      <SubmitButton pendingText="Saving…" className="sm:w-fit">
        Save
      </SubmitButton>
    </form>
  );
}
