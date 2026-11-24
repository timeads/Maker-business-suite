"use client";

import { useActionState, useState } from "react";
import { Paperclip } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { FormMessage } from "@/components/ui/form-message";
import { Input, Label } from "@/components/ui/input";
import { SubmitButton } from "@/components/ui/submit-button";
import { parseRecipients } from "@/lib/stock/po/mime";
import { RequestKey } from "../../forms";
import { sendOrderEmail } from "./email-actions";

export type EmailCompose = {
  /** The mailbox it will go from. */
  from: string;
  to: string;
  subject: string;
  body: string;
  ccMe: boolean;
  filename: string;
  /** The button's words: "Send & mark ordered", "Send the changed order", … */
  sendLabel: string;
  isDraft: boolean;
  /** Set when the order has changed since it was last emailed. */
  changed: { sentOn: string; changes: string[] } | null;
  supplierName: string;
  hasSavedEmail: boolean;
};

/**
 * The email for one order: write it (it starts from the workspace's own
 * template), look at exactly what will go and to whom, then send. Nothing is
 * sent until the second button is pressed.
 */
export function OrderEmail({
  slug,
  orderId,
  compose,
  primary,
}: {
  slug: string;
  orderId: string;
  compose: EmailCompose;
  /** This is the screen's main action (a draft waiting to go). */
  primary: boolean;
}) {
  const [state, action] = useActionState(sendOrderEmail.bind(null, slug, orderId), {});
  const [to, setTo] = useState(compose.to);
  const [subject, setSubject] = useState(compose.subject);
  const [body, setBody] = useState(compose.body);
  const [ccMe, setCcMe] = useState(compose.ccMe);
  const [looking, setLooking] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const recipients = parseRecipients(to);
  const preview = () => {
    if (recipients.bad.length > 0) {
      return setProblem(`Not an email address: ${recipients.bad.join(", ")}`);
    }
    if (recipients.ok.length === 0) return setProblem("Add the supplier's email address.");
    if (!subject.trim()) return setProblem("Add a subject.");
    if (!body.trim()) return setProblem("Add a message.");
    setProblem(null);
    setLooking(true);
  };

  if (state.sent) {
    return <FormMessage kind="success">{state.message}</FormMessage>;
  }

  return (
    <form action={action} className="flex flex-col gap-3">
      {/* One key for this page's email: both presses of Send carry it. */}
      <RequestKey />
      {compose.changed && (
        <div className="border-ochre/30 bg-ochre-soft text-ochre-text rounded-lg border px-3 py-2 text-sm">
          <p className="font-semibold">Changed since you emailed it on {compose.changed.sentOn}</p>
          {compose.changed.changes.length > 0 && (
            <ul className="font-read mt-1 list-disc pl-5">
              {compose.changed.changes.map((change) => (
                <li key={change}>{change}</li>
              ))}
            </ul>
          )}
          <p className="mt-1 text-xs">
            Sending again replies in the same email conversation, with the new PDF.
          </p>
        </div>
      )}

      {/* The fields stay in the form while the preview is showing, so what is sent is what was seen. */}
      <div className={looking ? "hidden" : "flex flex-col gap-3"}>
        <div className="grid items-center gap-x-3 gap-y-2 sm:grid-cols-[5rem_1fr]">
          <span className="text-muted-foreground text-sm">From</span>
          <span className="font-read text-sm">{compose.from}</span>
          <Label htmlFor="po-email-to">To</Label>
          <Input
            id="po-email-to"
            name="to"
            value={to}
            onChange={(event) => setTo(event.target.value)}
            placeholder="name@supplier.example, other@supplier.example"
            maxLength={1000}
          />
          <Label htmlFor="po-email-subject">Subject</Label>
          <Input
            id="po-email-subject"
            name="subject"
            value={subject}
            onChange={(event) => setSubject(event.target.value)}
            maxLength={300}
          />
        </div>
        {!compose.hasSavedEmail && (
          <p className="text-muted-foreground text-xs">
            {compose.supplierName} has no email saved yet. Whoever you send this to is saved as
            their contact for next time. Put a comma between several addresses.
          </p>
        )}
        <textarea
          name="body"
          value={body}
          onChange={(event) => setBody(event.target.value)}
          rows={9}
          maxLength={20000}
          aria-label="Message"
          className="border-input bg-card font-read rounded-md border px-3 py-2 text-sm"
        />
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            name="cc_me"
            checked={ccMe}
            onChange={(event) => setCcMe(event.target.checked)}
          />
          Send a copy to {compose.from}
        </label>
        <p className="text-muted-foreground flex items-center gap-1.5 text-xs">
          <Paperclip className="size-3.5" /> {compose.filename} is attached when it goes.
        </p>
        <FormMessage>{problem ?? state.error}</FormMessage>
        <div>
          <Button type="button" variant={primary ? "default" : "outline"} onClick={preview}>
            Look it over
          </Button>
        </div>
      </div>

      {looking && (
        <div className="flex flex-col gap-3">
          <dl className="grid gap-x-3 gap-y-1.5 text-sm sm:grid-cols-[5rem_1fr]">
            <dt className="text-muted-foreground">From</dt>
            <dd className="font-read">{compose.from}</dd>
            <dt className="text-muted-foreground">To</dt>
            <dd className="font-read">{recipients.ok.join(", ")}</dd>
            {ccMe && !recipients.ok.some((a) => a.toLowerCase() === compose.from.toLowerCase()) && (
              <>
                <dt className="text-muted-foreground">Copy to</dt>
                <dd className="font-read">{compose.from}</dd>
              </>
            )}
            <dt className="text-muted-foreground">Subject</dt>
            <dd className="font-read font-semibold">{subject.trim()}</dd>
            <dt className="text-muted-foreground">Attached</dt>
            <dd className="font-read flex items-center gap-1.5">
              <Paperclip className="size-3.5" /> {compose.filename}
              {compose.isDraft && <Badge tone="waiting">Will say “Ordered”</Badge>}
            </dd>
          </dl>
          <p className="bg-sunken font-read rounded-md p-3 text-sm whitespace-pre-wrap">{body}</p>
          {compose.isDraft && (
            <p className="text-muted-foreground text-xs">
              Sending also marks this order as ordered, so it counts as on its way.
            </p>
          )}
          <FormMessage>{state.error}</FormMessage>
          <div className="flex flex-wrap gap-2">
            <SubmitButton variant={primary ? "default" : "outline"} pendingText="Sending…">
              {compose.sendLabel}
            </SubmitButton>
            <Button type="button" variant="ghost" onClick={() => setLooking(false)}>
              Change it
            </Button>
          </div>
        </div>
      )}
    </form>
  );
}
