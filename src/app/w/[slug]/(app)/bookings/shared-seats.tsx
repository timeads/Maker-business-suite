"use client";

import { useActionState } from "react";
import { FormMessage } from "@/components/ui/form-message";
import { Input, Label, Select } from "@/components/ui/input";
import { SubmitButton } from "@/components/ui/submit-button";
import type { BookingsState } from "./actions";
import { saveSharedLimit, shareSeats, unshareSeats } from "./date-actions";

export type SharedDate = { id: string; label: string; taken: number; capacity: number };

function Result({ state }: { state: BookingsState }) {
  return (
    <>
      <FormMessage>{state.error}</FormMessage>
      <FormMessage kind="success">{state.message}</FormMessage>
    </>
  );
}

/** Pick a class running at the same time and how many places the room holds between them. */
export function ShareSeatsForm({
  slug,
  sessionId,
  candidates,
  suggested,
}: {
  slug: string;
  sessionId: string;
  candidates: SharedDate[];
  suggested: number;
}) {
  const [state, action] = useActionState(shareSeats.bind(null, slug, sessionId), {});
  return (
    <form action={action} className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex min-w-0 flex-1 basis-64 flex-col gap-1.5">
          <Label htmlFor="share-with">Class at the same time</Label>
          <Select id="share-with" name="with" required defaultValue="">
            <option value="" disabled>
              Pick one…
            </option>
            {candidates.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label} · {c.taken} of {c.capacity} booked
              </option>
            ))}
          </Select>
        </div>
        <div className="flex flex-col gap-1.5 sm:w-32">
          <Label htmlFor="share-limit">Places between them</Label>
          <Input
            id="share-limit"
            name="limit"
            type="number"
            min={1}
            max={1000}
            defaultValue={suggested}
            required
          />
        </div>
      </div>
      <Result state={state} />
      <SubmitButton variant="outline" pendingText="Saving…" className="sm:w-fit">
        Share the room
      </SubmitButton>
    </form>
  );
}

/** Change the shared number, or untie the classes. */
export function SharedLimitForms({
  slug,
  groupId,
  capacity,
}: {
  slug: string;
  groupId: string;
  capacity: number;
}) {
  const [state, action] = useActionState(saveSharedLimit.bind(null, slug, groupId), {});
  const [untied, untie] = useActionState(unshareSeats.bind(null, slug, groupId), {});
  return (
    <div className="flex flex-col gap-3">
      <form action={action} className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1.5 sm:w-32">
          <Label htmlFor="shared-limit">Places between them</Label>
          <Input
            id="shared-limit"
            name="limit"
            type="number"
            min={1}
            max={1000}
            defaultValue={capacity}
            required
          />
        </div>
        <SubmitButton variant="outline" pendingText="Saving…">
          Save
        </SubmitButton>
      </form>
      <Result state={state} />
      <form
        action={untie}
        onSubmit={(event) => {
          if (!window.confirm("Stop sharing? Each class goes back to its own places.")) {
            event.preventDefault();
          }
        }}
      >
        <SubmitButton variant="ghost" size="sm" pendingText="Untying…">
          Stop sharing places
        </SubmitButton>
      </form>
      <Result state={untied} />
    </div>
  );
}
