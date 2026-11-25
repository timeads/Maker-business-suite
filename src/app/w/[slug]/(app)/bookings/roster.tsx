"use client";

import { useActionState, useState, useTransition } from "react";
import { Check, Printer, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { FormMessage } from "@/components/ui/form-message";
import { Input, Label, Select } from "@/components/ui/input";
import { SubmitButton } from "@/components/ui/submit-button";
import { cn } from "@/lib/utils";
import type { BookingsState } from "./actions";
import {
  addPerson,
  cancelBooking,
  emailEveryone,
  moveBooking,
  resendConfirmation,
  saveBookingContact,
  saveBookingNotes,
  saveSessionSettings,
  setAttendance,
} from "./roster-actions";

const textarea =
  "border-input bg-card placeholder:text-muted-foreground focus-visible:border-ochre focus-visible:ring-ochre/25 w-full rounded-sm border px-[11px] py-2 text-sm outline-none focus-visible:ring-2";

function Result({ state }: { state: BookingsState }) {
  return (
    <>
      <FormMessage>{state.error}</FormMessage>
      <FormMessage kind="success">{state.message}</FormMessage>
    </>
  );
}

export function PrintButton() {
  return (
    <Button variant="outline" size="sm" onClick={() => window.print()}>
      <Printer /> Print
    </Button>
  );
}

export type RosterPerson = {
  id: string;
  name: string;
  email: string;
  seats: number;
  attendance: "attended" | "no_show" | null;
  notes: string;
  tags: string[];
  manual: boolean;
  oversold: boolean;
  emails: boolean;
  paid: string | null;
  answers: [string, string][];
  /** Automatic emails that didn't go, or may not have, in plain words. */
  mailTrouble?: string[];
};

/** "Send the confirmation again": one press, and the result said in words. */
function ResendConfirmation({ slug, person }: { slug: string; person: RosterPerson }) {
  const [state, setState] = useState<BookingsState>({});
  const [pending, start] = useTransition();
  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs font-semibold">Lost their confirmation?</p>
      <p className="text-muted-foreground text-xs">
        We&apos;ll email it again with a fresh link to change or cancel. The link in the earlier
        email stops working.
      </p>
      <Result state={state} />
      <Button
        variant="outline"
        size="sm"
        className="w-fit"
        disabled={pending}
        onClick={() => start(async () => setState(await resendConfirmation(slug, person.id)))}
      >
        {pending ? "Sending…" : "Send the confirmation again"}
      </Button>
    </div>
  );
}

/** Two big tap targets: here, or didn't come. Tapping the lit one clears it. */
function CheckIn({ slug, person }: { slug: string; person: RosterPerson }) {
  const [mark, setMark] = useState(person.attendance);
  const [pending, start] = useTransition();
  const set = (next: "attended" | "no_show") => {
    const value = mark === next ? null : next;
    const before = mark;
    setMark(value);
    start(async () => {
      const result = await setAttendance(slug, person.id, value);
      if (result.error) setMark(before);
    });
  };
  const base =
    "inline-flex h-9 items-center gap-1.5 rounded-sm border px-3 text-sm font-semibold transition-colors duration-150 disabled:opacity-60";
  return (
    <div className="flex gap-1.5 print:hidden" aria-busy={pending}>
      <button
        type="button"
        aria-pressed={mark === "attended"}
        onClick={() => set("attended")}
        className={cn(
          base,
          mark === "attended"
            ? "bg-mint-soft text-mint-ink border-transparent"
            : "border-input hover:bg-hover",
        )}
      >
        <Check className="size-4" /> Here
      </button>
      <button
        type="button"
        aria-pressed={mark === "no_show"}
        onClick={() => set("no_show")}
        className={cn(
          base,
          mark === "no_show"
            ? "bg-brick-soft text-brick border-transparent"
            : "border-input text-muted-foreground hover:bg-hover",
        )}
      >
        <X className="size-4" /> No-show
      </button>
    </div>
  );
}

function PersonTools({
  slug,
  person,
  canManage,
  otherDates,
}: {
  slug: string;
  person: RosterPerson;
  canManage: boolean;
  otherDates: { id: string; label: string }[];
}) {
  const [notes, notesAction] = useActionState(saveBookingNotes.bind(null, slug, person.id), {});
  const [contact, contactAction] = useActionState(
    saveBookingContact.bind(null, slug, person.id),
    {},
  );
  const [moved, moveAction] = useActionState(moveBooking.bind(null, slug, person.id), {});
  const [cancelled, cancelAction] = useActionState(cancelBooking.bind(null, slug, person.id), {});
  const id = `p-${person.id}`;
  return (
    <div className="bg-panel grid gap-5 rounded-md p-4 md:grid-cols-2 print:hidden">
      <form action={notesAction} className="flex flex-col gap-2">
        <Label htmlFor={`${id}-notes`}>Notes for the team</Label>
        <textarea
          id={`${id}-notes`}
          name="notes"
          rows={3}
          maxLength={2000}
          defaultValue={person.notes}
          placeholder="Left-handed, bringing their own frame…"
          className={textarea}
        />
        <Label htmlFor={`${id}-tags`}>Tags</Label>
        <Input
          id={`${id}-tags`}
          name="tags"
          defaultValue={person.tags.join(", ")}
          placeholder="gift, returning"
        />
        <p className="text-muted-foreground text-xs">Separate tags with commas.</p>
        <Result state={notes} />
        <SubmitButton variant="outline" size="sm" pendingText="Saving…" className="w-fit">
          Save notes
        </SubmitButton>
      </form>

      {canManage && (
        <div className="flex flex-col gap-5">
          <form action={contactAction} className="flex flex-col gap-2">
            <Label htmlFor={`${id}-name`}>Name</Label>
            <Input id={`${id}-name`} name="name" defaultValue={person.name} required />
            <Label htmlFor={`${id}-email`}>Email</Label>
            <Input
              id={`${id}-email`}
              name="email"
              type="email"
              defaultValue={person.email}
              required
            />
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" name="emails" defaultChecked={person.emails} />
              Send them reminders and updates
            </label>
            <Result state={contact} />
            <SubmitButton variant="outline" size="sm" pendingText="Saving…" className="w-fit">
              Save details
            </SubmitButton>
          </form>

          {otherDates.length > 0 && (
            <form action={moveAction} className="flex flex-col gap-2">
              <Label htmlFor={`${id}-move`}>Move to another date</Label>
              <Select id={`${id}-move`} name="session" defaultValue="">
                <option value="" disabled>
                  Pick a date…
                </option>
                {otherDates.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.label}
                  </option>
                ))}
              </Select>
              <Result state={moved} />
              <SubmitButton variant="outline" size="sm" pendingText="Moving…" className="w-fit">
                Move and email them
              </SubmitButton>
            </form>
          )}

          <ResendConfirmation slug={slug} person={person} />

          <form action={cancelAction} className="flex flex-col gap-2">
            <p className="text-xs font-semibold">Cancel this booking</p>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" name="tell" defaultChecked />
              Email them to say it&apos;s cancelled
            </label>
            {person.paid && (
              <p className="text-muted-foreground text-xs">
                They paid {person.paid}. Refunds aren&apos;t automatic: send it from your Stripe
                account.
              </p>
            )}
            <Result state={cancelled} />
            <SubmitButton variant="danger" size="sm" pendingText="Cancelling…" className="w-fit">
              Cancel booking
            </SubmitButton>
          </form>
        </div>
      )}
    </div>
  );
}

/** One row per booking: who, how many, the check-in buttons, and everything else behind "Details". */
export function Roster({
  slug,
  people,
  canWrite,
  canManage,
  showCheckIn,
  otherDates,
}: {
  slug: string;
  people: RosterPerson[];
  canWrite: boolean;
  canManage: boolean;
  showCheckIn: boolean;
  otherDates: { id: string; label: string }[];
}) {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <ul className="divide-border flex flex-col divide-y">
      {people.map((p) => (
        <li key={p.id} className="flex flex-col gap-3 py-3 first:pt-0 last:pb-0">
          <div className="flex flex-wrap items-start gap-x-4 gap-y-2">
            <div className="min-w-0 flex-1 basis-56">
              <p className="flex flex-wrap items-center gap-x-2 gap-y-1 font-semibold">
                <span className="font-read">{p.name}</span>
                {p.seats > 1 && <Badge tone="open">{p.seats} places</Badge>}
                {p.oversold && <Badge tone="bad">Over the limit</Badge>}
                {p.manual && <Badge>Added by you</Badge>}
                {p.attendance === "attended" && (
                  <Badge tone="good" className="hidden print:inline-flex">
                    Here
                  </Badge>
                )}
                {(p.mailTrouble ?? []).map((words) => (
                  <Badge key={words} tone="bad" className="print:hidden">
                    {words}
                  </Badge>
                ))}
                {p.tags.map((tag) => (
                  <Badge key={tag} tone="waiting">
                    {tag}
                  </Badge>
                ))}
              </p>
              <p className="text-muted-foreground text-sm">
                <a href={`mailto:${p.email}`} className="hover:underline">
                  {p.email}
                </a>
                {p.paid && ` · paid ${p.paid}`}
              </p>
              {p.notes && <p className="font-read mt-1 text-sm">{p.notes}</p>}
              {p.answers.map(([question, answer]) => (
                <p key={question} className="font-read mt-1 text-sm">
                  <span className="text-muted-foreground">
                    {/[?:]$/.test(question) ? question : `${question}:`}
                  </span>{" "}
                  {answer}
                </p>
              ))}
            </div>
            {/* A box to tick by hand on the printed sheet. */}
            <span
              aria-hidden
              className="border-out hidden size-5 shrink-0 rounded-[4px] border-2 print:block"
            />
            {canWrite && (
              <div className="flex flex-wrap items-center gap-1.5">
                {showCheckIn && <CheckIn slug={slug} person={p} />}
                <Button
                  variant="ghost"
                  size="sm"
                  className="print:hidden"
                  aria-expanded={open === p.id}
                  onClick={() => setOpen(open === p.id ? null : p.id)}
                >
                  {open === p.id ? "Close" : "Details"}
                </Button>
              </div>
            )}
          </div>
          {open === p.id && (
            <PersonTools slug={slug} person={p} canManage={canManage} otherDates={otherDates} />
          )}
        </li>
      ))}
    </ul>
  );
}

export function AddPersonForm({ slug, sessionId }: { slug: string; sessionId: string }) {
  const [state, action] = useActionState(addPerson.bind(null, slug, sessionId), {});
  return (
    <form action={action} className="flex flex-col gap-3">
      <div className="grid gap-3 sm:grid-cols-[1fr_1fr_6rem]">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="add-name">Name</Label>
          <Input id="add-name" name="name" maxLength={120} required />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="add-email">Email</Label>
          <Input id="add-email" name="email" type="email" maxLength={200} required />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="add-seats">Places</Label>
          <Input id="add-seats" name="seats" type="number" min={1} max={50} defaultValue={1} />
        </div>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="add-notes">Note (only your team sees this)</Label>
        <Input id="add-notes" name="notes" maxLength={2000} placeholder="Paid cash at the fair" />
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" name="tell" defaultChecked />
        Email them the details
      </label>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" name="over" />
        Add them even if the date is full (go over the limit)
      </label>
      <Result state={state} />
      <SubmitButton variant="outline" pendingText="Adding…" className="sm:w-fit">
        Add to this date
      </SubmitButton>
    </form>
  );
}

export function SessionSettingsForm({
  slug,
  sessionId,
  capacity,
  closed,
  isPrivate,
  notes,
}: {
  slug: string;
  sessionId: string;
  capacity: number;
  closed: boolean;
  isPrivate: boolean;
  notes: string;
}) {
  const [state, action] = useActionState(saveSessionSettings.bind(null, slug, sessionId), {});
  return (
    <form action={action} className="flex flex-col gap-3">
      <div className="flex flex-col gap-1.5 sm:w-32">
        <Label htmlFor="set-capacity">Places</Label>
        <Input
          id="set-capacity"
          name="capacity"
          type="number"
          min={1}
          max={500}
          defaultValue={capacity}
          required
        />
      </div>
      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" name="closed" defaultChecked={closed} className="mt-1" />
        <span>
          Stop taking bookings online
          <span className="text-muted-foreground block text-xs">
            The date comes off your booking page. Everyone already booked keeps their place.
          </span>
        </span>
      </label>
      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" name="private" defaultChecked={isPrivate} className="mt-1" />
        <span>
          Private date
          <span className="text-muted-foreground block text-xs">
            For a party or a group you&apos;ve arranged yourself. Never shown on your booking page;
            you add the people.
          </span>
        </span>
      </label>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="set-notes">Note for the team</Label>
        <textarea
          id="set-notes"
          name="notes"
          rows={2}
          maxLength={2000}
          defaultValue={notes}
          placeholder="Set up the big table. Sam is teaching."
          className={textarea}
        />
      </div>
      <Result state={state} />
      <SubmitButton variant="outline" pendingText="Saving…" className="sm:w-fit">
        Save
      </SubmitButton>
    </form>
  );
}

export function EmailEveryoneForm({
  slug,
  sessionId,
  count,
}: {
  slug: string;
  sessionId: string;
  count: number;
}) {
  const [state, action] = useActionState(emailEveryone.bind(null, slug, sessionId), {});
  return (
    <form action={action} className="flex flex-col gap-3">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="mail-subject">Subject</Label>
        <Input
          id="mail-subject"
          name="subject"
          maxLength={200}
          placeholder="Parking for Saturday"
          required
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="mail-body">Message</Label>
        <textarea
          id="mail-body"
          name="body"
          rows={5}
          maxLength={5000}
          required
          className={cn(textarea, "font-read")}
        />
      </div>
      <p className="text-muted-foreground text-xs">
        Goes to {count === 1 ? "the 1 person" : `all ${count} people`} booked, each as their own
        email. We start it with &quot;Hi&quot; and their first name.
      </p>
      <Result state={state} />
      <SubmitButton variant="outline" pendingText="Sending…" className="sm:w-fit">
        Send to everyone
      </SubmitButton>
    </form>
  );
}
