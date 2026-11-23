"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowLeft, Check, Copy, Download, Loader2, Send, Settings2 } from "lucide-react";
import { toast } from "./ui";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "./ui";
import { useBuilder } from "./context";
import { Field } from "./fields";
import { copyText, selectClass } from "./shared";
import type { SaveStatus } from "./useAutosave";
import { TemplateMenu } from "./TemplateMenu";

/** The email's name. Click to change it; Enter or clicking away keeps the change, Esc drops it. */
function Title() {
  const { doc, dispatch } = useBuilder();
  const [draft, setDraft] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (draft !== null) input.current?.select();
    // Only when editing starts, not on every letter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft !== null]);
  const keep = () => {
    const title = (draft ?? "").trim();
    if (title) dispatch({ type: "setTitle", title: title.slice(0, 120) });
    setDraft(null);
  };
  if (draft === null) {
    return (
      <button
        type="button"
        onClick={() => setDraft(doc.title)}
        title="Click to rename"
        aria-label={`Email name: ${doc.title}. Click to rename`}
        className="hover:bg-sunken max-w-[36ch] min-w-0 truncate rounded px-1.5 py-1 text-left text-sm font-bold"
      >
        {doc.title}
      </button>
    );
  }
  return (
    <Input
      ref={input}
      aria-label="Email name"
      className="h-8 w-64 text-sm font-bold"
      value={draft}
      maxLength={120}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={keep}
      onKeyDown={(e) => {
        if (e.key === "Enter") keep();
        if (e.key === "Escape") setDraft(null);
      }}
    />
  );
}

/** The subject, the preview text and where the email is sent from: things about the email that are not on its canvas. */
function EmailDetails() {
  const { doc, dispatch } = useBuilder();
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button type="button" variant="outline" size="sm">
          <Settings2 className="mr-1.5 h-4 w-4" /> Email details
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 space-y-3">
        <Field
          label={`Subject (${doc.meta.subject.length} characters)`}
          hint={
            doc.meta.subject.length > 60 ? "Over 60 characters: phones will cut it off." : undefined
          }
        >
          <Input
            className="h-9"
            value={doc.meta.subject}
            maxLength={120}
            onChange={(e) => dispatch({ type: "setMeta", patch: { subject: e.target.value } })}
          />
        </Field>
        <Field label="Preview text" hint="Shown next to the subject in the inbox.">
          <Input
            className="h-9"
            value={doc.meta.previewText}
            maxLength={160}
            onChange={(e) => dispatch({ type: "setMeta", patch: { previewText: e.target.value } })}
          />
        </Field>
        <Field
          label="Sending with"
          hint={
            doc.platform === "shopify"
              ? "Shopify fills in the unsubscribe link when it sends."
              : "You put your platform's unsubscribe tag in place of the marker in the HTML."
          }
        >
          <select
            className={selectClass}
            value={doc.platform}
            onChange={(e) =>
              dispatch({
                type: "setPlatform",
                platform: e.target.value === "other" ? "other" : "shopify",
              })
            }
          >
            <option value="shopify">Shopify Messaging</option>
            <option value="other">Another email platform</option>
          </select>
        </Field>
      </PopoverContent>
    </Popover>
  );
}

/**
 * "Send test". The hub cannot send email, and does not pretend to: this says so, and gives the
 * steps for sending a test from the platform the email will really go out from.
 */
function SendTest({ onCopy }: { onCopy: () => void }) {
  const { doc } = useBuilder();
  const [open, setOpen] = useState(false);
  const copyField = async (what: string, value: string) => {
    if (await copyText(value)) toast.success(`${what} copied.`);
    else toast.error("Copying is blocked in this browser.");
  };
  return (
    <>
      <Button type="button" variant="outline" size="sm" onClick={() => setOpen(true)}>
        <Send className="mr-1.5 h-4 w-4" /> Send test
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Send yourself a test</DialogTitle>
            <DialogDescription>
              The hub does not send email, so a test goes out from{" "}
              {doc.platform === "shopify" ? "Shopify Messaging" : "your email platform"}, the same
              place the real email will. That also makes it a truer test.
            </DialogDescription>
          </DialogHeader>
          {doc.platform === "shopify" ? (
            <ol
              className="text-muted-foreground list-decimal space-y-1.5 pl-5 text-sm"
              data-test-steps="shopify"
            >
              <li>Copy the HTML with the button below.</li>
              <li>
                In Shopify admin, open Marketing, then Campaigns, and create an email. This needs a
                computer, not a phone.
              </li>
              <li>
                Choose to code your own email, and replace everything in the code box with what you
                copied.
              </li>
              <li>Paste the subject and preview text into their boxes.</li>
              <li>
                Use Shopify's Send test, and open the test on your phone as well as your computer.
              </li>
            </ol>
          ) : (
            <ol
              className="text-muted-foreground list-decimal space-y-1.5 pl-5 text-sm"
              data-test-steps="other"
            >
              <li>Copy the HTML with the button below.</li>
              <li>
                In your email platform, create a campaign and choose its option to paste or import
                your own HTML.
              </li>
              <li>
                Paste it in. Find PASTE-YOUR-UNSUBSCRIBE-LINK-HERE and replace it with your
                platform's own unsubscribe tag.
              </li>
              <li>Paste the subject and preview text into their boxes.</li>
              <li>
                Use your platform's test send, and open the test on your phone as well as your
                computer.
              </li>
            </ol>
          )}
          <DialogFooter className="gap-2 sm:justify-start">
            <Button type="button" onClick={onCopy}>
              <Copy className="mr-1.5 h-4 w-4" /> Copy HTML
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => copyField("Subject", doc.meta.subject)}
              disabled={!doc.meta.subject}
            >
              Copy subject
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => copyField("Preview text", doc.meta.previewText)}
              disabled={!doc.meta.previewText}
            >
              Copy preview text
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function Status({ status, onRetry }: { status: SaveStatus; onRetry: () => void }) {
  if (status === "error") {
    return (
      <span className="text-brick flex items-center gap-1 text-xs font-medium" role="alert">
        Couldn't save —{" "}
        <button type="button" className="underline" onClick={onRetry}>
          Retry
        </button>
      </span>
    );
  }
  return (
    <span className="text-muted-foreground flex items-center gap-1 text-xs" role="status">
      {status === "saving" ? (
        <>
          <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> Saving…
        </>
      ) : (
        <>
          <Check className="h-3 w-3" aria-hidden /> Changes saved
        </>
      )}
    </span>
  );
}

export function TopBar({
  status,
  onRetry,
  onBack,
  onCopy,
  onDownload,
  onExit,
  exiting,
}: {
  status: SaveStatus;
  onRetry: () => void;
  onBack: () => void;
  onCopy: () => void;
  onDownload: () => void;
  onExit: () => void;
  exiting: boolean;
}) {
  return (
    <header className="bg-card flex h-12 shrink-0 items-center gap-2 border-b px-2">
      <button
        type="button"
        onClick={onBack}
        className="text-muted-foreground hover:bg-sunken hover:text-foreground flex h-8 items-center gap-1 rounded px-2 text-sm"
      >
        <ArrowLeft className="h-4 w-4" aria-hidden /> Emails
      </button>
      <span className="bg-border h-5 w-px" aria-hidden />
      <Title />
      <Status status={status} onRetry={onRetry} />
      <div className="ml-auto flex items-center gap-2">
        <EmailDetails />
        <SendTest onCopy={onCopy} />
        <Button type="button" variant="outline" size="sm" onClick={onDownload}>
          <Download className="mr-1.5 h-4 w-4" /> Download
        </Button>
        <span className="flex">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="rounded-r-none border-r-0"
            onClick={onExit}
            disabled={exiting}
          >
            {exiting && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />} Save and exit
          </Button>
          <TemplateMenu />
        </span>
        <Button type="button" size="sm" onClick={onCopy}>
          <Copy className="mr-1.5 h-4 w-4" /> Copy HTML
        </Button>
      </div>
    </header>
  );
}
