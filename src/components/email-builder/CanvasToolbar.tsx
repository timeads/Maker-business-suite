"use client";

import { useRef, useState } from "react";
import {
  Bold,
  ChevronDown,
  Eye,
  Italic,
  Link2,
  Monitor,
  Redo2,
  Smartphone,
  Underline,
  Undo2,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "./ui";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "./ui";
import {
  alignOf,
  findBlock,
  safeHref,
  unsubscribeHref,
  type HeadingBlock,
  type ParagraphBlock,
} from "@/lib/design";
import { cn } from "@/lib/utils";
import { useBuilder, type Device } from "./context";
import { ALIGN_OPTIONS, inlineBox } from "./shared";

const tool =
  "flex h-8 w-8 items-center justify-center rounded text-foreground hover:bg-sunken disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ochre";

/** The words selected inside a text block, or the whole block when none of it is selected. */
function rangeIn(el: HTMLElement): Range {
  const selection = window.getSelection();
  if (
    selection &&
    selection.rangeCount > 0 &&
    !selection.isCollapsed &&
    el.contains(selection.anchorNode) &&
    el.contains(selection.focusNode)
  )
    return selection.getRangeAt(0).cloneRange();
  const all = document.createRange();
  all.selectNodeContents(el);
  return all;
}

/** Run one of the browser's own formatting commands on a text block, then have the block take up the result. */
function format(id: string, range: Range | null, command: string, value?: string) {
  const el = inlineBox(id);
  if (!el) return;
  el.focus();
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range ?? rangeIn(el));
  document.execCommand(command, false, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

/** Put a piece of HTML into a text block where the cursor is, or at its end when the cursor is elsewhere. The block cleans what it takes. */
function insertInto(id: string, at: Range | null, html: string) {
  const el = inlineBox(id);
  if (!el) return;
  el.focus();
  const selection = window.getSelection();
  const range = at && el.contains(at.startContainer) ? at : document.createRange();
  if (range !== at) {
    range.selectNodeContents(el);
    range.collapse(false);
  }
  selection?.removeAllRanges();
  selection?.addRange(range);
  document.execCommand("insertHTML", false, html);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

/** Bold, italic, underline, link and alignment for the selected heading or paragraph. */
function TextTools({ block }: { block: HeadingBlock | ParagraphBlock }) {
  const { doc, dispatch } = useBuilder();
  const [linking, setLinking] = useState(false);
  const [url, setUrl] = useState("");
  // The words that were selected when the link box opened; typing in the box takes the selection away.
  const range = useRef<Range | null>(null);
  const caret = useRef<Range | null>(null);
  // Pressing a button must not take the cursor out of the text, or there would be nothing to format.
  const hold = (e: React.MouseEvent) => e.preventDefault();
  const marks: [string, string, React.ReactNode][] = [
    ["bold", "Bold", <Bold key="b" className="h-4 w-4" />],
    ["italic", "Italic", <Italic key="i" className="h-4 w-4" />],
    ["underline", "Underline", <Underline key="u" className="h-4 w-4" />],
  ];
  const href = safeHref(url);

  const openLink = (open: boolean) => {
    if (open) {
      const el = inlineBox(block.id);
      range.current = el ? rangeIn(el) : null;
      const node = range.current?.startContainer;
      const link = (node instanceof Element ? node : node?.parentElement)?.closest("a");
      setUrl(link?.getAttribute("href") ?? "");
    }
    setLinking(open);
  };

  return (
    <div className="flex items-center gap-0.5" role="toolbar" aria-label="Text formatting">
      {marks.map(([command, label, icon]) => (
        <button
          key={command}
          type="button"
          className={tool}
          aria-label={label}
          title={label}
          onMouseDown={hold}
          onClick={() => format(block.id, null, command)}
        >
          {icon}
        </button>
      ))}
      <Popover open={linking} onOpenChange={openLink}>
        <PopoverTrigger asChild>
          <button type="button" className={tool} aria-label="Link" title="Link" onMouseDown={hold}>
            <Link2 className="h-4 w-4" />
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-80 space-y-2">
          <label className="block space-y-1">
            <span className="block text-xs font-medium">Link address</span>
            <Input
              autoFocus
              className="h-9"
              value={url}
              placeholder="https://example.com"
              inputMode="url"
              onChange={(e) => setUrl(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && href) {
                  format(block.id, range.current, "createLink", href);
                  setLinking(false);
                }
              }}
            />
          </label>
          <p className="text-muted-foreground text-[11px]">
            {url && !href
              ? "Links must start with https:// (or mailto: for an email address)."
              : "The link goes on the words you selected, or on the whole block if none were."}
          </p>
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                format(block.id, range.current, "unlink");
                setLinking(false);
              }}
            >
              Remove link
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={!href}
              onClick={() => {
                format(block.id, range.current, "createLink", href);
                setLinking(false);
              }}
            >
              Add link
            </Button>
          </div>
        </PopoverContent>
      </Popover>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          {/* Where the cursor was is remembered as the menu opens, since the menu takes the cursor while it is up. */}
          <button
            type="button"
            className={cn(tool, "w-auto gap-0.5 px-2 text-xs")}
            aria-label="Insert"
            title="Insert"
            onPointerDown={() => {
              const s = window.getSelection();
              caret.current = s && s.rangeCount > 0 ? s.getRangeAt(0).cloneRange() : null;
            }}
          >
            Insert
            <ChevronDown className="h-3 w-3" aria-hidden />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          className="w-64"
          onCloseAutoFocus={(e) => e.preventDefault()}
        >
          <DropdownMenuLabel className="text-muted-foreground text-xs font-normal">
            Filled in by {doc.platform === "shopify" ? "Shopify" : "your email platform"} when it
            sends
          </DropdownMenuLabel>
          <DropdownMenuItem
            onSelect={() =>
              insertInto(
                block.id,
                caret.current,
                `<a href="${unsubscribeHref(doc.platform)}">Unsubscribe</a>`,
              )
            }
          >
            Unsubscribe link
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <span className="bg-border mx-1 h-5 w-px" aria-hidden />
      {ALIGN_OPTIONS.map((o) => (
        <button
          key={o.value}
          type="button"
          className={cn(tool, alignOf(doc, block) === o.value && "bg-sunken")}
          aria-label={`Align ${o.label.toLowerCase()}`}
          title={`Align ${o.label.toLowerCase()}`}
          aria-pressed={alignOf(doc, block) === o.value}
          onMouseDown={hold}
          onClick={() =>
            dispatch({ type: "updateBlockStyles", id: block.id, patch: { align: o.value } })
          }
        >
          <o.Icon className="h-4 w-4" />
        </button>
      ))}
    </div>
  );
}

/** The strip above the canvas: text formatting when a text block is selected, the computer and phone views, undo, redo and preview. */
export function CanvasToolbar({
  onDevice,
  onUndo,
  onRedo,
  canUndo,
  canRedo,
  onPreview,
}: {
  onDevice: (device: Device) => void;
  onUndo: () => void;
  onRedo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  onPreview: () => void;
}) {
  const { doc, selection, device } = useBuilder();
  const block = selection?.kind === "block" ? findBlock(doc, selection.id)?.block : null;
  const devices: [Device, string, React.ReactNode][] = [
    ["desktop", "Desktop", <Monitor key="d" className="h-4 w-4" />],
    ["mobile", "Mobile", <Smartphone key="m" className="h-4 w-4" />],
  ];
  return (
    <div className="bg-card grid h-10 shrink-0 grid-cols-[1fr_auto_1fr] items-center gap-2 border-b px-2">
      <div className="min-w-0">
        {block && (block.type === "heading" || block.type === "paragraph") && (
          <TextTools key={block.id} block={block} />
        )}
      </div>
      <div className="flex rounded-md border p-0.5" role="radiogroup" aria-label="View">
        {devices.map(([value, label, icon]) => (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={device === value}
            onClick={() => onDevice(value)}
            className={cn(
              "flex h-7 items-center gap-1.5 rounded px-2.5 text-xs",
              device === value
                ? "bg-teal text-on-teal"
                : "text-muted-foreground hover:bg-sunken hover:text-foreground",
            )}
          >
            {icon}
            {label}
          </button>
        ))}
      </div>
      <div className="flex items-center justify-end gap-0.5">
        <button
          type="button"
          className={tool}
          aria-label="Undo"
          title="Undo (Ctrl+Z)"
          disabled={!canUndo}
          onClick={onUndo}
        >
          <Undo2 className="h-4 w-4" />
        </button>
        <button
          type="button"
          className={tool}
          aria-label="Redo"
          title="Redo (Ctrl+Shift+Z)"
          disabled={!canRedo}
          onClick={onRedo}
        >
          <Redo2 className="h-4 w-4" />
        </button>
        <Button type="button" variant="outline" size="sm" className="ml-2 h-8" onClick={onPreview}>
          <Eye className="mr-1.5 h-4 w-4" /> Preview
        </Button>
      </div>
    </div>
  );
}
