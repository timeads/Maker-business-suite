"use client";

import Link from "next/link";
import { useActionState, useEffect, useRef, useState } from "react";
import { Bold, Heading, Italic, Link2, List, ListOrdered, Underline } from "lucide-react";
import { Button } from "@/components/ui/button";
import { FormMessage } from "@/components/ui/form-message";
import { Input, Label } from "@/components/ui/input";
import { SubmitButton } from "@/components/ui/submit-button";
import { isSafeLink, richToHtml, type RichDoc } from "@/lib/helpdesk/rich";
import { readEditor } from "@/lib/helpdesk/rich-dom";
import type { ManualState } from "./actions";

const tool =
  "text-text-2 hover:bg-hover hover:text-foreground focus-visible:ring-ochre flex size-8 items-center justify-center rounded-sm outline-none focus-visible:ring-2 [&_svg]:size-4";

const FORMATS = [
  { icon: Bold, label: "Bold", name: "bold" },
  { icon: Italic, label: "Italic", name: "italic" },
  { icon: Underline, label: "Underline", name: "underline" },
  { icon: List, label: "Bulleted list", name: "insertUnorderedList" },
  { icon: ListOrdered, label: "Numbered list", name: "insertOrderedList" },
] as const;

/**
 * The writing box for a topic or an article: the same small document a reply
 * is written in. A line that is bold from end to end is a heading; the
 * buttons under the box add the workspace's usual ones.
 */
function BodyEditor({
  initial,
  headings,
  onChange,
}: {
  initial: RichDoc;
  headings: string[];
  onChange: (doc: RichDoc) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // Our own HTML, built from the checked document.
    if (box.current) box.current.innerHTML = richToHtml(initial);
    // Filled once: after that the box is the person's.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const changed = () => {
    if (box.current) onChange(readEditor(box.current));
  };
  const command = (name: string) => {
    box.current?.focus();
    document.execCommand(name, false);
    changed();
  };
  /** Turns the selected words into a link. Only a web address we would accept is used. */
  const addLink = () => {
    const selection = window.getSelection();
    if (!box.current || !selection || selection.isCollapsed) {
      window.alert("Select the words the link should sit on first.");
      return;
    }
    const typed = window.prompt(
      "Where should it go? (an address starting with https://)",
      "https://",
    );
    const href = (typed ?? "").trim();
    if (!href || href === "https://") return;
    if (!/^https:\/\//i.test(href) || !isSafeLink(href)) {
      window.alert("That doesn't look like a web address starting with https://.");
      return;
    }
    box.current.focus();
    document.execCommand("createLink", false, href);
    changed();
  };
  const addHeading = (heading: string) => {
    const root = box.current;
    if (!root) return;
    const title = document.createElement("p");
    const strong = document.createElement("strong");
    strong.textContent = heading;
    title.append(strong);
    const list = document.createElement("ul");
    const item = document.createElement("li");
    item.append(document.createElement("br"));
    list.append(item);
    root.append(title, list);
    const range = document.createRange();
    range.selectNodeContents(item);
    range.collapse(true);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    root.focus();
    changed();
  };
  return (
    <div className="border-input bg-card focus-within:border-ochre focus-within:ring-ochre/25 rounded-sm border focus-within:ring-2">
      <div className="border-border flex flex-wrap items-center gap-0.5 border-b px-1.5 py-1">
        {FORMATS.map((format) => (
          <button
            key={format.name}
            type="button"
            title={format.label}
            aria-label={format.label}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => command(format.name)}
            className={tool}
          >
            <format.icon aria-hidden />
          </button>
        ))}
        <button
          type="button"
          title="Link"
          aria-label="Link"
          onMouseDown={(event) => event.preventDefault()}
          onClick={addLink}
          className={tool}
        >
          <Link2 aria-hidden />
        </button>
        <span className="text-muted-foreground ml-2 hidden text-xs sm:inline">
          A line that is all bold is a heading.
        </span>
      </div>
      <div
        ref={box}
        role="textbox"
        aria-multiline="true"
        aria-label="What it says"
        contentEditable
        suppressContentEditableWarning
        onInput={changed}
        onPaste={(event) => {
          // A paste comes in as plain words: nothing from another page's markup gets in.
          event.preventDefault();
          document.execCommand("insertText", false, event.clipboardData.getData("text/plain"));
        }}
        className="rich font-read [&_a]:text-ochre-text min-h-[280px] px-3 py-3 text-[15px] leading-relaxed break-words outline-none [&_a]:underline [&_ol]:mb-3 [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:mb-2 [&_ul]:mb-3 [&_ul]:list-disc [&_ul]:pl-5"
      />
      {headings.length > 0 && (
        <div className="border-border flex flex-wrap items-center gap-1.5 border-t px-2 py-2">
          <span className="text-muted-foreground flex items-center gap-1 text-xs">
            <Heading aria-hidden className="size-3.5" />
            Add a heading:
          </span>
          {headings.map((heading) => (
            <button
              key={heading}
              type="button"
              onClick={() => addHeading(heading)}
              className="border-border hover:bg-hover rounded-full border px-2.5 py-0.5 text-xs font-semibold"
            >
              {heading}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function EntryForm({
  action,
  kind,
  initial,
  facets = [],
  headings = [],
  cancelHref,
  canEdit,
}: {
  action: (prev: ManualState, formData: FormData) => Promise<ManualState>;
  kind: "topic" | "article";
  initial: {
    title: string;
    summary?: string;
    body: RichDoc;
    /** Per facet id, its values joined with commas. */
    facets?: Record<string, string>;
    tags?: string;
    shareable?: boolean;
  };
  facets?: { id: string; label: string }[];
  headings?: string[];
  cancelHref: string;
  canEdit: boolean;
}) {
  const [state, formAction] = useActionState(action, {});
  const [body, setBody] = useState<RichDoc>(initial.body);
  return (
    <form action={formAction} className="flex max-w-3xl flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="entry-title">Title</Label>
        <Input
          id="entry-title"
          name="title"
          required
          maxLength={160}
          defaultValue={initial.title}
          placeholder={
            kind === "topic" ? "What it is about, in a few words" : "What the article is called"
          }
        />
      </div>
      {kind === "topic" && (
        <>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="entry-summary">In a sentence or two</Label>
            <Input
              id="entry-summary"
              name="summary"
              maxLength={500}
              defaultValue={initial.summary ?? ""}
              placeholder="Shown in the list of topics"
            />
          </div>
          {facets.length > 0 && (
            <div className="grid gap-3 sm:grid-cols-2">
              {facets.map((facet) => (
                <div key={facet.id} className="flex flex-col gap-1.5">
                  <Label htmlFor={`facet-${facet.id}`}>{facet.label}</Label>
                  <Input
                    id={`facet-${facet.id}`}
                    name={`facet_${facet.id}`}
                    defaultValue={initial.facets?.[facet.id] ?? ""}
                    placeholder="One or more, with commas between"
                  />
                </div>
              ))}
            </div>
          )}
        </>
      )}
      <div className="flex flex-col gap-1.5">
        <Label>What it says</Label>
        <BodyEditor initial={initial.body} headings={headings} onChange={setBody} />
        <input type="hidden" name="body" value={JSON.stringify(body)} />
      </div>
      {kind === "article" && (
        <>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="entry-tags">Tags</Label>
            <Input
              id="entry-tags"
              name="tags"
              defaultValue={initial.tags ?? ""}
              placeholder="care, returns, sizing"
            />
          </div>
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              name="shareable"
              value="1"
              defaultChecked={initial.shareable ?? false}
              className="mt-0.5"
            />
            <span>
              Fine to paste to a customer
              <span className="text-muted-foreground block text-xs">
                Only a mark for the team. Nothing here is shown to customers by itself.
              </span>
            </span>
          </label>
        </>
      )}
      {state.error && <FormMessage>{state.error}</FormMessage>}
      <div className="flex flex-wrap items-center gap-2">
        {canEdit ? (
          <SubmitButton pendingText="Saving…">Save</SubmitButton>
        ) : (
          <p className="text-muted-foreground text-sm">
            This workspace is read-only just now, so changes can&apos;t be saved.
          </p>
        )}
        <Button asChild variant="ghost">
          <Link href={cancelHref}>Cancel</Link>
        </Button>
      </div>
    </form>
  );
}

/** A button that runs an action and says how it went, for "Update now" and "Add to the manual". */
export function AskButton({
  action,
  label,
  pendingLabel,
  variant = "outline",
  size,
}: {
  action: (prev: ManualState) => Promise<ManualState>;
  label: string;
  pendingLabel: string;
  variant?: "outline" | "default" | "ghost";
  size?: "sm";
}) {
  const [state, formAction] = useActionState(action, {});
  return (
    <form action={formAction} className="flex flex-col gap-2">
      <div>
        <SubmitButton variant={variant} size={size} pendingText={pendingLabel}>
          {label}
        </SubmitButton>
      </div>
      {state.error && <FormMessage>{state.error}</FormMessage>}
      {state.message && <FormMessage kind="success">{state.message}</FormMessage>}
    </form>
  );
}
