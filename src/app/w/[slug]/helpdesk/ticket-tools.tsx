"use client";

import { useActionState, useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { FormMessage } from "@/components/ui/form-message";
import { Input, Label, Select } from "@/components/ui/input";
import { SubmitButton } from "@/components/ui/submit-button";
import { cn } from "@/lib/utils";
import {
  addTicketNote,
  assignTicket,
  mergeTicket,
  setTicketPriority,
  snoozeTicket,
  type HelpdeskState,
} from "./actions";
import { ReplyForm } from "./reply-form";

const small = "h-[30px] w-auto py-0 pr-7 pl-2 text-xs font-semibold";

/** Who has it, how urgent it is, and when to bring it back: three small menus. */
export function TicketMenus({
  slug,
  ticketId,
  assignee,
  priority,
  snoozed,
  people,
  snoozeChoices,
}: {
  slug: string;
  ticketId: string;
  assignee: string | null;
  priority: string;
  snoozed: string | null;
  people: { id: string; name: string }[];
  snoozeChoices: { key: string; label: string; until: string }[];
}) {
  const [pending, start] = useTransition();
  return (
    <div className={cn("flex flex-wrap items-center gap-1.5", pending && "opacity-60")}>
      <Select
        aria-label="Who has this conversation"
        value={assignee ?? ""}
        onChange={(e) => start(() => assignTicket(slug, ticketId, e.target.value))}
        className={small}
      >
        <option value="">Nobody has it</option>
        {people.map((person) => (
          <option key={person.id} value={person.id}>
            {person.name}
          </option>
        ))}
      </Select>
      <Select
        aria-label="How urgent"
        value={priority}
        onChange={(e) => start(() => setTicketPriority(slug, ticketId, e.target.value))}
        className={small}
      >
        <option value="low">Low</option>
        <option value="normal">Normal</option>
        <option value="high">High</option>
        <option value="urgent">Urgent</option>
      </Select>
      <Select
        aria-label="Snooze"
        value=""
        onChange={(e) => {
          const value = e.target.value;
          if (!value) return;
          start(() => snoozeTicket(slug, ticketId, value === "wake" ? null : value));
        }}
        className={small}
      >
        <option value="">{snoozed ? `Snoozed until ${snoozed}` : "Snooze…"}</option>
        {snoozed && <option value="wake">Bring it back now</option>}
        {snoozeChoices.map((choice) => (
          <option key={choice.key} value={choice.until}>
            {choice.label}
          </option>
        ))}
      </Select>
    </div>
  );
}

type Template = { id: string; name: string; body: string };

/** One box, two jobs: an email to the customer, or a note only the team sees. */
export function Composer({
  slug,
  ticketId,
  templates,
  canDraft,
  canSend,
}: {
  slug: string;
  ticketId: string;
  templates: Template[];
  canDraft: boolean;
  canSend: boolean;
}) {
  const [mode, setMode] = useState<"reply" | "note">("reply");
  const [saves, setSaves] = useState(0);
  const [note, noteAction] = useActionState<HelpdeskState, FormData>(async (prev, formData) => {
    const result = await addTicketNote(slug, ticketId, prev, formData);
    if (result.message) setSaves((n) => n + 1);
    return result;
  }, {});

  // "r" and "n" jump into the box from anywhere on the page.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      if (event.key !== "r" && event.key !== "n") return;
      event.preventDefault();
      const next = event.key === "r" ? "reply" : "note";
      setMode(next);
      requestAnimationFrame(() =>
        document.getElementById(next === "reply" ? "reply" : "note")?.focus(),
      );
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const tab = (key: "reply" | "note", label: string) => (
    <button
      type="button"
      role="tab"
      aria-selected={mode === key}
      onClick={() => setMode(key)}
      className={cn(
        "-mb-px border-b-2 px-1 py-2 text-sm transition-colors duration-150",
        mode === key
          ? "border-ochre font-semibold"
          : "text-muted-foreground hover:text-foreground border-transparent",
      )}
    >
      {label}
    </button>
  );

  return (
    <div
      className={cn(
        "border-border rounded-lg border",
        mode === "note" ? "bg-note border-note-border" : "bg-card",
      )}
    >
      <div role="tablist" className="border-border flex gap-4 border-b px-4">
        {tab("reply", "Reply to customer")}
        {tab("note", "Note for the team")}
      </div>
      <div className="p-4">
        {mode === "reply" ? (
          <ReplyForm
            slug={slug}
            ticketId={ticketId}
            templates={templates}
            canDraft={canDraft}
            canSend={canSend}
          />
        ) : (
          <form action={noteAction} key={saves} className="flex flex-col gap-3">
            <Label htmlFor="note" className="sr-only">
              Note for the team
            </Label>
            <textarea
              id="note"
              name="body"
              rows={4}
              maxLength={4000}
              required
              placeholder="Only your team sees this. Type @ and a first name to get someone's attention."
              className="border-note-border bg-card placeholder:text-muted-foreground focus-visible:border-ochre focus-visible:ring-ochre/25 font-read w-full rounded-sm border px-[11px] py-2 text-sm outline-none focus-visible:ring-2"
            />
            <FormMessage>{note.error}</FormMessage>
            <SubmitButton variant="dark" pendingText="Saving…" className="sm:w-fit">
              Add note
            </SubmitButton>
          </form>
        )}
      </div>
    </div>
  );
}

export function MergeForm({ slug, ticketId }: { slug: string; ticketId: string }) {
  const router = useRouter();
  const [state, action] = useActionState<HelpdeskState & { into?: number }, FormData>(
    async (prev, formData) => {
      const result = await mergeTicket(slug, ticketId, prev, formData);
      if (result.into) router.push(`/w/${slug}/helpdesk?view=all&t=${result.into}`);
      return result;
    },
    {},
  );
  return (
    <form action={action} className="flex flex-col gap-2">
      <Label htmlFor="merge-into">Join into conversation</Label>
      <div className="flex gap-2">
        <Input
          id="merge-into"
          name="into"
          inputMode="numeric"
          placeholder="#12"
          className="w-24"
          required
        />
        <SubmitButton variant="outline" size="default" pendingText="Joining…">
          Join
        </SubmitButton>
      </div>
      <p className="text-muted-foreground text-xs">
        For when someone writes twice about the same thing. Everything here moves across.
      </p>
      <FormMessage>{state.error}</FormMessage>
    </form>
  );
}

/** j and k step through the list, e closes, u goes back to the list. */
export function Shortcuts({
  previous,
  next,
  back,
  closeFormId,
}: {
  previous: string | null;
  next: string | null;
  back: string;
  closeFormId: string | null;
}) {
  const router = useRouter();
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      if (event.key === "j" && next) router.push(next);
      else if (event.key === "k" && previous) router.push(previous);
      else if (event.key === "u") router.push(back);
      else if (event.key === "e" && closeFormId) {
        (document.getElementById(closeFormId) as HTMLFormElement | null)?.requestSubmit();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [router, previous, next, back, closeFormId]);
  return null;
}
