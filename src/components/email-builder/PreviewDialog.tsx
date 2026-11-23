"use client";

import { useMemo, useState } from "react";
import { Inbox, Link2, Monitor, Smartphone, type LucideIcon } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./ui";
import { Input } from "@/components/ui/input";
import { BRANDS } from "@/lib/design/brands";
import { SIZE_LIMIT, docChecks, htmlBytes, renderDocHtml } from "@/lib/design";
import { cn } from "@/lib/utils";
import { useBuilder, type Device } from "./context";
import { Field } from "./fields";
import { LinkChecker } from "./LinkChecker";

type Tab = Device | "inbox" | "links";
// The email is 600 wide. The frame is a little wider than that on a computer, because at 600 or
// under the email's own phone rules would apply.
const FRAME: Record<Device, number> = { desktop: 680, mobile: 375 };
const TABS: [Tab, string, LucideIcon][] = [
  ["desktop", "Desktop", Monitor],
  ["mobile", "Mobile", Smartphone],
  ["inbox", "Inbox", Inbox],
  ["links", "Links", Link2],
];

/** How close the email is to the size at which Gmail cuts it off. */
function SizeMeter({ bytes }: { bytes: number }) {
  const share = bytes / SIZE_LIMIT;
  const level = share < 0.8 ? "ok" : share < 1 ? "near" : "over";
  const kb = (n: number) => Math.max(1, Math.round(n / 1024));
  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between text-xs">
        <span className="font-medium">Email size</span>
        <span className="text-muted-foreground tabular-nums">
          {kb(bytes)} of {kb(SIZE_LIMIT)} KB
        </span>
      </div>
      <div
        className="bg-sunken h-2 overflow-hidden rounded-full"
        role="progressbar"
        aria-label="Email size"
        aria-valuemin={0}
        aria-valuemax={kb(SIZE_LIMIT)}
        aria-valuenow={kb(bytes)}
      >
        <div
          className={cn(
            "h-full rounded-full",
            level === "ok" ? "bg-mint-ink" : level === "near" ? "bg-ochre" : "bg-brick",
          )}
          style={{ width: `${Math.min(100, Math.max(2, share * 100))}%` }}
          data-level={level}
        />
      </div>
      <p className="text-muted-foreground text-[11px]">
        {level === "ok"
          ? "Not at risk of being cut off in Gmail."
          : level === "near"
            ? "Close to the size where Gmail cuts an email off. Consider removing a little."
            : "Too big: Gmail will cut this email off. Remove some content."}
      </p>
    </div>
  );
}

/**
 * The email as it sits in an inbox before it is opened: who it is from, the subject, and the
 * start of the preview text, cut short where a wide list on a computer and a narrow one on a
 * phone would cut them. The subject and preview text can be changed here.
 */
function InboxPreview() {
  const { doc, dispatch } = useBuilder();
  const sender = BRANDS[doc.brand].name;
  const subject = doc.meta.subject || "No subject yet";
  const preview = doc.meta.previewText;
  const quiet = "text-neutral-500";
  const other = (from: string, about: string, rest: string, when: string) => (
    <div
      className="flex items-baseline gap-3 border-b px-4 py-2.5 text-sm text-neutral-500"
      aria-hidden
    >
      <span className="w-40 shrink-0 truncate">{from}</span>
      <span className="min-w-0 flex-1 truncate">
        {about} <span className="text-neutral-400">- {rest}</span>
      </span>
      <span className="shrink-0 text-xs">{when}</span>
    </div>
  );
  return (
    <div className="mx-auto w-full max-w-3xl space-y-6">
      <section className="space-y-2" aria-label="Inbox on a computer">
        <h3 className="text-xs font-bold">On a computer</h3>
        <div
          className="overflow-hidden rounded-lg border bg-white text-neutral-900 shadow-sm"
          data-inbox="desktop"
        >
          <div className="flex items-baseline gap-3 border-b px-4 py-2.5 text-sm">
            <span className="w-40 shrink-0 truncate font-bold" data-inbox-sender>
              {sender}
            </span>
            <span className="min-w-0 flex-1 truncate">
              <span className="font-bold" data-inbox-subject>
                {subject}
              </span>
              {preview && <span className={quiet}> - {preview}</span>}
            </span>
            <span className="shrink-0 text-xs font-bold">9:41</span>
          </div>
          {other(
            "A supplier",
            "Your order has shipped",
            "Thanks for your order. It is on its way and should",
            "8:15",
          )}
          {other(
            "The bank",
            "Your statement is ready",
            "Your latest statement is ready to view in online",
            "Mon",
          )}
        </div>
      </section>
      <section className="space-y-2" aria-label="Inbox on a phone">
        <h3 className="text-xs font-bold">On a phone</h3>
        <div
          className="w-[375px] max-w-full overflow-hidden rounded-2xl border bg-white text-neutral-900 shadow-sm"
          data-inbox="mobile"
        >
          <div className="flex gap-3 border-b px-4 py-3">
            <span
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-neutral-200 text-sm font-bold"
              aria-hidden
            >
              {sender[0]}
            </span>
            <span className="min-w-0 flex-1 text-sm">
              <span className="flex items-baseline justify-between gap-2">
                <span className="truncate font-bold">{sender}</span>
                <span className="shrink-0 text-xs font-bold">9:41</span>
              </span>
              <span className="block truncate font-bold">{subject}</span>
              <span className={cn("block truncate", quiet)}>
                {preview || "The first words of the email show here when there is no preview text."}
              </span>
            </span>
          </div>
          <div className="flex gap-3 px-4 py-3 text-neutral-500" aria-hidden>
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-neutral-100 text-sm">
              A
            </span>
            <span className="min-w-0 flex-1 text-sm">
              <span className="block truncate">A supplier</span>
              <span className="block truncate">Your order has shipped</span>
              <span className="block truncate text-neutral-400">
                Thanks for your order. It is on its way and should arrive
              </span>
            </span>
          </div>
        </div>
      </section>
      <section className="grid gap-4 sm:grid-cols-2" aria-label="Subject and preview text">
        <Field
          label={`Subject (${doc.meta.subject.length} characters)`}
          hint={
            doc.meta.subject.length > 60
              ? "Over 60 characters: most inboxes will cut it short."
              : "Phones show about the first 35 to 40 characters."
          }
        >
          <Input
            className="h-9"
            value={doc.meta.subject}
            maxLength={120}
            onChange={(e) => dispatch({ type: "setMeta", patch: { subject: e.target.value } })}
          />
        </Field>
        <Field
          label={`Preview text (${doc.meta.previewText.length} characters)`}
          hint="Shown after the subject. Between 40 and 100 characters fills the line without being cut far short."
        >
          <Input
            className="h-9"
            value={doc.meta.previewText}
            maxLength={160}
            onChange={(e) => dispatch({ type: "setMeta", patch: { previewText: e.target.value } })}
          />
        </Field>
      </section>
      <p className="text-muted-foreground text-[11px] leading-relaxed">
        The sender shown is the brand's name. The name readers really see is the one set in your
        email platform. Every inbox cuts these lines at a slightly different point, so keep what
        matters at the start.
      </p>
    </div>
  );
}

/** The email as it will be sent: the exported HTML in a locked frame on a computer and on a phone, how it looks in an inbox, and its links. */
export function PreviewDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { doc, select } = useBuilder();
  const [tab, setTab] = useState<Tab>("desktop");
  // It is drawn afresh each time it is opened, so it always starts on the email itself.
  const html = useMemo(() => (open ? renderDocHtml(doc) : ""), [open, doc]);
  const checks = useMemo(() => (open ? docChecks(doc) : []), [open, doc]);
  const pick = (blockId: string) => {
    onOpenChange(false);
    select({ kind: "block", id: blockId });
    // Once the dialog has gone, bring the block into view.
    setTimeout(
      () =>
        document
          .querySelector(`[data-block="${blockId}"]`)
          ?.scrollIntoView({ block: "center", behavior: "smooth" }),
      150,
    );
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[92vh] max-w-6xl flex-col gap-0 overflow-hidden p-0">
        <DialogHeader className="border-b px-5 py-3">
          <DialogTitle>Preview</DialogTitle>
          <DialogDescription>
            The email as it will arrive. This is the same HTML that Copy HTML gives you.
          </DialogDescription>
        </DialogHeader>
        <div className="flex min-h-0 flex-1">
          <div className="bg-sunken/40 flex min-w-0 flex-1 flex-col">
            <div className="bg-card flex items-center gap-3 border-b px-4 py-2">
              <div className="flex rounded-md border p-0.5" role="tablist" aria-label="Preview">
                {TABS.map(([value, label, Icon]) => (
                  <button
                    key={value}
                    type="button"
                    role="tab"
                    aria-selected={tab === value}
                    onClick={() => setTab(value)}
                    className={cn(
                      "flex h-7 items-center gap-1.5 rounded px-2.5 text-xs",
                      tab === value
                        ? "bg-teal text-on-teal"
                        : "text-muted-foreground hover:bg-sunken hover:text-foreground",
                    )}
                  >
                    <Icon className="h-4 w-4" aria-hidden />
                    {label}
                  </button>
                ))}
              </div>
            </div>
            <div className="mx-auto flex min-h-0 w-full flex-1 flex-col items-center overflow-auto p-4">
              {(tab === "desktop" || tab === "mobile") && (
                <div
                  className="bg-card flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border shadow-sm"
                  style={{ width: FRAME[tab], maxWidth: "100%" }}
                >
                  <div className="truncate border-b px-3 py-2 text-sm" data-inbox-row>
                    <span className="font-bold">{doc.meta.subject || "No subject yet"}</span>
                    <span className="text-muted-foreground ml-2">{doc.meta.previewText}</span>
                  </div>
                  <iframe
                    title="Email preview"
                    srcDoc={html}
                    sandbox=""
                    className="min-h-0 w-full flex-1 bg-white"
                  />
                </div>
              )}
              {tab === "inbox" && <InboxPreview />}
              {tab === "links" && <LinkChecker onPick={pick} />}
            </div>
          </div>
          <aside
            className="w-72 shrink-0 space-y-5 overflow-y-auto border-l p-4"
            aria-label="Email information"
          >
            <SizeMeter bytes={htmlBytes(html)} />
            <div className="space-y-1.5">
              <h3 className="text-xs font-medium">Before you send</h3>
              {checks.length === 0 ? (
                <p className="text-muted-foreground text-xs">
                  Nothing to fix. Send yourself a test before sending to customers.
                </p>
              ) : (
                <ul className="text-muted-foreground list-disc space-y-1 pl-4 text-xs">
                  {checks.map((c) => (
                    <li key={c}>{c}</li>
                  ))}
                </ul>
              )}
            </div>
            <button
              type="button"
              onClick={() => setTab("links")}
              className="text-ochre-text text-xs font-medium underline-offset-2 hover:underline"
            >
              Check the email's links
            </button>
            {doc.platform === "shopify" && (
              <p className="text-muted-foreground text-[11px] leading-relaxed">
                The words in double curly brackets at the very end are a marker for Shopify. Shopify
                swaps it, and the Unsubscribe link, for the real thing when it sends.
              </p>
            )}
          </aside>
        </div>
      </DialogContent>
    </Dialog>
  );
}
