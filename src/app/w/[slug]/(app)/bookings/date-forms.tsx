"use client";

import { useActionState, useState } from "react";
import { FormMessage } from "@/components/ui/form-message";
import { Input, Label } from "@/components/ui/input";
import { SubmitButton } from "@/components/ui/submit-button";
import type { BookingsState } from "./actions";
import { deleteDate, moveDate, raiseToFit } from "./date-actions";

function Result({ state }: { state: BookingsState }) {
  return (
    <>
      <FormMessage>{state.error}</FormMessage>
      <FormMessage kind="success">{state.message}</FormMessage>
    </>
  );
}

/** A new day or start time for the whole date. People booked keep their place. */
export function MoveDateForm({
  slug,
  sessionId,
  day,
  time,
  timezone,
  people,
}: {
  slug: string;
  sessionId: string;
  /** The date's current day and start, on the workspace's clock. */
  day: string;
  time: string;
  timezone: string;
  people: number;
}) {
  const [state, action] = useActionState(moveDate.bind(null, slug, sessionId), {});
  return (
    <form action={action} className="flex flex-col gap-3">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="move-day">New date</Label>
          <Input id="move-day" name="day" type="date" defaultValue={day} required />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="move-time">Starts at</Label>
          <Input id="move-time" name="time" type="time" defaultValue={time} required />
        </div>
      </div>
      {people > 0 && (
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" name="tell" defaultChecked className="mt-1" />
          <span>
            Email {people === 1 ? "the person" : `the ${people} people`} booked about the new time
            <span className="text-muted-foreground block text-xs">
              A reminder that has already gone out isn&apos;t sent again for the new time. One that
              hasn&apos;t gone yet goes out before the new start, as usual.
            </span>
          </span>
        </label>
      )}
      <p className="text-muted-foreground text-xs">
        Times are in your workspace&apos;s timezone ({timezone.replace(/_/g, " ")}). The length
        stays the same.
      </p>
      <Result state={state} />
      <SubmitButton variant="outline" pendingText="Moving…" className="sm:w-fit">
        Move this date
      </SubmitButton>
    </form>
  );
}

/** Removes a date made by mistake. Offered only while nobody has booked it. */
export function DeleteDateForm({
  slug,
  sessionId,
  serviceId,
}: {
  slug: string;
  sessionId: string;
  serviceId: string;
}) {
  const [state, action] = useActionState(deleteDate.bind(null, slug, sessionId, serviceId), {});
  const [sure, setSure] = useState(false);
  return (
    <form action={action} className="flex flex-col gap-3">
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={sure} onChange={(e) => setSure(e.target.checked)} />
        Yes, delete this date for good
      </label>
      <Result state={state} />
      <SubmitButton variant="outline" disabled={!sure} pendingText="Deleting…" className="sm:w-fit">
        Delete date
      </SubmitButton>
    </form>
  );
}

/** One press to make the limit fit everyone already booked. */
export function RaiseToFitForm({
  slug,
  sessionId,
  label,
}: {
  slug: string;
  sessionId: string;
  label: string;
}) {
  const [state, action] = useActionState(raiseToFit.bind(null, slug, sessionId), {});
  return (
    <form action={action} className="flex flex-col gap-3">
      <Result state={state} />
      <SubmitButton variant="outline" pendingText="Saving…" className="sm:w-fit">
        {label}
      </SubmitButton>
    </form>
  );
}
