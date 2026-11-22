"use client";

import { useActionState, useRef, useState } from "react";
import { FormMessage } from "@/components/ui/form-message";
import { Label, Select } from "@/components/ui/input";
import { SubmitButton } from "@/components/ui/submit-button";
import { draftTicketReply, sendTicketReply, type HelpdeskState } from "./actions";

type Template = { id: string; name: string; body: string };

export function ReplyForm({
  slug,
  ticketId,
  templates,
  canDraft,
  canSend,
}: {
  slug: string;
  ticketId: string;
  /** Saved replies with the customer's details already filled in. */
  templates: Template[];
  canDraft: boolean;
  canSend: boolean;
}) {
  const [body, setBody] = useState("");
  const [fromDraft, setFromDraft] = useState(false);
  const textarea = useRef<HTMLTextAreaElement>(null);

  // A sent reply clears the box.
  const [sendState, sendAction] = useActionState<HelpdeskState, FormData>(
    async (prev, formData) => {
      const result = await sendTicketReply(slug, ticketId, prev, formData);
      if (result.message) {
        setBody("");
        setFromDraft(false);
      }
      return result;
    },
    {},
  );
  // A draft arrives into the box for the person to read and change.
  const [draftState, draftAction] = useActionState<HelpdeskState, FormData>(async (prev) => {
    const result = await draftTicketReply(slug, ticketId, prev);
    if (result.draft) {
      setBody(result.draft);
      setFromDraft(true);
      textarea.current?.focus();
    }
    return result;
  }, {});

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end gap-3">
        {templates.length > 0 && (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="template" className="text-xs">
              Start from a saved reply
            </Label>
            <Select
              id="template"
              value=""
              onChange={(event) => {
                const template = templates.find((t) => t.id === event.target.value);
                if (template) {
                  setBody(template.body);
                  setFromDraft(false);
                }
              }}
              className="h-9 w-56"
            >
              <option value="">Choose…</option>
              {templates.map((template) => (
                <option key={template.id} value={template.id}>
                  {template.name}
                </option>
              ))}
            </Select>
          </div>
        )}
        {canDraft && (
          <form action={draftAction}>
            <SubmitButton variant="outline" size="sm" pendingText="Drafting…" className="h-9">
              Draft with Claude
            </SubmitButton>
          </form>
        )}
      </div>

      <form action={sendAction} className="flex flex-col gap-3">
        <Label htmlFor="reply" className="sr-only">
          Your reply
        </Label>
        <textarea
          id="reply"
          name="body"
          ref={textarea}
          value={body}
          onChange={(event) => setBody(event.target.value)}
          rows={6}
          placeholder="Write your reply…"
          className="border-input bg-card placeholder:text-muted-foreground focus-visible:border-ochre focus-visible:ring-ochre/25 font-read w-full rounded-sm border px-[11px] py-2 text-sm outline-none focus-visible:ring-2"
        />
        {fromDraft && (
          <p className="text-muted-foreground text-xs">
            Drafted by Claude from this conversation and the customer&apos;s orders. Read it through
            and change anything that isn&apos;t right before you send.
          </p>
        )}
        <FormMessage>{sendState.error ?? draftState.error}</FormMessage>
        {sendState.message && !body && (
          <FormMessage kind="success">{sendState.message}</FormMessage>
        )}
        {canSend ? (
          <SubmitButton pendingText="Sending…" className="sm:w-fit" disabled={!body.trim()}>
            Send reply
          </SubmitButton>
        ) : (
          <p className="text-muted-foreground text-sm">
            Sending email isn&apos;t switched on for this environment yet.
          </p>
        )}
      </form>
    </div>
  );
}
