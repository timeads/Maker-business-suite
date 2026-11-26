"use client";

import { useActionState, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { FormMessage } from "@/components/ui/form-message";
import { Input, Label } from "@/components/ui/input";
import { SubmitButton } from "@/components/ui/submit-button";
import {
  DEFAULT_EMAIL_WORDS,
  bookingEmail,
  unknownFillIns,
  type Extras,
  type MessageKey,
  type sampleBooking,
} from "@/lib/bookings/words";
import type { BookingsState } from "./actions";
import { saveMessageWords, saveReplyTo, sendTestEmail } from "./words-actions";

const textarea =
  "border-input bg-card placeholder:text-muted-foreground focus-visible:ring-ring font-read w-full rounded-md border px-3 py-2 text-sm outline-none focus-visible:ring-2";

function Result({ state }: { state: BookingsState }) {
  return (
    <>
      <FormMessage>{state.error}</FormMessage>
      <FormMessage kind="success">{state.message}</FormMessage>
    </>
  );
}

export type MessageEditorProps = {
  slug: string;
  messageKey: MessageKey;
  name: string;
  when: string;
  subject: string;
  body: string;
  /** The business has its own words for this one. */
  changed: boolean;
  fillIns: { name: string; says: string }[];
  sample: ReturnType<typeof sampleBooking>;
  extras: Extras;
  canEdit: boolean;
};

/**
 * One message: its subject and words, the fill-ins it can use, and a preview
 * filled with a made-up booking, drawn by the same code that sends it.
 */
export function MessageEditor(props: MessageEditorProps) {
  const { slug, messageKey, sample, extras, canEdit } = props;
  const [subject, setSubject] = useState(props.subject);
  const [body, setBody] = useState(props.body);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const [saved, saveAction] = useActionState(saveMessageWords.bind(null, slug, messageKey), {});
  const [tested, testAction] = useActionState(sendTestEmail.bind(null, slug, messageKey), {});

  const unknown = unknownFillIns(messageKey, `${subject}\n${body}`);
  const preview = bookingEmail(
    messageKey,
    sample,
    {
      ...DEFAULT_EMAIL_WORDS,
      messages: { [messageKey]: { subject: subject || "(no subject)", body: body || " " } },
    },
    extras,
  );

  // Puts a fill-in where the cursor is in the words, or at the end.
  const insert = (name: string) => {
    const box = bodyRef.current;
    const token = `{{${name}}}`;
    if (!box) return setBody((b) => b + token);
    const start = box.selectionStart ?? body.length;
    const end = box.selectionEnd ?? body.length;
    const next = body.slice(0, start) + token + body.slice(end);
    setBody(next);
    requestAnimationFrame(() => {
      box.focus();
      box.setSelectionRange(start + token.length, start + token.length);
    });
  };

  return (
    <details className="group border-border bg-card rounded-lg border">
      <summary className="hover:bg-hover flex cursor-pointer list-none flex-wrap items-center gap-2 rounded-lg px-4 py-3 [&::-webkit-details-marker]:hidden">
        <span className="text-sm font-semibold">{props.name}</span>
        {props.changed ? (
          <Badge tone="open">Your words</Badge>
        ) : (
          <Badge tone="closed">Our words</Badge>
        )}
        <span className="text-muted-foreground w-full text-xs sm:ml-auto sm:w-auto">
          {props.when}
        </span>
      </summary>
      <form action={saveAction} className="flex flex-col gap-4 border-t px-4 py-4">
        <input type="hidden" name="sample_workshop" value={sample.service_name} />
        <input type="hidden" name="sample_place" value={sample.location ?? ""} />
        <div className="grid gap-4 lg:grid-cols-2">
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`${messageKey}-subject`}>Subject</Label>
              <Input
                id={`${messageKey}-subject`}
                name="subject"
                value={subject}
                maxLength={200}
                onChange={(e) => setSubject(e.target.value.replace(/[\r\n]/g, ""))}
                disabled={!canEdit}
                className="font-read"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`${messageKey}-body`}>What it says</Label>
              <textarea
                id={`${messageKey}-body`}
                ref={bodyRef}
                name="body"
                rows={14}
                maxLength={5000}
                value={body}
                onChange={(e) => setBody(e.target.value)}
                disabled={!canEdit}
                className={textarea}
              />
              {unknown.length > 0 && (
                <p className="text-brick text-xs" role="alert">
                  This email can&apos;t fill in {unknown.map((u) => `{{${u}}}`).join(", ")}.
                </p>
              )}
            </div>
            <div className="flex flex-col gap-1.5">
              <p className="text-xs font-semibold">Fill-ins</p>
              <ul className="flex flex-col gap-1">
                {props.fillIns.map((fill) => (
                  <li key={fill.name} className="flex flex-wrap items-baseline gap-x-2 text-xs">
                    <button
                      type="button"
                      onClick={() => insert(fill.name)}
                      disabled={!canEdit}
                      className="bg-sunken hover:bg-hover rounded-sm px-1.5 py-0.5 font-mono"
                      title="Put this in the words"
                    >
                      {`{{${fill.name}}}`}
                    </button>
                    <span className="text-muted-foreground">{fill.says}</span>
                  </li>
                ))}
              </ul>
              <p className="text-muted-foreground text-xs">
                A line holding only a fill-in with nothing to say is left out, so “Where:” never
                shows empty.
              </p>
            </div>
          </div>
          <div className="flex flex-col gap-1.5">
            <p className="text-xs font-semibold">Preview, with a made-up booking</p>
            <div className="bg-sunken flex flex-col gap-2 rounded-md p-3">
              <p className="font-read text-sm">
                <span className="text-muted-foreground">Subject: </span>
                {preview.subject}
              </p>
              <p className="font-read border-border rounded-sm border bg-white p-3 text-sm whitespace-pre-wrap text-black">
                {preview.text}
              </p>
            </div>
          </div>
        </div>
        <Result state={saved} />
        <Result state={tested} />
        {canEdit ? (
          <div className="flex flex-wrap gap-2">
            <SubmitButton
              variant="dark"
              pendingText="Saving…"
              name="intent"
              value="save"
              disabled={unknown.length > 0}
            >
              Save these words
            </SubmitButton>
            <SubmitButton variant="outline" formAction={testAction} pendingText="Sending…">
              Send me a test
            </SubmitButton>
            {props.changed && (
              <SubmitButton variant="ghost" name="intent" value="reset" pendingText="Saving…">
                Go back to our words
              </SubmitButton>
            )}
          </div>
        ) : (
          <p className="text-muted-foreground text-sm">An owner or admin can change these words.</p>
        )}
      </form>
    </details>
  );
}

export function ReplyToForm({ slug, replyTo }: { slug: string; replyTo: string }) {
  const [state, action] = useActionState(saveReplyTo.bind(null, slug), {});
  return (
    <form action={action} className="flex flex-col gap-2">
      <Label htmlFor="reply-to">When a customer replies, send it to</Label>
      <div className="flex flex-wrap gap-2">
        <Input
          id="reply-to"
          name="reply_to"
          type="email"
          defaultValue={replyTo}
          placeholder="hello@yourstudio.com"
          className="max-w-sm"
        />
        <SubmitButton variant="outline" pendingText="Saving…">
          Save
        </SubmitButton>
      </div>
      <p className="text-muted-foreground text-xs">
        Your help desk address works well here. Left empty, replies go to the address the emails
        come from, which nobody at your business reads.
      </p>
      <Result state={state} />
    </form>
  );
}
