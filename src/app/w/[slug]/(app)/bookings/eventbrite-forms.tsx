"use client";

import { useActionState } from "react";
import { FormMessage } from "@/components/ui/form-message";
import { Label, Select } from "@/components/ui/input";
import { SubmitButton } from "@/components/ui/submit-button";
import {
  linkDateToEvent,
  retryEventbriteLink,
  saveEventbriteWorkshops,
  switchOnOrderUpdates,
} from "./eventbrite-actions";

/** Gives Eventbrite our webhook address, so orders arrive here. */
export function OrderUpdatesForm({ slug, on }: { slug: string; on: boolean }) {
  const [state, action] = useActionState(switchOnOrderUpdates.bind(null, slug), {});
  return (
    <form action={action} className="flex flex-col gap-2">
      <SubmitButton
        variant={on ? "outline" : "default"}
        pendingText="Asking Eventbrite…"
        className="w-fit"
      >
        {on ? "Check order updates again" : "Switch on order updates"}
      </SubmitButton>
      <FormMessage>{state.error}</FormMessage>
      <FormMessage kind="success">{state.message}</FormMessage>
    </form>
  );
}

/** One tick per workshop: may its dates be sold on Eventbrite too? */
export function EventbriteWorkshopsForm({
  slug,
  workshops,
}: {
  slug: string;
  workshops: { id: string; name: string; on: boolean }[];
}) {
  const [state, action] = useActionState(saveEventbriteWorkshops.bind(null, slug), {});
  return (
    <form action={action} className="flex flex-col gap-3">
      <ul className="flex flex-col gap-2">
        {workshops.map((w) => (
          <li key={w.id}>
            <input type="hidden" name="service" value={w.id} />
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" name={`on_${w.id}`} defaultChecked={w.on} />
              {w.name}
            </label>
          </li>
        ))}
      </ul>
      <FormMessage>{state.error}</FormMessage>
      <FormMessage kind="success">{state.message}</FormMessage>
      <SubmitButton variant="outline" pendingText="Saving…" className="w-fit">
        Save
      </SubmitButton>
    </form>
  );
}

export type EventChoice = {
  id: string;
  label: string;
  tickets: { id: string; name: string }[];
};

/** Picks the Eventbrite event (and ticket type) that sells this date too. */
export function LinkDateForm({
  slug,
  sessionId,
  events,
  current,
  suggested,
}: {
  slug: string;
  sessionId: string;
  events: EventChoice[];
  /** The event and ticket type linked now, if any. */
  current: { eventId: string; eventName: string; ticketId: string | null } | null;
  /** An event that starts at the same minute, when there is exactly one. */
  suggested: string | null;
}) {
  const [state, action] = useActionState(linkDateToEvent.bind(null, slug, sessionId), {});
  const chosen = current?.eventId ?? suggested ?? "";
  const event = events.find((e) => e.id === chosen);
  const missing = current && !events.some((e) => e.id === current.eventId);
  return (
    <form action={action} className="flex flex-col gap-2">
      <div className="flex flex-wrap items-end gap-2">
        <div className="flex flex-col gap-1">
          <Label htmlFor={`event-${sessionId}`}>Eventbrite event</Label>
          <Select
            id={`event-${sessionId}`}
            name="event"
            defaultValue={chosen}
            className="w-72 max-w-full"
          >
            <option value="">Not on Eventbrite</option>
            {missing && (
              <option value={current.eventId}>
                {current.eventName || `Event ${current.eventId}`} (no longer on sale)
              </option>
            )}
            {events.map((e) => (
              <option key={e.id} value={e.id}>
                {e.label}
              </option>
            ))}
          </Select>
        </div>
        {event && event.tickets.length > 1 && (
          <div className="flex flex-col gap-1">
            <Label htmlFor={`ticket-${sessionId}`}>Ticket type</Label>
            <Select
              id={`ticket-${sessionId}`}
              name="ticket"
              defaultValue={current?.ticketId ?? event.tickets[0].id}
              className="w-48"
            >
              {event.tickets.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </Select>
          </div>
        )}
        <SubmitButton variant="outline" size="sm" pendingText="Saving…">
          {current || !chosen ? "Save" : "Link"}
        </SubmitButton>
      </div>
      {!current && suggested && (
        <p className="text-muted-foreground text-xs">
          Picked for you: the event that starts at the same time. Press Link to keep it.
        </p>
      )}
      <FormMessage>{state.error}</FormMessage>
      <FormMessage kind="success">{state.message}</FormMessage>
    </form>
  );
}

/** "Try again" for a date whose tickets on Eventbrite didn't update, or may not have. */
export function RetryLinkForm({ slug, listingId }: { slug: string; listingId: string }) {
  const [state, action] = useActionState(retryEventbriteLink.bind(null, slug, listingId), {});
  return (
    <form action={action} className="flex flex-col gap-1">
      <SubmitButton variant="outline" size="sm" pendingText="…" className="w-fit">
        Try again
      </SubmitButton>
      <FormMessage>{state.error}</FormMessage>
      <FormMessage kind="success">{state.message}</FormMessage>
    </form>
  );
}
