"use client";

import { useActionState, useState } from "react";
import { FormMessage } from "@/components/ui/form-message";
import { Input, Label, Select } from "@/components/ui/input";
import { SubmitButton } from "@/components/ui/submit-button";
import {
  addSession,
  cancelSession,
  saveAvailability,
  saveBookingForm,
  saveService,
  type BookingsState,
} from "./actions";

const textarea =
  "border-input bg-card placeholder:text-muted-foreground focus-visible:ring-ring w-full rounded-md border px-3 py-2 text-sm outline-none focus-visible:ring-2";

function Result({ state }: { state: BookingsState }) {
  return (
    <>
      <FormMessage>{state.error}</FormMessage>
      <FormMessage kind="success">{state.message}</FormMessage>
    </>
  );
}

export type ServiceValues = {
  id: string;
  kind: "workshop" | "appointment";
  name: string;
  description: string;
  duration_minutes: number;
  price_cents: number;
  capacity: number;
  active: boolean;
};

export function ServiceForm({
  slug,
  service,
  currency,
}: {
  slug: string;
  service?: ServiceValues;
  currency: string;
}) {
  const [state, action] = useActionState(saveService.bind(null, slug, service?.id ?? null), {});
  const [kind, setKind] = useState(service?.kind ?? "workshop");
  return (
    <form action={action} className="flex flex-col gap-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-2">
          <Label htmlFor="service-name">Name</Label>
          <Input
            id="service-name"
            name="name"
            maxLength={80}
            defaultValue={service?.name}
            placeholder="Beginner tufting workshop"
            required
          />
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="service-kind">Kind</Label>
          {service ? (
            <>
              <input type="hidden" name="kind" value={service.kind} />
              <p className="flex h-10 items-center text-sm">
                {service.kind === "workshop" ? "Workshop" : "Appointment"}
              </p>
            </>
          ) : (
            <Select
              id="service-kind"
              name="kind"
              value={kind}
              onChange={(event) => setKind(event.target.value as typeof kind)}
            >
              <option value="workshop">Workshop: set dates, several places</option>
              <option value="appointment">Appointment: one person, from your open hours</option>
            </Select>
          )}
        </div>
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="service-description">Description</Label>
        <textarea
          id="service-description"
          name="description"
          rows={3}
          maxLength={2000}
          defaultValue={service?.description}
          placeholder="What people will make, what to bring, who it's for…"
          className={textarea}
        />
      </div>
      <div className="grid gap-4 sm:grid-cols-3">
        <div className="flex flex-col gap-2">
          <Label htmlFor="service-duration">Length (minutes)</Label>
          <Input
            id="service-duration"
            name="duration"
            type="number"
            min={5}
            max={1440}
            step={5}
            defaultValue={service?.duration_minutes ?? 120}
            required
          />
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="service-price">
            Price{kind === "workshop" ? " per place" : ""} ({currency})
          </Label>
          <Input
            id="service-price"
            name="price"
            type="number"
            min={0}
            step="0.01"
            defaultValue={service ? (service.price_cents / 100).toFixed(2) : "0.00"}
            required
          />
        </div>
        {kind === "workshop" && (
          <div className="flex flex-col gap-2">
            <Label htmlFor="service-capacity">Places per date</Label>
            <Input
              id="service-capacity"
              name="capacity"
              type="number"
              min={1}
              max={500}
              defaultValue={service?.capacity ?? 8}
              required
            />
          </div>
        )}
      </div>
      {service && (
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="active" defaultChecked={service.active} />
          Show on my booking page
        </label>
      )}
      <Result state={state} />
      <SubmitButton pendingText="Saving…" className="sm:w-fit">
        {service ? "Save changes" : "Add it"}
      </SubmitButton>
    </form>
  );
}

export function AddSessionForm({
  slug,
  serviceId,
  capacity,
  timezone,
}: {
  slug: string;
  serviceId: string;
  capacity: number;
  timezone: string;
}) {
  const [state, action] = useActionState(addSession.bind(null, slug, serviceId), {});
  return (
    <form action={action} className="flex flex-col gap-3">
      <div className="grid gap-4 sm:grid-cols-3">
        <div className="flex flex-col gap-2">
          <Label htmlFor="session-day">Date</Label>
          <Input id="session-day" name="day" type="date" required />
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="session-time">Starts at</Label>
          <Input id="session-time" name="time" type="time" required />
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="session-capacity">Places</Label>
          <Input
            id="session-capacity"
            name="capacity"
            type="number"
            min={1}
            max={500}
            defaultValue={capacity}
          />
        </div>
      </div>
      <p className="text-muted-foreground text-xs">
        Times are in your workspace&apos;s timezone ({timezone.replace(/_/g, " ")}).
      </p>
      <Result state={state} />
      <SubmitButton pendingText="Adding…" variant="outline" className="sm:w-fit">
        Add date
      </SubmitButton>
    </form>
  );
}

export function CancelSessionForm({ slug, sessionId }: { slug: string; sessionId: string }) {
  const [state, action] = useActionState(cancelSession.bind(null, slug, sessionId), {});
  const [sure, setSure] = useState(false);
  return (
    <form action={action} className="flex flex-col gap-3">
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={sure} onChange={(e) => setSure(e.target.checked)} />
        Yes, call this date off and email everyone who booked
      </label>
      <Result state={state} />
      <SubmitButton
        pendingText="Cancelling…"
        variant="outline"
        className="sm:w-fit"
        disabled={!sure}
      >
        Cancel this date
      </SubmitButton>
    </form>
  );
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export function AvailabilityForm({
  slug,
  serviceId,
  hours,
}: {
  slug: string;
  serviceId: string;
  /** weekday → ["09:00", "17:00"] */
  hours: Record<number, [string, string]>;
}) {
  const [state, action] = useActionState(saveAvailability.bind(null, slug, serviceId), {});
  return (
    <form action={action} className="flex flex-col gap-3">
      <div className="flex flex-col gap-2">
        {[1, 2, 3, 4, 5, 6, 0].map((weekday) => (
          <div key={weekday} className="grid grid-cols-[7rem_1fr_auto_1fr] items-center gap-2">
            <span className="text-sm">{WEEKDAYS[weekday]}</span>
            <Input
              name={`from_${weekday}`}
              type="time"
              aria-label={`${WEEKDAYS[weekday]} opens`}
              defaultValue={hours[weekday]?.[0]}
            />
            <span className="text-muted-foreground text-sm">to</span>
            <Input
              name={`to_${weekday}`}
              type="time"
              aria-label={`${WEEKDAYS[weekday]} closes`}
              defaultValue={hours[weekday]?.[1]}
            />
          </div>
        ))}
      </div>
      <p className="text-muted-foreground text-xs">Leave a day empty if you&apos;re closed.</p>
      <Result state={state} />
      <SubmitButton pendingText="Saving…" className="sm:w-fit">
        Save hours
      </SubmitButton>
    </form>
  );
}

export function BookingQuestionsForm({ slug, questions }: { slug: string; questions: string }) {
  const [state, action] = useActionState(saveBookingForm.bind(null, slug), {});
  return (
    <form action={action} className="flex flex-col gap-3">
      <Label htmlFor="questions">Questions</Label>
      <textarea
        id="questions"
        name="questions"
        rows={5}
        defaultValue={questions}
        placeholder={"Any allergies we should know about?\nPhone number *"}
        className={textarea}
      />
      <p className="text-muted-foreground text-xs">
        One question per line. End a line with * if it must be answered. Name and email are always
        asked.
      </p>
      <Result state={state} />
      <SubmitButton pendingText="Saving…" className="sm:w-fit">
        Save questions
      </SubmitButton>
    </form>
  );
}
