"use client";

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  Bold,
  ChevronDown,
  Eraser,
  Forward,
  Italic,
  Link2,
  List,
  ListOrdered,
  Paperclip,
  Reply,
  ReplyAll,
  Send,
  Sparkles,
  StickyNote,
  Strikethrough,
  Trash2,
  Underline,
  X,
  Zap,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { draftKey, readDraft, type ComposerMode } from "@/lib/helpdesk/drafts";
import { fileSize, filesProblem, parseRecipients } from "@/lib/helpdesk/outbound";
import {
  isSafeLink,
  richToHtml,
  richToText,
  textToRich,
  tidyDoc,
  type RichBlock,
  type RichDoc,
  type RichRun,
} from "@/lib/helpdesk/rich";
import { cn } from "@/lib/utils";
import { addTicketNote, draftTicketReply, sendMail } from "./actions";

type Template = { id: string; name: string; body: string };
type Snooze = { key: string; label: string; until: string };

/** Events other parts of the desk send to the composer. */
export const INSERT_EVENT = "helpdesk:insert";
export const FOCUS_EVENT = "helpdesk:focus";

// ---- The editor's contents as a small document ------------------------------

type Marks = Omit<RichRun, "text">;
const BLOCKS = new Set(["P", "DIV", "UL", "OL", "LI", "BLOCKQUOTE", "H1", "H2", "H3", "PRE"]);

/** Reads what is typed into a document of our own kind; tags we don't know are just their text. */
export function readEditor(root: HTMLElement): RichDoc {
  const doc: RichDoc = [];
  let open: RichRun[] | null = null;
  const para = () => {
    if (!open) {
      open = [];
      doc.push({ t: "p", runs: open });
    }
    return open;
  };
  const inline = (node: Node, marks: Marks, into: () => RichRun[]) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = (node.textContent ?? "").replace(/ /g, " ");
      if (text) into().push({ text, ...marks });
      return;
    }
    if (!(node instanceof HTMLElement)) return;
    const tag = node.tagName;
    if (tag === "BR") {
      into().push({ text: "\n", ...marks });
      return;
    }
    const next: Marks = { ...marks };
    if (tag === "B" || tag === "STRONG") next.b = true;
    if (tag === "I" || tag === "EM") next.i = true;
    if (tag === "U") next.u = true;
    if (tag === "S" || tag === "STRIKE" || tag === "DEL") next.s = true;
    if (tag === "A") {
      const href = node.getAttribute("href") ?? "";
      if (isSafeLink(href)) next.href = href.trim();
    }
    for (const child of node.childNodes) walk(child, next, into);
  };
  const walk = (node: Node, marks: Marks, into: () => RichRun[]) => {
    if (node instanceof HTMLElement && (node.tagName === "UL" || node.tagName === "OL")) {
      const items: RichRun[][] = [];
      for (const li of node.children) {
        const item: RichRun[] = [];
        for (const child of li.childNodes) inline(child, marks, () => item);
        items.push(item);
      }
      const block: RichBlock = { t: node.tagName === "UL" ? "ul" : "ol", items };
      doc.push(block);
      open = null;
      return;
    }
    if (node instanceof HTMLElement && BLOCKS.has(node.tagName)) {
      open = null;
      for (const child of node.childNodes) walk(child, marks, into);
      open = null;
      return;
    }
    inline(node, marks, into);
  };
  for (const child of root.childNodes) walk(child, {}, para);
  // A line break that only ends a paragraph isn't part of its words.
  for (const block of doc) {
    if (block.t === "p") {
      const last = block.runs[block.runs.length - 1];
      if (last && last.text === "\n") block.runs.pop();
    }
  }
  return tidyDoc(doc);
}

/** Puts a document into the editor. The HTML is ours, built from the checked document. */
function fillEditor(root: HTMLElement, doc: RichDoc) {
  root.innerHTML = richToHtml(doc);
}

const TABS: { key: ComposerMode; label: string; icon: typeof Reply }[] = [
  { key: "reply", label: "Reply", icon: Reply },
  { key: "reply_all", label: "Reply all", icon: ReplyAll },
  { key: "forward", label: "Forward", icon: Forward },
  { key: "note", label: "Internal note", icon: StickyNote },
];

const FORMATS = [
  { icon: Bold, label: "Bold", name: "bold" },
  { icon: Italic, label: "Italic", name: "italic" },
  { icon: Underline, label: "Underline", name: "underline" },
  { icon: Strikethrough, label: "Strikethrough", name: "strikeThrough" },
  null,
  { icon: List, label: "Bulleted list", name: "insertUnorderedList" },
  { icon: ListOrdered, label: "Numbered list", name: "insertOrderedList" },
  { icon: Link2, label: "Link", name: "link" },
  { icon: Eraser, label: "Clear formatting", name: "removeFormat" },
] as const;

const tool =
  "text-text-2 hover:bg-hover hover:text-foreground focus-visible:ring-ochre flex size-7 items-center justify-center rounded-sm outline-none focus-visible:ring-2 [&_svg]:size-3.5";
const quiet =
  "text-text-2 hover:bg-hover hover:text-foreground focus-visible:ring-ochre flex h-8 items-center gap-1.5 rounded-sm px-2 text-[13px] font-semibold outline-none focus-visible:ring-2 [&_svg]:size-3.5";
const pop =
  "bg-card border-border absolute bottom-full z-30 mb-1.5 rounded-md border p-1.5 shadow-lg";
const field =
  "border-input bg-card focus-visible:border-ochre focus-visible:ring-ochre/25 h-8 w-full rounded-sm border px-2 text-sm outline-none focus-visible:ring-2";

/**
 * The reply box: an email to the customer, the same with copies, a forward,
 * or a note only the team sees. What is typed is kept in this browser until
 * it is sent or thrown away. Nothing here sends by itself: Claude's draft and
 * a saved reply only fill the box.
 */
export function Composer({
  slug,
  ticketId,
  customerEmail,
  customerFirstName,
  templates,
  snoozeChoices,
  canDraft,
  canSend,
  afterHref,
}: {
  slug: string;
  ticketId: string;
  customerEmail: string;
  customerFirstName: string | null;
  templates: Template[];
  snoozeChoices: Snooze[];
  canDraft: boolean;
  canSend: boolean;
  /** Where to go once a conversation is sent and closed or snoozed: the next one, or the list. */
  afterHref: string;
}) {
  const router = useRouter();
  const editor = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [mode, setModeState] = useState<ComposerMode>("reply");
  const [to, setTo] = useState(customerEmail);
  const [cc, setCc] = useState("");
  const [bcc, setBcc] = useState("");
  const [editing, setEditing] = useState(false);
  const [files, setFiles] = useState<File[]>([]);
  const [menu, setMenu] = useState<"macros" | "ai" | "send" | null>(null);
  const [macroSearch, setMacroSearch] = useState("");
  const [hint, setHint] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, start] = useTransition();
  const key = draftKey(ticketId);
  const state = useRef({ mode, to, cc });
  useEffect(() => {
    state.current = { mode, to, cc };
  }, [mode, to, cc]);

  const save = useCallback(() => {
    const root = editor.current;
    if (!root) return;
    try {
      const doc = readEditor(root);
      const { mode: m, to: t, cc: c } = state.current;
      if (doc.length === 0) localStorage.removeItem(key);
      else {
        localStorage.setItem(
          key,
          JSON.stringify({ mode: m, doc, to: m === "forward" ? t : undefined, cc: c || undefined }),
        );
      }
    } catch {
      // A browser that refuses storage simply doesn't keep drafts.
    }
  }, [key]);

  // Bring back what was being written on this conversation, in this browser.
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      let saved = null;
      try {
        saved = readDraft(localStorage.getItem(key));
      } catch {
        saved = null;
      }
      if (!saved || !editor.current) return;
      fillEditor(editor.current, saved.doc);
      setModeState(saved.mode);
      if (saved.mode === "forward") setTo(saved.to ?? "");
      if (saved.cc) setCc(saved.cc);
      setNotice("Your unsent draft is back.");
    });
    return () => cancelAnimationFrame(frame);
  }, [key]);

  const setMode = useCallback(
    (next: ComposerMode, focus = true) => {
      setModeState(next);
      setProblem(null);
      setNotice(null);
      setMenu(null);
      if (next === "forward") {
        setTo("");
        setEditing(true);
      } else if (next !== "note") {
        setTo(customerEmail);
        setEditing(next === "reply_all");
      }
      state.current = { ...state.current, mode: next };
      save();
      if (focus) requestAnimationFrame(() => editor.current?.focus());
    },
    [customerEmail, save],
  );

  // A saved reply, an order's summary or anything else dropped in goes under what is already there.
  const insert = useCallback(
    (text: string) => {
      const root = editor.current;
      if (!root) return;
      fillEditor(root, [...readEditor(root), ...textToRich(text)]);
      root.focus();
      const range = document.createRange();
      range.selectNodeContents(root);
      range.collapse(false);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      root.scrollTop = root.scrollHeight;
      save();
    },
    [save],
  );

  // The little menus close on Escape and on a press anywhere else.
  useEffect(() => {
    if (!menu) return;
    const onDown = (event: MouseEvent) => {
      if (!(event.target as HTMLElement | null)?.closest?.("[data-pop]")) setMenu(null);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenu(null);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [menu]);

  useEffect(() => {
    const onInsert = (event: Event) => {
      const text = (event as CustomEvent<string>).detail;
      if (state.current.mode === "note") setMode("reply", false);
      if (typeof text === "string") insert(text);
    };
    const onFocus = (event: Event) => {
      const next = (event as CustomEvent<ComposerMode>).detail;
      setMode(TABS.some((tab) => tab.key === next) ? next : "reply");
    };
    window.addEventListener(INSERT_EVENT, onInsert);
    window.addEventListener(FOCUS_EVENT, onFocus);
    return () => {
      window.removeEventListener(INSERT_EVENT, onInsert);
      window.removeEventListener(FOCUS_EVENT, onFocus);
    };
  }, [insert, setMode]);

  const command = (name: string, value?: string) => {
    editor.current?.focus();
    document.execCommand(name, false, value);
    save();
  };
  const link = () => {
    const url = window.prompt("Link address (https://…)")?.trim();
    if (!url) return;
    if (!isSafeLink(url)) {
      setProblem("A link has to start with https://, http:// or mailto:.");
      return;
    }
    command("createLink", url);
  };

  const clear = () => {
    if (editor.current) editor.current.innerHTML = "";
    setFiles([]);
    setHint("");
    try {
      localStorage.removeItem(key);
    } catch {
      // Nothing was kept.
    }
  };
  const discard = () => {
    clear();
    setProblem(null);
    setNotice(null);
    setCc("");
    setBcc("");
    setMode("reply");
  };

  const send = (then: "pending" | "open" | "closed" | "snoozed", until?: string) => {
    const root = editor.current;
    if (!root || busy) return;
    setMenu(null);
    setNotice(null);
    const doc = readEditor(root);
    if (mode !== "forward" && !richToText(doc)) {
      setProblem("Write a reply first.");
      root.focus();
      return;
    }
    const people = parseRecipients(to);
    if (people.ok.length === 0 || people.bad.length > 0) {
      setProblem(
        people.bad[0] ? `“${people.bad[0]}” isn't an email address.` : "Add who to send it to.",
      );
      setEditing(true);
      return;
    }
    const data = new FormData();
    data.set("mode", mode);
    data.set("doc", JSON.stringify(doc));
    data.set("to", to);
    data.set("cc", cc);
    data.set("bcc", bcc);
    data.set("then", mode === "forward" && then === "pending" ? "keep" : then);
    if (until) data.set("snooze_until", until);
    for (const file of files) data.append("files", file);
    setProblem(null);
    start(async () => {
      const result = await sendMail(slug, ticketId, data);
      if (result.error) {
        setProblem(`${result.error} Your draft is saved.`);
        return;
      }
      clear();
      setCc("");
      setBcc("");
      setEditing(false);
      setModeState("reply");
      setTo(customerEmail);
      if (then === "closed" || then === "snoozed") router.push(afterHref);
      else {
        setNotice(mode === "forward" ? "Forwarded." : "Sent.");
        router.refresh();
      }
    });
  };

  const addNote = () => {
    const root = editor.current;
    if (!root || busy) return;
    const text = richToText(readEditor(root));
    if (!text) {
      setProblem("Write a note first.");
      return;
    }
    const data = new FormData();
    data.set("body", text);
    setProblem(null);
    start(async () => {
      const result = await addTicketNote(slug, ticketId, {}, data);
      if (result.error) {
        setProblem(result.error);
        return;
      }
      clear();
      setNotice("Note added.");
      router.refresh();
    });
  };

  const askClaude = () => {
    setMenu(null);
    const data = new FormData();
    data.set("hint", hint);
    setProblem(null);
    start(async () => {
      const result = await draftTicketReply(slug, ticketId, {}, data);
      if (result.error || !result.draft) {
        setProblem(result.error ?? "No draft came back. You can write it yourself.");
        return;
      }
      if (editor.current) fillEditor(editor.current, textToRich(result.draft));
      save();
      setNotice(
        "Claude's draft is in the box. Read it and change what you like; nothing is sent until you press send.",
      );
      editor.current?.focus();
    });
  };

  const pickFiles = (picked: FileList | null) => {
    const next = [...files, ...Array.from(picked ?? [])];
    const wrong = filesProblem(next.map((file) => ({ name: file.name, size: file.size })));
    if (wrong) setProblem(wrong);
    else {
      setProblem(null);
      setFiles(next);
    }
    if (fileInput.current) fileInput.current.value = "";
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      if (mode === "note") addNote();
      else send(event.shiftKey ? "closed" : "pending");
    }
  };

  const note = mode === "note";
  const people = {
    to: parseRecipients(to).ok,
    cc: parseRecipients(cc).ok,
    bcc: parseRecipients(bcc).ok,
  };
  const shownMacros = templates.filter((template) =>
    `${template.name} ${template.body}`.toLowerCase().includes(macroSearch.trim().toLowerCase()),
  );
  const placeholder = note
    ? "Only your team sees notes. Type @ and a first name to get someone's attention…"
    : mode === "forward"
      ? "Add a message (optional)…"
      : `Reply to ${customerFirstName ?? customerEmail}…`;

  return (
    <div
      className={cn(
        "border-border relative rounded-lg border shadow-sm",
        note ? "bg-note border-note-border" : "bg-card",
        busy && "opacity-70",
      )}
      onKeyDown={onKeyDown}
    >
      <div className="flex flex-wrap items-center gap-x-1 gap-y-1 px-2 pt-2">
        <div role="tablist" aria-label="What to write" className="flex flex-wrap gap-0.5">
          {TABS.map((tab) => (
            <button
              key={tab.key}
              type="button"
              role="tab"
              aria-selected={mode === tab.key}
              title={tab.label}
              onClick={() => setMode(tab.key)}
              className={cn(quiet, mode === tab.key && "bg-sunken text-foreground")}
            >
              <tab.icon aria-hidden />
              {/* Where the column is narrow, only the tab you are on spells its name out. */}
              <span className={cn(mode !== tab.key && "max-2xl:sr-only")}>{tab.label}</span>
            </button>
          ))}
        </div>
        <p className="text-muted-foreground ml-auto min-w-0 truncate px-1 text-xs">
          {note ? (
            "Only your team sees notes"
          ) : (
            <>
              {people.to.length > 0
                ? `To ${people.to.join(", ")}`
                : mode === "forward"
                  ? "Add who to forward to"
                  : "To —"}
              {people.cc.length > 0 && ` · Cc ${people.cc.length}`}
              {people.bcc.length > 0 && ` · Bcc ${people.bcc.length}`}{" "}
              <button
                type="button"
                onClick={() => setEditing((was) => !was)}
                aria-expanded={editing}
                className="text-ochre-text font-semibold hover:underline"
              >
                Edit
              </button>
            </>
          )}
        </p>
      </div>

      {editing && !note && (
        <div className="grid grid-cols-[2.5rem_1fr] items-center gap-x-2 gap-y-1 px-3 pt-2 text-xs">
          {(
            [
              ["To", to, setTo],
              ["Cc", cc, setCc],
              ["Bcc", bcc, setBcc],
            ] as const
          ).map(([label, value, set]) => (
            <label key={label} className="contents">
              <span className="text-muted-foreground font-semibold">{label}</span>
              <input
                value={value}
                onChange={(event) => {
                  set(event.target.value);
                  state.current = { ...state.current, [label.toLowerCase()]: event.target.value };
                }}
                onBlur={save}
                inputMode="email"
                autoComplete="off"
                placeholder={label === "To" ? "name@example.com" : "Optional"}
                className={field}
              />
            </label>
          ))}
        </div>
      )}

      <div role="toolbar" aria-label="Formatting" className="flex items-center gap-0.5 px-2 pt-1.5">
        {FORMATS.map((entry, i) =>
          entry === null ? (
            <span key={i} aria-hidden className="bg-border mx-1 h-4 w-px" />
          ) : (
            <button
              key={entry.label}
              type="button"
              title={entry.label}
              aria-label={entry.label}
              disabled={note}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => (entry.name === "link" ? link() : command(entry.name))}
              className={cn(tool, note && "opacity-40")}
            >
              <entry.icon aria-hidden />
            </button>
          ),
        )}
      </div>

      <div
        ref={editor}
        id="composer"
        role="textbox"
        aria-multiline="true"
        aria-label={placeholder}
        data-placeholder={placeholder}
        contentEditable
        suppressContentEditableWarning
        onInput={save}
        onPaste={(event) => {
          // A paste comes in as plain words: nothing from another page's markup gets in.
          event.preventDefault();
          document.execCommand("insertText", false, event.clipboardData.getData("text/plain"));
        }}
        className="composer-box font-read max-h-[34vh] min-h-[56px] overflow-y-auto px-3 py-2 text-sm break-words outline-none lg:min-h-[92px]"
      />

      {files.length > 0 && (
        <ul className="flex flex-wrap gap-1.5 px-3 pb-1">
          {files.map((file, i) => (
            <li
              key={`${file.name}-${i}`}
              className="border-border bg-panel flex items-center gap-1.5 rounded-sm border px-2 py-1 text-xs"
            >
              <Paperclip aria-hidden className="text-muted-foreground size-3" />
              <span className="max-w-[16ch] truncate font-semibold">{file.name}</span>
              <span className="text-muted-foreground">{fileSize(file.size)}</span>
              <button
                type="button"
                aria-label={`Remove ${file.name}`}
                onClick={() => setFiles(files.filter((_, at) => at !== i))}
                className="text-muted-foreground hover:text-foreground"
              >
                <X aria-hidden className="size-3" />
              </button>
            </li>
          ))}
        </ul>
      )}
      {(problem || notice) && (
        <p
          role={problem ? "alert" : "status"}
          className={cn("px-3 pb-1 text-xs", problem ? "text-brick" : "text-muted-foreground")}
        >
          {problem ?? notice}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-x-0.5 gap-y-1.5 px-2 pb-2">
        {!note && (
          <>
            <div className="relative" data-pop>
              <button
                type="button"
                onClick={() => setMenu(menu === "macros" ? null : "macros")}
                aria-expanded={menu === "macros"}
                className={quiet}
              >
                <Zap aria-hidden />
                Macros
              </button>
              {menu === "macros" && (
                <div className={cn(pop, "left-0 w-[min(20rem,80vw)]")}>
                  <input
                    autoFocus
                    value={macroSearch}
                    onChange={(event) => setMacroSearch(event.target.value)}
                    placeholder="Find a saved reply"
                    aria-label="Find a saved reply"
                    className={field}
                  />
                  <ul className="mt-1 max-h-56 overflow-y-auto">
                    {shownMacros.length === 0 && (
                      <li className="text-muted-foreground px-2 py-2 text-xs">
                        No saved reply by that name. They are made in Settings → Help desk.
                      </li>
                    )}
                    {shownMacros.map((template) => (
                      <li key={template.id}>
                        <button
                          type="button"
                          onClick={() => {
                            setMenu(null);
                            setMacroSearch("");
                            insert(template.body);
                          }}
                          className="hover:bg-hover w-full rounded-sm px-2 py-1.5 text-left"
                        >
                          <span className="block text-sm font-semibold">{template.name}</span>
                          <span className="text-muted-foreground font-read line-clamp-1 text-xs">
                            {template.body}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
            <button type="button" onClick={() => fileInput.current?.click()} className={quiet}>
              <Paperclip aria-hidden />
              Attach
            </button>
            <input
              ref={fileInput}
              type="file"
              multiple
              hidden
              onChange={(event) => pickFiles(event.target.files)}
            />
            {canDraft && mode !== "forward" && (
              <div className="relative" data-pop>
                <button
                  type="button"
                  onClick={() => setMenu(menu === "ai" ? null : "ai")}
                  aria-expanded={menu === "ai"}
                  className={quiet}
                >
                  <Sparkles aria-hidden />
                  AI
                </button>
                {menu === "ai" && (
                  <div className={cn(pop, "left-0 flex w-[min(20rem,80vw)] flex-col gap-1.5")}>
                    <label className="text-muted-foreground text-xs" htmlFor="ai-hint">
                      Claude writes a draft into the box for you to edit. Say what it should say, or
                      leave this empty.
                    </label>
                    <input
                      id="ai-hint"
                      autoFocus
                      value={hint}
                      maxLength={300}
                      onChange={(event) => setHint(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" && !event.metaKey && !event.ctrlKey) {
                          event.preventDefault();
                          askClaude();
                        }
                      }}
                      placeholder="e.g. offer a replacement part"
                      className={field}
                    />
                    <Button
                      type="button"
                      variant="dark"
                      size="sm"
                      onClick={askClaude}
                      className="w-fit"
                    >
                      Write draft
                    </Button>
                  </div>
                )}
              </div>
            )}
          </>
        )}
        <span className="ml-auto flex flex-wrap items-center justify-end gap-1.5">
          <button
            type="button"
            onClick={discard}
            title="Discard draft"
            aria-label="Discard draft"
            className={tool}
          >
            <Trash2 aria-hidden />
          </button>
          {note ? (
            <Button type="button" variant="dark" onClick={addNote} disabled={busy}>
              {busy ? "Saving…" : "Add note"}
            </Button>
          ) : (
            <>
              <span className="relative flex" data-pop>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => send("pending")}
                  disabled={busy || !canSend}
                  title={
                    mode === "forward" ? "Forward" : "Send and mark in progress (Ctrl/⌘ + Enter)"
                  }
                  className="rounded-r-none"
                >
                  {busy ? "Sending…" : mode === "forward" ? "Forward" : "Send"}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setMenu(menu === "send" ? null : "send")}
                  disabled={busy || !canSend}
                  aria-label="More ways to send"
                  aria-expanded={menu === "send"}
                  className="-ml-px rounded-l-none px-2"
                >
                  <ChevronDown aria-hidden />
                </Button>
                {menu === "send" && (
                  <ul className={cn(pop, "right-0 w-60 text-sm")}>
                    {[
                      {
                        label: "Send and mark in progress",
                        then: "pending" as const,
                        until: undefined,
                      },
                      { label: "Send and keep open", then: "open" as const, until: undefined },
                      ...snoozeChoices.map((choice) => ({
                        label: `Send and snooze: ${choice.label.toLowerCase()}`,
                        then: "snoozed" as const,
                        until: choice.until,
                      })),
                      { label: "Send and close", then: "closed" as const, until: undefined },
                    ].map((option) => (
                      <li key={option.label}>
                        <button
                          type="button"
                          onClick={() => send(option.then, option.until)}
                          className="hover:bg-hover w-full rounded-sm px-2 py-1.5 text-left"
                        >
                          {option.label}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </span>
              <Button
                type="button"
                onClick={() => send("closed")}
                disabled={busy || !canSend}
                title="Send, close and go to the next one (Ctrl/⌘ + Shift + Enter)"
              >
                <Send aria-hidden />
                Send &amp; close
              </Button>
            </>
          )}
        </span>
      </div>
      {!canSend && !note && (
        <p className="text-muted-foreground border-border border-t px-3 py-2 text-xs">
          Sending email isn&apos;t switched on for this environment yet. Notes still work.
        </p>
      )}
    </div>
  );
}
