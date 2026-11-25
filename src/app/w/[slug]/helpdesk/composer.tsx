"use client";

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  Bold,
  BookOpen,
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
import { describeActions, mergeActions, type TemplateActions } from "@/lib/helpdesk/config";
import { draftKey, readDraft, type ComposerMode } from "@/lib/helpdesk/drafts";
import { fileSize, filesProblem, parseRecipients } from "@/lib/helpdesk/outbound";
import { isSafeLink, richToHtml, richToText, textToRich, type RichDoc } from "@/lib/helpdesk/rich";
import { readEditor } from "@/lib/helpdesk/rich-dom";
import { cn } from "@/lib/utils";
import { addTicketNote, draftTicketReply, sendMail } from "./actions";
import { ManualPicker } from "./manual-picker";

type Template = { id: string; name: string; body: string; actions?: TemplateActions };
type Teammate = { id: string; name: string; handle: string };
type Snooze = { key: string; label: string; until: string };

/** Events other parts of the desk send to the composer. */
export const INSERT_EVENT = "helpdesk:insert";
export const FOCUS_EVENT = "helpdesk:focus";
/** An email was queued with an undo wait: `{ id, seconds, ticketId, number, draft }`. */
export const QUEUED_EVENT = "helpdesk:queued";
/** A taken-back email's words are in this browser's drafts again: `{ ticketId }`. */
export const RESTORE_EVENT = "helpdesk:restore";

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
  replyAllCc = [],
  forwardFiles = [],
  team = [],
  afterClose = "next",
  templates,
  manualName = "Manual",
  snoozeChoices,
  canDraft,
  canSend,
  afterHref,
}: {
  slug: string;
  ticketId: string;
  customerEmail: string;
  customerFirstName: string | null;
  /** Who else the customer's last email went to; "Reply all" copies them in. */
  replyAllCc?: string[];
  /** The conversation's kept pictures and files, which a forward takes along. */
  forwardFiles?: { id: string; name: string; size: number }[];
  /** The team, for the @ picker in a note. */
  team?: Teammate[];
  /** After "Send & close": the next conversation, the list, or stay here. */
  afterClose?: "next" | "list" | "stay";
  templates: Template[];
  /** What the workspace calls its manual; the picker beside Macros goes by it. */
  manualName?: string;
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
  const [dropped, setDropped] = useState<string[]>([]);
  const [extras, setExtras] = useState<TemplateActions>({});
  const [mention, setMention] = useState<{ query: string; at: number } | null>(null);
  const [menu, setMenu] = useState<"macros" | "manual" | "ai" | "send" | null>(null);
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

  // Bring back what was being written on this conversation, in this browser:
  // when it opens, and when an email that was sent is taken back.
  useEffect(() => {
    const bring = (words: string) => {
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
      setNotice(words);
    };
    const frame = requestAnimationFrame(() => bring("Your unsent draft is back."));
    const onRestore = (event: Event) => {
      if ((event as CustomEvent<{ ticketId: string }>).detail?.ticketId === ticketId) {
        bring("Taken back. Nothing was sent; your words are in the box again.");
      }
    };
    window.addEventListener(RESTORE_EVENT, onRestore);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener(RESTORE_EVENT, onRestore);
    };
  }, [key, ticketId]);

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
      // "Reply all" brings in everyone on the customer's last email; plain "Reply" lets them go again.
      const copies = replyAllCc.join(", ");
      let nextCc = state.current.cc;
      if (next === "reply_all" && !nextCc.trim()) nextCc = copies;
      else if (next !== "reply_all" && nextCc === copies) nextCc = "";
      setCc(nextCc);
      state.current = { ...state.current, mode: next, cc: nextCc };
      save();
      if (focus) requestAnimationFrame(() => editor.current?.focus());
    },
    [customerEmail, replyAllCc, save],
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
    setDropped([]);
    setExtras({});
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

  const send = (asked: "pending" | "open" | "closed" | "snoozed", until?: string) => {
    let then = asked;
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
    // A saved reply's "then" applies when the person presses plain Send.
    if (then === "pending" && mode !== "forward" && extras.then) then = extras.then;
    const data = new FormData();
    data.set("mode", mode);
    data.set("doc", JSON.stringify(doc));
    data.set("macro_actions", JSON.stringify(extras));
    data.set("to", to);
    data.set("cc", cc);
    data.set("bcc", bcc);
    data.set("then", mode === "forward" && then === "pending" ? "keep" : then);
    if (until) data.set("snooze_until", until);
    for (const file of files) data.append("files", file);
    if (mode === "forward") {
      for (const file of forwardFiles)
        if (!dropped.includes(file.id)) data.append("carry", file.id);
    }
    setProblem(null);
    start(async () => {
      const result = await sendMail(slug, ticketId, data);
      if (result.error) {
        setProblem(`${result.error} Your draft is saved.`);
        return;
      }
      if (result.queued) {
        // It is waiting on the server. The words travel with the notice so
        // "Undo" can put them back, wherever the person has gone by then.
        window.dispatchEvent(
          new CustomEvent(QUEUED_EVENT, {
            detail: {
              ...result.queued,
              ticketId,
              number: result.number,
              forward: mode === "forward",
              draft: JSON.stringify({
                mode,
                doc,
                to: mode === "forward" ? to : undefined,
                cc: cc || undefined,
              }),
            },
          }),
        );
      }
      clear();
      setCc("");
      setBcc("");
      setEditing(false);
      setModeState("reply");
      setTo(customerEmail);
      const leaving = then === "snoozed" || (then === "closed" && afterClose !== "stay");
      if (leaving) router.push(afterHref);
      else {
        setNotice(result.queued ? null : mode === "forward" ? "Forwarded." : "Sent.");
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

  // In a note, "@" and a few letters offers the team to pick from.
  const checkMention = () => {
    if (state.current.mode !== "note") return setMention(null);
    const selection = window.getSelection();
    const node = selection?.anchorNode;
    if (!selection || !node || node.nodeType !== Node.TEXT_NODE) return setMention(null);
    const before = (node.textContent ?? "").slice(0, selection.anchorOffset);
    const found = /(^|\s)@([a-z0-9._-]{0,30})$/i.exec(before);
    setMention(found ? { query: found[2].toLowerCase(), at: found[2].length + 1 } : null);
  };
  const pickMention = (person: Teammate) => {
    const selection = window.getSelection();
    const node = selection?.anchorNode;
    if (!selection || !node || !mention) return;
    // Replace what was typed after the "@" (and the "@") with the person's handle.
    const range = document.createRange();
    range.setStart(node, Math.max(0, selection.anchorOffset - mention.at));
    range.setEnd(node, selection.anchorOffset);
    selection.removeAllRanges();
    selection.addRange(range);
    document.execCommand("insertText", false, `@${person.handle} `);
    setMention(null);
    save();
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
  const onSend = describeActions(
    extras,
    (id) => team.find((person) => person.id === id)?.name ?? "a teammate",
  );
  const mentionable = mention
    ? team
        .filter(
          (person) =>
            person.handle.startsWith(mention.query) ||
            person.name.toLowerCase().includes(mention.query),
        )
        .slice(0, 6)
    : [];
  const carried = mode === "forward" ? forwardFiles.filter((f) => !dropped.includes(f.id)) : [];
  const people = {
    to: parseRecipients(to).ok,
    cc: parseRecipients(cc).ok,
    bcc: parseRecipients(bcc).ok,
  };
  const shownMacros = templates.filter((template) =>
    `${template.name} ${template.body}`.toLowerCase().includes(macroSearch.trim().toLowerCase()),
  );
  const placeholder = note
    ? "Only your team sees notes. Type @ to mention someone…"
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
              aria-controls="composer"
              // On a phone only the icon shows, so the name is given outright.
              aria-label={tab.label}
              title={tab.label}
              onClick={() => setMode(tab.key)}
              className={cn(
                quiet,
                "max-md:h-10 max-md:min-w-10 max-md:justify-center",
                // The tab you are on: filled, with the ochre line every selected tab here carries.
                mode === tab.key &&
                  "bg-sunken text-foreground shadow-[inset_0_-2px_0_var(--tuft-ochre)]",
              )}
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
        onInput={() => {
          save();
          checkMention();
        }}
        onKeyUp={checkMention}
        onClick={checkMention}
        onBlur={() => setTimeout(() => setMention(null), 150)}
        onPaste={(event) => {
          // A paste comes in as plain words: nothing from another page's markup gets in.
          event.preventDefault();
          document.execCommand("insertText", false, event.clipboardData.getData("text/plain"));
        }}
        className="composer-box font-read max-h-[34vh] min-h-[56px] overflow-y-auto px-3 py-2 text-sm break-words outline-none lg:min-h-[92px]"
      />

      {note && mention && mentionable.length > 0 && (
        <ul
          role="listbox"
          aria-label="Mention a teammate"
          className="border-border bg-card mx-3 mb-1 w-fit min-w-48 rounded-md border p-1 shadow-lg"
        >
          {mentionable.map((person) => (
            <li key={person.id} role="option" aria-selected={false}>
              <button
                type="button"
                // Keep the caret where it is: the pick replaces what was typed there.
                onMouseDown={(event) => {
                  event.preventDefault();
                  pickMention(person);
                }}
                className="hover:bg-hover flex w-full items-baseline gap-2 rounded-sm px-2 py-1 text-left text-sm"
              >
                <span className="font-semibold">{person.name}</span>
                <span className="text-muted-foreground text-xs">@{person.handle}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
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
      {!note && onSend.length > 0 && (
        <p className="flex flex-wrap items-center gap-1.5 px-3 pb-1 text-xs">
          <span className="text-muted-foreground">On send:</span>
          {onSend.map((action) => (
            <span
              key={action.key}
              className="border-ochre bg-ochre-soft text-ochre-text flex items-center gap-1 rounded-full border px-2 py-0.5 font-semibold"
            >
              <Zap aria-hidden className="size-3" />
              {action.label}
              <button
                type="button"
                aria-label={`Don't ${action.label}`}
                onClick={() =>
                  setExtras((was) => ({
                    ...was,
                    ...(action.key === "tags"
                      ? { add_tags: undefined }
                      : action.key === "then"
                        ? { then: undefined }
                        : { assign_to: undefined }),
                  }))
                }
              >
                <X aria-hidden className="size-3" />
              </button>
            </span>
          ))}
        </p>
      )}
      {carried.length > 0 && (
        <ul
          aria-label="Files from this conversation going with the forward"
          className="flex flex-wrap gap-1.5 px-3 pb-1"
        >
          {carried.map((file) => (
            <li
              key={file.id}
              className="border-border bg-panel flex items-center gap-1.5 rounded-sm border px-2 py-1 text-xs"
            >
              <Paperclip aria-hidden className="text-muted-foreground size-3" />
              <span className="font-read max-w-[16ch] truncate font-semibold">{file.name}</span>
              <span className="text-muted-foreground">{fileSize(file.size)}</span>
              <button
                type="button"
                aria-label={`Don't forward ${file.name}`}
                onClick={() => setDropped((was) => [...was, file.id])}
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
                            setExtras((was) => mergeActions(was, template.actions));
                            insert(template.body);
                          }}
                          className="hover:bg-hover w-full rounded-sm px-2 py-1.5 text-left"
                        >
                          <span className="flex items-center gap-1.5 text-sm font-semibold">
                            {template.name}
                            {template.actions && Object.keys(template.actions).length > 0 && (
                              <Zap
                                aria-label="Also does something when sent"
                                className="text-ochre-text size-3"
                              />
                            )}
                          </span>
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
            <div className="relative" data-pop>
              <button
                type="button"
                onClick={() => setMenu(menu === "manual" ? null : "manual")}
                aria-expanded={menu === "manual"}
                className={quiet}
              >
                <BookOpen aria-hidden />
                {manualName}
              </button>
              {menu === "manual" && (
                <div className={cn(pop, "left-0 w-[min(24rem,88vw)]")}>
                  <ManualPicker
                    slug={slug}
                    name={manualName}
                    onPick={(text) => {
                      setMenu(null);
                      insert(text);
                    }}
                  />
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
