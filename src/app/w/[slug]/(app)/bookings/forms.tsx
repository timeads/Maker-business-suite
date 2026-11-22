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
import { saveBookingEmails } from "./roster-actions";

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
      <div className="flex flex-wrap items-end gap-x-6 gap-y-3">
        <div className="flex flex-col gap-2">
          <Label htmlFor="session-weeks">Repeat</Label>
          <Select id="session-weeks" name="weeks" defaultValue="1" className="w-52">
            <option value="1">Just this date</option>
            <option value="4">Weekly, 4 weeks</option>
            <option value="6">Weekly, 6 weeks</option>
            <option value="8">Weekly, 8 weeks</option>
            <option value="12">Weekly, 12 weeks</option>
            <option value="26">Weekly, 26 weeks</option>
          </Select>
        </div>
        <label className="flex h-9 items-center gap-2 text-sm">
          <input type="checkbox" name="private" />
          Private (not on my booking page)
        </label>
      </div>
      <p className="text-muted-foreground text-xs">
        Times are in your workspace&apos;s timezone ({timezone.replace(/_/g, " ")}). A weekly repeat
        keeps the same time on the clock all the way through.
      </p>
      <Result state={state} />
      <SubmitButton pendingText="Adding…" variant="outline" className="sm:w-fit">
        Add to the calendar
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

export type EmailSettings = {
  reminder_hours: number;
  followup_on: boolean;
  followup_hours: number;
  confirmation_note: string;
  reminder_note: string;
  followup_message: string;
};

const LEAD_TIMES: [number, string][] = [
  [2, "2 hours"],
  [12, "12 hours"],
  [24, "1 day"],
  [48, "2 days"],
  [72, "3 days"],
  [168, "1 week"],
];

function LeadTime({ id, name, value }: { id: string; name: string; value: number }) {
  const options = LEAD_TIMES.some(([hours]) => hours === value)
    ? LEAD_TIMES
    : [...LEAD_TIMES, [value, `${value} hours`] as [number, string]];
  return (
    <Select id={id} name={name} defaultValue={String(value)} className="w-40">
      {options.map(([hours, label]) => (
        <option key={hours} value={hours}>
          {label}
        </option>
      ))}
    </Select>
  );
}

export function BookingEmailsForm({ slug, settings }: { slug: string; settings: EmailSettings }) {
  const [state, action] = useActionState(saveBookingEmails.bind(null, slug), {});
  const [followup, setFollowup] = useState(settings.followup_on);
  const read = `${textarea} font-read`;
  return (
    <form action={action} className="flex flex-col gap-5">
      <div className="flex flex-col gap-2">
        <Label htmlFor="confirmation-note">Add to the “you&apos;re booked” email</Label>
        <textarea
          id="confirmation-note"
          name="confirmation_note"
          rows={3}
          maxLength={1500}
          defaultValue={settings.confirmation_note}
          placeholder="We're at 12 Mill Lane, up the stairs. Wear clothes you don't mind getting fluffy."
          className={read}
        />
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="reminder-hours">Send a reminder</Label>
        <div className="flex items-center gap-2 text-sm">
          <LeadTime id="reminder-hours" name="reminder_hours" value={settings.reminder_hours} />
          before
        </div>
        <Label htmlFor="reminder-note" className="mt-1">
          Add to the reminder
        </Label>
        <textarea
          id="reminder-note"
          name="reminder_note"
          rows={3}
          maxLength={1500}
          defaultValue={settings.reminder_note}
          placeholder="Doors open 15 minutes early. Parking is free behind the building."
          className={read}
        />
      </div>
      <div className="flex flex-col gap-2">
        <label className="flex items-center gap-2 text-sm font-semibold">
          <input
            type="checkbox"
            name="followup_on"
            checked={followup}
            onChange={(e) => setFollowup(e.target.checked)}
          />
          Send a thank-you afterwards
        </label>
        {followup && (
          <>
            <div className="flex items-center gap-2 text-sm">
              <LeadTime id="followup-hours" name="followup_hours" value={settings.followup_hours} />
              after it ends
            </div>
            <Label htmlFor="followup-message" className="mt-1">
              What it says
            </Label>
            <textarea
              id="followup-message"
              name="followup_message"
              rows={4}
              maxLength={1500}
              defaultValue={settings.followup_message}
              placeholder="Thank you for coming! Tag us in a photo of your rug, and here's 10% off your next workshop: COMEBACK10"
              className={read}
            />
            <p className="text-muted-foreground text-xs">
              Leave it empty for a simple thank-you. People marked as a no-show don&apos;t get it.
            </p>
          </>
        )}
      </div>
      <Result state={state} />
      <SubmitButton pendingText="Saving…" className="sm:w-fit">
        Save emails
      </SubmitButton>
    </form>
  );
}
