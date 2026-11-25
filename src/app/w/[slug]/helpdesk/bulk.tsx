"use client";

import {
  createContext,
  useActionState,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
} from "react";
import { useRouter } from "next/navigation";
import { Archive, Check, Download, OctagonAlert, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { FormMessage } from "@/components/ui/form-message";
import { Input, Label } from "@/components/ui/input";
import { SubmitButton } from "@/components/ui/submit-button";
import { cn } from "@/lib/utils";
import {
  bulkUpdate,
  exportTickets,
  saveFolder,
  type BulkChange,
  type HelpdeskState,
} from "./actions";

type Option = { value: string; label: string };

const Ticked = createContext<{
  ids: Set<string>;
  toggle: (id: string) => void;
  set: (ids: string[]) => void;
} | null>(null);

/** Holds which rows are ticked. The list is drawn on the server; only the ticks live here. */
export function BulkProvider({ children }: { children: React.ReactNode }) {
  const [ids, setIds] = useState<Set<string>>(() => new Set());
  const toggle = useCallback((id: string) => {
    setIds((was) => {
      const next = new Set(was);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);
  const set = useCallback((next: string[]) => setIds(new Set(next)), []);
  const value = useMemo(() => ({ ids, toggle, set }), [ids, toggle, set]);
  return <Ticked.Provider value={value}>{children}</Ticked.Provider>;
}

/** The tick box on a row. Quiet until the row is pointed at or something is ticked. */
export function BulkBox({ id, label }: { id: string; label: string }) {
  const ticked = useContext(Ticked);
  if (!ticked) return null;
  const on = ticked.ids.has(id);
  return (
    <input
      type="checkbox"
      checked={on}
      onChange={() => ticked.toggle(id)}
      aria-label={`Tick ${label}`}
      className={cn(
        "accent-ochre absolute top-[34px] left-[5px] z-10 size-3.5 cursor-pointer transition-opacity",
        on || ticked.ids.size > 0
          ? "opacity-100"
          : "opacity-50 focus-visible:opacity-100 md:opacity-0 md:group-hover:opacity-100",
      )}
    />
  );
}

const pick =
  "border-input bg-card h-8 min-w-0 max-w-[9.5rem] rounded-sm border px-1.5 text-xs font-semibold";
const iconButton =
  "text-text-2 hover:bg-hover hover:text-foreground focus-visible:ring-ochre flex size-8 shrink-0 items-center justify-center rounded-sm outline-none focus-visible:ring-2 [&_svg]:size-4";

/**
 * What can be done to every ticked conversation at once. Each press is one
 * request; the server checks every conversation again before it changes any.
 */
export function BulkBar({
  slug,
  listIds,
  people,
  folders,
  snoozeChoices,
  shelf,
  closedView,
  canExport,
}: {
  slug: string;
  /** Every conversation in the list, in order, for "tick all". */
  listIds: string[];
  people: Option[];
  folders: Option[];
  snoozeChoices: { key: string; label: string; until: string }[];
  /** The shelf being looked at, if any: its rows are restored rather than shelved. */
  shelf: "archived" | "spam" | "trash" | null;
  closedView: boolean;
  canExport: boolean;
}) {
  const router = useRouter();
  const ticked = useContext(Ticked);
  const [busy, start] = useTransition();
  const [words, setWords] = useState<{ text: string; bad: boolean } | null>(null);
  const [tagging, setTagging] = useState<"add_tags" | "remove_tags" | null>(null);
  const [tag, setTag] = useState("");
  const count = ticked?.ids.size ?? 0;

  // Rows that have left the list are no longer ticked.
  const listKey = listIds.join(",");
  useEffect(() => {
    if (!ticked || ticked.ids.size === 0) return;
    const here = new Set(listKey.split(","));
    const kept = [...ticked.ids].filter((id) => here.has(id));
    if (kept.length !== ticked.ids.size) ticked.set(kept);
  }, [listKey, ticked]);
  useEffect(() => {
    if (count === 0) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") ticked?.set([]);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [count, ticked]);

  if (!ticked || count === 0) return words ? <Said words={words} /> : null;
  const all = listIds.length > 0 && listIds.every((id) => ticked.ids.has(id));
  const run = (change: BulkChange, done: string) =>
    start(async () => {
      const result = await bulkUpdate(slug, [...ticked.ids], change);
      if (result.error) {
        setWords({ text: result.error, bad: true });
        return;
      }
      const n = result.count ?? 0;
      setWords({ text: `${n} conversation${n === 1 ? "" : "s"} ${done}.`, bad: false });
      ticked.set([]);
      setTagging(null);
      setTag("");
      router.refresh();
    });
  const download = () =>
    start(async () => {
      const result = await exportTickets(slug, [...ticked.ids]);
      if (result.error || !result.csv) {
        setWords({ text: result.error ?? "The export couldn't be made.", bad: true });
        return;
      }
      saveFile(result.csv, result.name ?? "conversations.csv");
    });

  return (
    <div
      role="toolbar"
      aria-label="Ticked conversations"
      className={cn(
        "border-border bg-card flex flex-col gap-1.5 border-t px-3 py-2",
        busy && "opacity-60",
      )}
    >
      <div className="flex items-center gap-2 text-xs">
        <label className="flex items-center gap-1.5 font-bold">
          <input
            type="checkbox"
            checked={all}
            ref={(el) => {
              if (el) el.indeterminate = !all;
            }}
            onChange={() => ticked.set(all ? [] : listIds.slice(0, 200))}
            aria-label={all ? "Untick all" : "Tick all"}
            className="accent-ochre size-3.5"
          />
          {count} ticked
        </label>
        <span className="ml-auto flex items-center">
          {shelf !== "archived" && (
            <button
              type="button"
              className={iconButton}
              title="Archive"
              aria-label="Archive the ticked conversations"
              onClick={() => run({ shelf: "archived" }, "archived")}
            >
              <Archive aria-hidden />
            </button>
          )}
          {shelf !== "spam" && (
            <button
              type="button"
              className={iconButton}
              title="Mark as spam"
              aria-label="Mark the ticked conversations as spam"
              onClick={() => run({ shelf: "spam" }, "moved to Spam")}
            >
              <OctagonAlert aria-hidden />
            </button>
          )}
          {shelf !== "trash" && (
            <button
              type="button"
              className={cn(iconButton, "text-brick hover:text-brick")}
              title="Delete (move to the Trash)"
              aria-label="Move the ticked conversations to the Trash"
              onClick={() => run({ shelf: "trash" }, "moved to the Trash")}
            >
              <Trash2 aria-hidden />
            </button>
          )}
          {canExport && (
            <button
              type="button"
              className={iconButton}
              title="Export the ticked conversations (CSV)"
              aria-label="Export the ticked conversations as a spreadsheet"
              onClick={download}
            >
              <Download aria-hidden />
            </button>
          )}
          <button
            type="button"
            className={iconButton}
            title="Untick all (Esc)"
            aria-label="Untick all"
            onClick={() => ticked.set([])}
          >
            <X aria-hidden />
          </button>
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        {shelf ? (
          <Button
            type="button"
            variant="dark"
            size="sm"
            onClick={() => run({ shelf: null }, "restored")}
          >
            {shelf === "spam" ? "Not spam" : shelf === "trash" ? "Restore" : "Unarchive"}
          </Button>
        ) : (
          <Button
            type="button"
            variant="dark"
            size="sm"
            onClick={() =>
              closedView ? run({ status: "open" }, "reopened") : run({ status: "closed" }, "closed")
            }
          >
            <Check aria-hidden />
            {closedView ? "Reopen" : "Close"}
          </Button>
        )}
        <select
          aria-label="Assign the ticked conversations"
          value=""
          className={pick}
          onChange={(event) => {
            const value = event.target.value;
            if (value) run({ assignee: value === "none" ? null : value }, "assigned");
          }}
        >
          <option value="">Assign…</option>
          <option value="none">Nobody</option>
          {people.map((person) => (
            <option key={person.value} value={person.value}>
              {person.label}
            </option>
          ))}
        </select>
        <select
          aria-label="Move the ticked conversations to a folder"
          value=""
          className={pick}
          onChange={(event) => {
            const value = event.target.value;
            if (value) run({ folder: value === "inbox" ? null : value }, "moved");
          }}
        >
          <option value="">Folder…</option>
          <option value="inbox">Back to the inbox</option>
          {folders.map((folder) => (
            <option key={folder.value} value={folder.value}>
              {folder.label}
            </option>
          ))}
        </select>
        <select
          aria-label="Snooze the ticked conversations"
          value=""
          className={pick}
          onChange={(event) => {
            if (event.target.value) run({ snooze_until: event.target.value }, "snoozed");
          }}
        >
          <option value="">Snooze…</option>
          {snoozeChoices.map((choice) => (
            <option key={choice.key} value={choice.until}>
              {choice.label}
            </option>
          ))}
        </select>
        <select
          aria-label="Tag the ticked conversations"
          value={tagging ?? ""}
          className={pick}
          onChange={(event) =>
            setTagging(event.target.value ? (event.target.value as "add_tags") : null)
          }
        >
          <option value="">Tag…</option>
          <option value="add_tags">Add a tag</option>
          <option value="remove_tags">Take a tag off</option>
        </select>
      </div>
      {tagging && (
        <form
          className="flex gap-1.5"
          onSubmit={(event) => {
            event.preventDefault();
            run(
              tagging === "add_tags" ? { add_tags: [tag] } : { remove_tags: [tag] },
              tagging === "add_tags" ? `tagged ${tag.trim().toLowerCase()}` : "untagged",
            );
          }}
        >
          <input
            autoFocus
            value={tag}
            maxLength={30}
            onChange={(event) => setTag(event.target.value)}
            aria-label={tagging === "add_tags" ? "Tag to add" : "Tag to take off"}
            placeholder={tagging === "add_tags" ? "Tag to add" : "Tag to take off"}
            className="border-input bg-card h-8 min-w-0 flex-1 rounded-sm border px-2 text-xs"
          />
          <Button type="submit" variant="outline" size="sm" disabled={!tag.trim()}>
            {tagging === "add_tags" ? "Add" : "Take off"}
          </Button>
        </form>
      )}
      {words && <Said words={words} />}
    </div>
  );
}

function Said({ words }: { words: { text: string; bad: boolean } }) {
  return (
    <p
      role={words.bad ? "alert" : "status"}
      className={cn("px-4 pb-1.5 text-xs", words.bad ? "text-brick" : "text-muted-foreground")}
    >
      {words.text}
    </p>
  );
}

/** Hands a file made on the server to the browser to save. */
function saveFile(text: string, name: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** "Export this list": the whole list as a spreadsheet. Owners and admins. */
export function ExportList({ slug, ids }: { slug: string; ids: string[] }) {
  const [busy, start] = useTransition();
  const [problem, setProblem] = useState<string | null>(null);
  return (
    <>
      <button
        type="button"
        disabled={busy || ids.length === 0}
        title="Export this list as a spreadsheet (CSV)"
        aria-label="Export this list as a spreadsheet"
        className={cn(iconButton, "disabled:opacity-40")}
        onClick={() =>
          start(async () => {
            const result = await exportTickets(slug, ids);
            if (result.error || !result.csv) setProblem(result.error ?? "No export came back.");
            else {
              setProblem(null);
              saveFile(result.csv, result.name ?? "conversations.csv");
            }
          })
        }
      >
        <Download aria-hidden />
      </button>
      {problem && (
        <span role="alert" className="text-brick basis-full text-xs">
          {problem}
        </span>
      )}
    </>
  );
}

/** On a wide screen, opens the first conversation in the list by itself. */
export function AutoOpen({ href }: { href: string }) {
  const router = useRouter();
  useEffect(() => {
    // The list and the conversation sit side by side from this width.
    if (window.matchMedia("(min-width: 768px)").matches) router.replace(href);
  }, [href, router]);
  return null;
}

/** "New folder", made where you are: opened by the "+" beside Folders in the menu. */
export function NewFolderDialog({ slug, base }: { slug: string; base: string }) {
  const router = useRouter();
  const dialog = useRef<HTMLDialogElement>(null);
  const [state, action] = useActionState<HelpdeskState, FormData>(async (prev, formData) => {
    const result = await saveFolder(slug, prev, formData);
    if (result.id) router.replace(`${base}?view=f:${result.id}`);
    return result;
  }, {});
  useEffect(() => {
    const el = dialog.current;
    if (el && !el.open) el.showModal();
  }, []);
  return (
    <dialog
      ref={dialog}
      aria-label="New folder"
      onClose={() => router.replace(base)}
      className="bg-card text-foreground m-auto w-[min(26rem,94vw)] rounded-lg p-0 shadow-lg backdrop:bg-black/40"
    >
      <form action={action} className="flex flex-col gap-3 p-5">
        <h2 className="text-base font-bold">New folder</h2>
        <p className="text-muted-foreground text-sm">
          Somewhere to put conversations that are waiting on something, like a repair. Anyone on the
          team can file into it.
        </p>
        <span className="flex flex-col gap-1">
          <Label htmlFor="new-folder-name">Name</Label>
          <Input id="new-folder-name" name="name" maxLength={40} required autoFocus />
        </span>
        <FormMessage>{state.error}</FormMessage>
        <span className="flex gap-2">
          <SubmitButton variant="dark" size="default" pendingText="Making…">
            Make folder
          </SubmitButton>
          <Button type="button" variant="ghost" onClick={() => dialog.current?.close()}>
            Cancel
          </Button>
        </span>
      </form>
    </dialog>
  );
}
