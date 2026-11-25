"use client";

import {
  createContext,
  useActionState,
  useContext,
  useEffect,
  useRef,
  useState,
  useTransition,
} from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Check,
  ChevronDown,
  Copy,
  Filter,
  Mail,
  MoreHorizontal,
  PanelRightClose,
  PanelRightOpen,
  Plus,
  RefreshCw,
  Sparkles,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { FormMessage } from "@/components/ui/form-message";
import { Input, Label } from "@/components/ui/input";
import { SubmitButton } from "@/components/ui/submit-button";
import { TAG_PATTERN } from "@/lib/helpdesk/config";
import { textToRich } from "@/lib/helpdesk/rich";
import { cn } from "@/lib/utils";
import {
  assignTicket,
  fileTicket,
  markRead,
  mergeTicket,
  renameTicket,
  saveView,
  setStatus,
  setTags,
  setTicketPriority,
  snoozeTicket,
  startConversation,
  summarizeTicket,
  type HelpdeskState,
} from "./actions";
import { FOCUS_EVENT, INSERT_EVENT } from "./composer";

const MENU_EVENT = "helpdesk:menu";
const NEW_EMAIL_EVENT = "helpdesk:new-email";
const RAIL_COOKIE = "mbs-desk-rail";

const icon =
  "text-text-2 hover:bg-hover hover:text-foreground focus-visible:ring-ochre flex size-8 shrink-0 items-center justify-center rounded-sm outline-none focus-visible:ring-2 [&_svg]:size-4";
const item =
  "hover:bg-hover focus-visible:bg-hover flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm outline-none";

const typing = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  (/^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName) || target.isContentEditable);

// ---- A small menu -----------------------------------------------------------

/** A button that opens a list under it. Closes on a pick, a press outside, or Escape. */
export function Menu({
  name,
  label,
  button,
  className,
  align = "right",
  width = "w-56",
  children,
}: {
  /** Lets a key press open it (`helpdesk:menu` with this name). */
  name?: string;
  label: string;
  button: React.ReactNode;
  className?: string;
  align?: "left" | "right";
  width?: string;
  children: (close: () => void) => React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!name) return;
    const onAsk = (event: Event) => {
      if ((event as CustomEvent<string>).detail === name) setOpen(true);
    };
    window.addEventListener(MENU_EVENT, onAsk);
    return () => window.removeEventListener(MENU_EVENT, onAsk);
  }, [name]);
  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (!box.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return (
    <div ref={box} className="relative">
      <button
        type="button"
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((was) => !was)}
        className={className}
      >
        {button}
      </button>
      {open && (
        <div
          role="menu"
          className={cn(
            "bg-card border-border absolute top-full z-40 mt-1 max-h-[70vh] overflow-y-auto rounded-md border p-1.5 shadow-lg",
            width,
            align === "right" ? "right-0" : "left-0",
          )}
        >
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

// ---- The details rail: beside the conversation on a wide window -------------

const RailContext = createContext<{ closed: boolean; toggle: () => void } | null>(null);

/** Remembers, per browser, whether the details rail is folded away on a wide window. */
export function RailFrame({
  startClosed,
  children,
}: {
  startClosed: boolean;
  children: React.ReactNode;
}) {
  const [closed, setClosed] = useState(startClosed);
  const toggle = () => {
    setClosed((was) => {
      try {
        document.cookie = `${RAIL_COOKIE}=${was ? "open" : "closed"}; path=/; max-age=31536000; samesite=lax`;
      } catch {
        // A browser that refuses cookies simply forgets.
      }
      return !was;
    });
  };
  return <RailContext.Provider value={{ closed, toggle }}>{children}</RailContext.Provider>;
}

/** The header's "Details" button: folds the rail on a wide window, opens it over the page on a narrow one. */
export function RailToggle({ openHref }: { openHref: string }) {
  const rail = useContext(RailContext);
  return (
    <>
      <button
        type="button"
        onClick={rail?.toggle}
        aria-label={rail?.closed ? "Show details" : "Hide details"}
        title={rail?.closed ? "Show details" : "Hide details"}
        className={cn(icon, "hidden xl:flex")}
      >
        {rail?.closed ? <PanelRightOpen aria-hidden /> : <PanelRightClose aria-hidden />}
      </button>
      <Button asChild variant="outline" size="sm" className="xl:hidden">
        <Link href={openHref} scroll={false}>
          Details
        </Link>
      </Button>
    </>
  );
}

/** The rail itself: docked from 1280px unless folded; under that, over the page when the address asks for it. */
export function RailShell({ open, children }: { open: boolean; children: React.ReactNode }) {
  const rail = useContext(RailContext);
  return (
    <aside
      aria-label="Details"
      className={cn(
        "border-border bg-panel min-h-0 w-full shrink-0 flex-col border-l md:w-[340px] xl:w-[320px] 2xl:w-[340px]",
        open
          ? "absolute inset-y-0 right-0 z-30 flex shadow-lg max-md:bottom-[57px] xl:static xl:shadow-none"
          : "hidden",
        rail?.closed ? "xl:hidden" : "xl:flex",
      )}
    >
      {children}
    </aside>
  );
}

// ---- Keys, keeping the list fresh, and marking what was read ----------------

const KEYS: [string, [string[], string][]][] = [
  [
    "Move",
    [
      [["j", "k"], "Next / previous conversation"],
      [["u"], "Back to the list"],
      [["/"], "Search"],
      [["c"], "New email"],
    ],
  ],
  [
    "Conversation",
    [
      [["r"], "Reply"],
      [["n"], "Internal note"],
      [["f"], "Forward"],
      [["e"], "Close"],
      [["s"], "Status and snooze"],
      [["m"], "Assign to me"],
    ],
  ],
  [
    "Details",
    [
      [["a"], "Assignee"],
      [["p"], "Priority"],
      [["v"], "Folder"],
      [["t"], "Tags"],
    ],
  ],
  [
    "Composer",
    [
      [["Ctrl/⌘", "↵"], "Send · mark in progress"],
      [["Ctrl/⌘", "⇧", "↵"], "Send & close"],
    ],
  ],
];

export function DeskKeys({
  slug,
  previous,
  next,
  back,
  after,
  ticket,
  me,
  unread,
}: {
  slug: string;
  previous: string | null;
  next: string | null;
  back: string;
  /** Where closing a conversation leads: the next one, or the list. */
  after: string;
  /** The open conversation, when this person may change it. */
  ticket: { id: string; closed: boolean } | null;
  me: string;
  /** Whether the open conversation is unread for this person. */
  unread: string | null;
}) {
  const router = useRouter();
  const help = useRef<HTMLDialogElement>(null);

  // Opening a conversation is reading it.
  useEffect(() => {
    if (unread) void markRead(slug, unread, true);
  }, [slug, unread]);

  // New mail shows up without a reload, while nobody is typing.
  useEffect(() => {
    const timer = setInterval(() => {
      if (
        !document.hidden &&
        !typing(document.activeElement) &&
        !document.querySelector("dialog[open]")
      ) {
        router.refresh();
      }
    }, 30_000);
    return () => clearInterval(timer);
  }, [router]);

  useEffect(() => {
    const say = (name: string, detail?: string) =>
      window.dispatchEvent(new CustomEvent(name, { detail }));
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || typing(event.target)) return;
      if (document.querySelector("dialog[open]")) return;
      const key = event.key;
      const go = (fn: () => void) => {
        event.preventDefault();
        fn();
      };
      if (key === "j" && next) go(() => router.push(next));
      else if (key === "k" && previous) go(() => router.push(previous));
      else if (key === "u") go(() => router.push(back));
      else if (key === "/") go(() => document.getElementById("desk-search")?.focus());
      else if (key === "c") go(() => say(NEW_EMAIL_EVENT));
      else if (key === "?") go(() => help.current?.showModal());
      else if (ticket) {
        if (key === "r") go(() => say(FOCUS_EVENT, "reply"));
        else if (key === "n") go(() => say(FOCUS_EVENT, "note"));
        else if (key === "f") go(() => say(FOCUS_EVENT, "forward"));
        else if (key === "s") go(() => say(MENU_EVENT, "status"));
        else if (key === "e" && !ticket.closed) {
          go(() => void setStatus(slug, ticket.id, "closed").then(() => router.push(after)));
        } else if (key === "m") go(() => void assignTicket(slug, ticket.id, me));
        else if ("apvt".includes(key)) {
          const id = { a: "rail-assignee", p: "rail-priority", v: "rail-folder", t: "rail-tag" }[
            key
          ];
          go(() => document.getElementById(id ?? "")?.focus());
        }
      }
    };
    const onHelp = () => help.current?.showModal();
    window.addEventListener("keydown", onKey);
    window.addEventListener("helpdesk:keys", onHelp);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("helpdesk:keys", onHelp);
    };
  }, [router, slug, previous, next, back, after, ticket, me]);

  return (
    <dialog
      ref={help}
      aria-label="Keyboard shortcuts"
      onClick={(event) => {
        if (event.target === event.currentTarget) help.current?.close();
      }}
      className="bg-card text-foreground m-auto w-[min(40rem,92vw)] rounded-lg p-0 shadow-lg backdrop:bg-black/40"
    >
      <div className="border-border flex items-center justify-between border-b px-5 py-3">
        <h2 className="text-base font-bold">Keyboard shortcuts</h2>
        <button
          type="button"
          onClick={() => help.current?.close()}
          aria-label="Close"
          className={icon}
        >
          <X aria-hidden />
        </button>
      </div>
      <div className="grid gap-x-8 gap-y-4 p-5 sm:grid-cols-2">
        {KEYS.map(([title, rows]) => (
          <div key={title}>
            <h3 className="text-muted-foreground mb-1.5 text-[11px] font-semibold tracking-wide uppercase">
              {title}
            </h3>
            <ul className="flex flex-col gap-1 text-sm">
              {rows.map(([keys, label]) => (
                <li key={label} className="flex items-center justify-between gap-3">
                  <span>{label}</span>
                  <span className="flex gap-1">
                    {keys.map((key) => (
                      <kbd
                        key={key}
                        className="border-border bg-panel rounded border px-1.5 py-0.5 font-mono text-[11px]"
                      >
                        {key}
                      </kbd>
                    ))}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </dialog>
  );
}

// ---- The list's own tools: filter, new email, refresh, more -----------------

type Option = { value: string; label: string };

export function ListTools({
  slug,
  base,
  params,
  tags,
  people,
  sorts,
  canWrite,
  canSaveView,
  canSend,
  manageHref,
}: {
  slug: string;
  base: string;
  /** The address's own words, so a filter changes only itself. */
  params: Record<string, string>;
  tags: string[];
  people: Option[];
  sorts: Option[];
  canWrite: boolean;
  canSaveView: boolean;
  canSend: boolean;
  manageHref: string;
}) {
  const router = useRouter();
  const filters = ["tag", "assignee", "priority", "unread"].filter((key) => params[key]);
  const [open, setOpen] = useState(filters.length > 0 || Boolean(params.sort));
  const [spinning, startRefresh] = useTransition();
  const [saving, setSaving] = useState(false);
  const [saved, saveAction] = useActionState<HelpdeskState, FormData>(async (prev, formData) => {
    const result = await saveView(slug, prev, formData);
    if (result.message) setSaving(false);
    return result;
  }, {});

  const go = (changes: Record<string, string | null>) => {
    const next = new URLSearchParams(params);
    next.delete("t");
    for (const [key, value] of Object.entries(changes)) {
      if (value) next.set(key, value);
      else next.delete(key);
    }
    const text = next.toString();
    router.push(text ? `${base}?${text}` : base);
  };
  const select = (key: string, label: string, options: Option[]) => (
    <select
      aria-label={label}
      value={params[key] ?? ""}
      onChange={(event) => go({ [key]: event.target.value || null })}
      className="border-input bg-card h-8 min-w-0 rounded-sm border px-1.5 text-xs"
    >
      <option value="">{label}</option>
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );

  return (
    <>
      <span className="ml-auto flex items-center">
        <button
          type="button"
          onClick={() => setOpen((was) => !was)}
          aria-expanded={open}
          aria-label="Filter and sort"
          title="Filter and sort"
          className={cn(icon, (open || filters.length > 0) && "bg-sunken text-foreground")}
        >
          <Filter aria-hidden />
        </button>
        {canWrite && <NewEmail slug={slug} canSend={canSend} />}
        <button
          type="button"
          onClick={() => startRefresh(() => router.refresh())}
          aria-label="Refresh"
          title="Refresh"
          className={icon}
        >
          <RefreshCw aria-hidden className={cn(spinning && "animate-spin")} />
        </button>
        <Menu label="More" button={<MoreHorizontal aria-hidden />} className={icon}>
          {(close) => (
            <>
              <button
                type="button"
                role="menuitem"
                className={item}
                onClick={() => {
                  close();
                  window.dispatchEvent(new CustomEvent("helpdesk:keys"));
                }}
              >
                Keyboard shortcuts
                <kbd className="text-muted-foreground ml-auto font-mono text-xs">?</kbd>
              </button>
              <Link href={manageHref} role="menuitem" className={item} onClick={close}>
                Manage folders and views
              </Link>
            </>
          )}
        </Menu>
      </span>
      {open && (
        <div className="col-span-full grid w-full grid-cols-2 gap-1.5 pt-2">
          {select(
            "tag",
            "Any tag",
            tags.map((tag) => ({ value: tag, label: tag })),
          )}
          {select("assignee", "Anyone", [
            { value: "me", label: "Me" },
            { value: "none", label: "Unassigned" },
            ...people,
          ])}
          {select("priority", "Any priority", [
            { value: "urgent", label: "Urgent" },
            { value: "high", label: "High" },
            { value: "normal", label: "Normal" },
            { value: "low", label: "Low" },
          ])}
          {select("sort", "Newest activity", sorts)}
          <span className="col-span-2 flex flex-wrap items-center gap-2 text-xs">
            <label className="flex items-center gap-1.5">
              <input
                type="checkbox"
                checked={params.unread === "1"}
                onChange={(event) => go({ unread: event.target.checked ? "1" : null })}
              />
              Unread only
            </label>
            {filters.length > 0 && (
              <>
                <button
                  type="button"
                  onClick={() => go({ tag: null, assignee: null, priority: null, unread: null })}
                  className="text-ochre-text ml-auto font-semibold hover:underline"
                >
                  Clear
                </button>
                {canSaveView && (
                  <button
                    type="button"
                    onClick={() => setSaving((was) => !was)}
                    className="text-ochre-text font-semibold hover:underline"
                  >
                    Save as view
                  </button>
                )}
              </>
            )}
          </span>
          {saving && (
            <form action={saveAction} className="col-span-2 flex flex-col gap-1.5">
              <input type="hidden" name="tags" value={params.tag ?? ""} />
              <input type="hidden" name="assignee" value={params.assignee ?? ""} />
              <input type="hidden" name="priority" value={params.priority ?? ""} />
              {params.unread === "1" && <input type="hidden" name="unread" value="1" />}
              <Label htmlFor="view-name" className="sr-only">
                Name the view
              </Label>
              <span className="flex gap-1.5">
                <Input
                  id="view-name"
                  name="name"
                  required
                  maxLength={40}
                  placeholder="e.g. Urgent repairs"
                />
                <SubmitButton variant="dark" size="default" pendingText="Saving…">
                  Save
                </SubmitButton>
              </span>
              <p className="text-muted-foreground text-xs">
                The view keeps these filters and shows open and in-progress conversations.
              </p>
              <FormMessage>{saved.error}</FormMessage>
            </form>
          )}
        </div>
      )}
    </>
  );
}

/** "New email": start a conversation with a customer. Also opened by "c" and from the customer's card. */
export function NewEmail({ slug, canSend }: { slug: string; canSend: boolean }) {
  const router = useRouter();
  const dialog = useRef<HTMLDialogElement>(null);
  const [to, setTo] = useState("");
  const [state, action] = useActionState<HelpdeskState, FormData>(async (_prev, formData) => {
    formData.set("doc", JSON.stringify(textToRich(String(formData.get("body") ?? ""))));
    const result = await startConversation(slug, formData);
    if (result.number && !result.error) {
      dialog.current?.close();
      router.push(`/w/${slug}/helpdesk?view=all&t=${result.number}`);
      return {};
    }
    return { error: result.error };
  }, {});
  useEffect(() => {
    const onAsk = (event: Event) => {
      setTo((event as CustomEvent<string | undefined>).detail ?? "");
      dialog.current?.showModal();
    };
    window.addEventListener(NEW_EMAIL_EVENT, onAsk);
    return () => window.removeEventListener(NEW_EMAIL_EVENT, onAsk);
  }, []);
  return (
    <>
      <button
        type="button"
        onClick={() => {
          setTo("");
          dialog.current?.showModal();
        }}
        aria-label="New email"
        title="New email (c)"
        className={icon}
      >
        <Plus aria-hidden />
      </button>
      <dialog
        ref={dialog}
        aria-label="New email"
        className="bg-card text-foreground m-auto w-[min(34rem,94vw)] rounded-lg p-0 shadow-lg backdrop:bg-black/40"
      >
        <form action={action} className="flex flex-col gap-3 p-5">
          <div className="flex items-center justify-between">
            <h2 className="text-base font-bold">New email</h2>
            <button
              type="button"
              onClick={() => dialog.current?.close()}
              aria-label="Close"
              className={icon}
            >
              <X aria-hidden />
            </button>
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="new-to">To</Label>
            <Input
              id="new-to"
              name="to"
              type="email"
              required
              value={to}
              onChange={(event) => setTo(event.target.value)}
              placeholder="name@example.com"
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="new-subject">Subject</Label>
            <Input id="new-subject" name="subject" required maxLength={200} />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="new-body">Message</Label>
            <textarea
              id="new-body"
              name="body"
              rows={7}
              required
              maxLength={20000}
              className="border-input bg-card focus-visible:border-ochre focus-visible:ring-ochre/25 font-read w-full rounded-sm border px-[11px] py-2 text-sm outline-none focus-visible:ring-2"
            />
          </div>
          <FormMessage>{state.error}</FormMessage>
          {!canSend && (
            <p className="text-muted-foreground text-xs">
              Sending email isn&apos;t switched on for this environment yet.
            </p>
          )}
          <span className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => dialog.current?.close()}>
              Cancel
            </Button>
            <SubmitButton variant="dark" size="default" pendingText="Sending…">
              Send &amp; start a conversation
            </SubmitButton>
          </span>
        </form>
      </dialog>
    </>
  );
}

/** The customer card's "New email" button. */
export function NewEmailTo({ email }: { email: string }) {
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={() => window.dispatchEvent(new CustomEvent(NEW_EMAIL_EVENT, { detail: email }))}
    >
      <Mail aria-hidden />
      New email
    </Button>
  );
}

// ---- The conversation's header ----------------------------------------------

type Snooze = { key: string; label: string; until: string };

/** The subject: press it to rename the conversation. */
export function SubjectEdit({
  slug,
  ticketId,
  subject,
  canEdit,
}: {
  slug: string;
  ticketId: string;
  subject: string;
  canEdit: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [, start] = useTransition();
  const heading = "font-read text-lg leading-snug font-semibold text-balance";
  if (!canEdit) return <h2 className={heading}>{subject}</h2>;
  if (!editing) {
    return (
      <h2 className={heading}>
        <button
          type="button"
          onClick={() => setEditing(true)}
          title="Press to rename"
          className="hover:bg-hover focus-visible:ring-ochre -mx-1 rounded-sm px-1 text-left outline-none focus-visible:ring-2"
        >
          {subject}
        </button>
      </h2>
    );
  }
  const done = (value: string | null) => {
    setEditing(false);
    const next = value?.trim();
    if (next && next !== subject) start(() => renameTicket(slug, ticketId, next));
  };
  return (
    <input
      autoFocus
      defaultValue={subject}
      maxLength={200}
      aria-label="Subject"
      onBlur={(event) => done(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === "Enter") done(event.currentTarget.value);
        if (event.key === "Escape") done(null);
      }}
      className="border-ochre font-read w-full rounded-sm border px-1.5 py-0.5 text-lg font-semibold outline-none"
    />
  );
}

/** Status pill, Close / Reopen, and the "…" menu. */
export function TicketControls({
  slug,
  ticketId,
  status,
  statusLabel,
  snoozed,
  folderId,
  assignedToMe,
  me,
  snoozeChoices,
  folders,
  after,
  back,
  others,
}: {
  slug: string;
  ticketId: string;
  status: "open" | "pending" | "closed";
  statusLabel: string;
  snoozed: string | null;
  folderId: string | null;
  assignedToMe: boolean;
  me: string;
  snoozeChoices: Snooze[];
  folders: { id: string; name: string }[];
  after: string;
  back: string;
  /** The customer's other open conversations, offered when merging. */
  others: { number: number; subject: string }[];
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const merge = useRef<HTMLDialogElement>(null);
  const [custom, setCustom] = useState("");
  const [merged, mergeAction] = useActionState<HelpdeskState & { into?: number }, FormData>(
    async (prev, formData) => {
      const result = await mergeTicket(slug, ticketId, prev, formData);
      if (result.into) {
        merge.current?.close();
        router.push(`/w/${slug}/helpdesk?view=all&t=${result.into}`);
      }
      return result;
    },
    {},
  );
  const closed = status === "closed";
  const change = (next: "open" | "pending" | "closed") =>
    start(async () => {
      await setStatus(slug, ticketId, next);
      if (next === "closed") router.push(after);
    });
  const snooze = (until: string | null) =>
    start(async () => {
      await snoozeTicket(slug, ticketId, until);
      if (until) router.push(after);
    });
  const tone = snoozed
    ? "bg-sunken text-muted-foreground"
    : status === "open"
      ? "bg-teal-soft text-teal-soft-ink"
      : status === "pending"
        ? "bg-ochre-soft text-ochre-text"
        : "bg-sunken text-muted-foreground";
  const snoozeItems = (close: () => void) => (
    <>
      <p className="text-muted-foreground px-2 pt-1.5 pb-0.5 text-[11px] font-semibold tracking-wide uppercase">
        Snooze until
      </p>
      {snoozed && (
        <button
          type="button"
          role="menuitem"
          className={item}
          onClick={() => (close(), snooze(null))}
        >
          Bring it back now
        </button>
      )}
      {snoozeChoices.map((choice) => (
        <button
          key={choice.key}
          type="button"
          role="menuitem"
          className={item}
          onClick={() => (close(), snooze(choice.until))}
        >
          {choice.label}
        </button>
      ))}
      <span className="flex gap-1.5 px-2 py-1.5">
        <input
          type="datetime-local"
          aria-label="Snooze until a time of your own"
          value={custom}
          onChange={(event) => setCustom(event.target.value)}
          className="border-input bg-card h-8 min-w-0 flex-1 rounded-sm border px-1.5 text-xs"
        />
        <Button
          type="button"
          variant="dark"
          size="sm"
          disabled={!custom}
          onClick={() => {
            const when = new Date(custom);
            if (Number.isNaN(when.getTime()) || when.getTime() <= Date.now()) return;
            close();
            snooze(when.toISOString());
          }}
        >
          Snooze
        </Button>
      </span>
    </>
  );

  return (
    <div className={cn("flex shrink-0 items-center gap-1.5", pending && "opacity-60")}>
      <Menu
        name="status"
        label="Change status"
        width="w-64"
        className={cn(
          "focus-visible:ring-ochre flex h-[30px] items-center gap-1 rounded-full px-3 text-xs font-semibold outline-none focus-visible:ring-2 [&_svg]:size-3.5",
          tone,
        )}
        button={
          <>
            {closed && <Check aria-hidden />}
            {snoozed ? `Snoozed · ${snoozed}` : statusLabel}
            <ChevronDown aria-hidden />
          </>
        }
      >
        {(close) => (
          <>
            {(
              [
                ["open", "Open"],
                ["pending", "In progress"],
                ["closed", "Closed"],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                role="menuitemradio"
                aria-checked={status === value}
                className={cn(item, status === value && "font-semibold")}
                onClick={() => (close(), change(value))}
              >
                {label}
                {status === value && <Check aria-hidden className="ml-auto size-3.5" />}
              </button>
            ))}
            {!closed && (
              <div className="border-border mt-1 border-t pt-1">{snoozeItems(close)}</div>
            )}
          </>
        )}
      </Menu>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => change(closed ? "open" : "closed")}
      >
        {closed ? "Reopen" : "Close"}
      </Button>
      <Menu
        label="More actions"
        button={<MoreHorizontal aria-hidden />}
        className={icon}
        width="w-60"
      >
        {(close) => {
          const run = (fn: () => Promise<unknown> | void) => () => {
            close();
            start(async () => {
              await fn();
            });
          };
          return (
            <>
              {status !== "pending" && !closed && (
                <button
                  type="button"
                  role="menuitem"
                  className={item}
                  onClick={run(() => setStatus(slug, ticketId, "pending"))}
                >
                  Mark in progress
                </button>
              )}
              {!assignedToMe && (
                <button
                  type="button"
                  role="menuitem"
                  className={item}
                  onClick={run(() => assignTicket(slug, ticketId, me))}
                >
                  Assign to me
                </button>
              )}
              <button
                type="button"
                role="menuitem"
                className={item}
                onClick={() => {
                  close();
                  merge.current?.showModal();
                }}
              >
                Merge…
              </button>
              <button
                type="button"
                role="menuitem"
                className={item}
                onClick={run(async () => {
                  await markRead(slug, ticketId, false);
                  router.push(back);
                })}
              >
                Mark as unread
              </button>
              <p className="text-muted-foreground border-border mt-1 border-t px-2 pt-2 pb-0.5 text-[11px] font-semibold tracking-wide uppercase">
                Move to folder
              </p>
              {folders.length === 0 && (
                <p className="text-muted-foreground px-2 py-1 text-xs">
                  No folders yet. An owner or admin makes them in Settings → Help desk.
                </p>
              )}
              {folders.map((folder) => (
                <button
                  key={folder.id}
                  type="button"
                  role="menuitemradio"
                  aria-checked={folder.id === folderId}
                  className={cn(item, folder.id === folderId && "font-semibold")}
                  onClick={run(() => fileTicket(slug, ticketId, folder.id))}
                >
                  {folder.name}
                </button>
              ))}
              {folderId && (
                <button
                  type="button"
                  role="menuitem"
                  className={item}
                  onClick={run(() => fileTicket(slug, ticketId, ""))}
                >
                  Back to inbox
                </button>
              )}
            </>
          );
        }}
      </Menu>
      <dialog
        ref={merge}
        aria-label="Merge into another conversation"
        className="bg-card text-foreground m-auto w-[min(30rem,94vw)] rounded-lg p-0 shadow-lg backdrop:bg-black/40"
      >
        <form action={mergeAction} className="flex flex-col gap-3 p-5">
          <h2 className="text-base font-bold">Merge into another conversation</h2>
          <p className="text-muted-foreground text-sm">
            For when someone writes twice about the same thing. Everything here moves across and
            this one closes.
          </p>
          {others.length > 0 && (
            <ul className="flex flex-col gap-1 text-sm">
              {others.map((other) => (
                <li key={other.number}>
                  <button
                    type="submit"
                    name="into"
                    value={other.number}
                    className="hover:bg-hover border-border w-full rounded-sm border px-2 py-1.5 text-left"
                  >
                    <span className="text-muted-foreground tabular-nums">#{other.number}</span>{" "}
                    <span className="font-read">{other.subject}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          <span className="flex items-end gap-2">
            <span className="flex flex-col gap-1">
              <Label htmlFor="merge-into">Or type its number</Label>
              <Input
                id="merge-into"
                name="into"
                inputMode="numeric"
                placeholder="#12"
                className="w-28"
              />
            </span>
            <SubmitButton variant="dark" size="default" pendingText="Merging…">
              Merge
            </SubmitButton>
            <Button type="button" variant="ghost" onClick={() => merge.current?.close()}>
              Cancel
            </Button>
          </span>
          <FormMessage>{merged.error}</FormMessage>
        </form>
      </dialog>
    </div>
  );
}

// ---- The rail's fields ------------------------------------------------------

const fieldSelect =
  "hover:bg-hover focus-visible:ring-ochre max-w-[11rem] min-w-0 cursor-pointer truncate rounded-sm bg-transparent py-1 pr-1 pl-2 text-right text-sm font-semibold outline-none focus-visible:ring-2";

/** One of the ticket's fields, changed in place. */
export function FieldSelect({
  slug,
  ticketId,
  field,
  value,
  options,
  canEdit,
}: {
  slug: string;
  ticketId: string;
  field: "assignee" | "priority" | "folder";
  value: string;
  options: Option[];
  canEdit: boolean;
}) {
  const [pending, start] = useTransition();
  const current = options.find((option) => option.value === value)?.label ?? "—";
  if (!canEdit) return <span className="text-sm font-semibold">{current}</span>;
  const label = { assignee: "Assignee", priority: "Priority", folder: "Folder" }[field];
  return (
    <select
      id={`rail-${field}`}
      aria-label={label}
      value={value}
      disabled={pending}
      onChange={(event) => {
        const next = event.target.value;
        start(() =>
          field === "assignee"
            ? assignTicket(slug, ticketId, next)
            : field === "priority"
              ? setTicketPriority(slug, ticketId, next)
              : fileTicket(slug, ticketId, next),
        );
      }}
      className={cn(fieldSelect, pending && "opacity-60")}
    >
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

/** Tags as chips: take one off, or find or make one. */
export function TagEditor({
  slug,
  ticketId,
  tags,
  known,
  canEdit,
}: {
  slug: string;
  ticketId: string;
  tags: string[];
  known: string[];
  canEdit: boolean;
}) {
  const [adding, setAdding] = useState(false);
  const [text, setText] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const save = (next: string[]) =>
    start(async () => {
      setProblem(await setTags(slug, ticketId, next));
    });
  const add = () => {
    const name = text.trim().toLowerCase();
    if (!name) return setAdding(false);
    if (!TAG_PATTERN.test(name)) {
      setProblem("Use letters, numbers, spaces and dashes.");
      return;
    }
    setText("");
    setAdding(false);
    if (!tags.includes(name)) save([...tags, name]);
  };
  return (
    <div className={cn("flex min-w-0 flex-col items-end gap-1", pending && "opacity-60")}>
      <span className="flex flex-wrap justify-end gap-1">
        {tags.map((tag) => (
          <span
            key={tag}
            className="bg-teal-soft text-teal-soft-ink flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold"
          >
            {tag}
            {canEdit && (
              <button
                type="button"
                aria-label={`Remove ${tag}`}
                onClick={() => save(tags.filter((t) => t !== tag))}
              >
                <X aria-hidden className="size-3" />
              </button>
            )}
          </span>
        ))}
        {canEdit && !adding && (
          <button
            id="rail-tag"
            type="button"
            onClick={() => setAdding(true)}
            className="border-border text-text-2 hover:bg-hover focus-visible:ring-ochre flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-semibold outline-none focus-visible:ring-2"
          >
            <Plus aria-hidden className="size-3" />
            Add tag
          </button>
        )}
        {!canEdit && tags.length === 0 && (
          <span className="text-muted-foreground text-sm">None</span>
        )}
      </span>
      {adding && (
        <span className="flex gap-1">
          <input
            autoFocus
            list="known-tags"
            value={text}
            maxLength={30}
            aria-label="Find or make a tag"
            placeholder="Find or make a tag"
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") add();
              if (event.key === "Escape") setAdding(false);
            }}
            className="border-input bg-card h-7 w-36 rounded-sm border px-1.5 text-xs outline-none"
          />
          <datalist id="known-tags">
            {known
              .filter((tag) => !tags.includes(tag))
              .map((tag) => (
                <option key={tag} value={tag} />
              ))}
          </datalist>
          <Button type="button" variant="outline" size="sm" onClick={add} className="h-7">
            Add
          </Button>
        </span>
      )}
      {problem && <p className="text-brick text-xs">{problem}</p>}
    </div>
  );
}

export function SummarizeButton({
  slug,
  ticketId,
  has,
}: {
  slug: string;
  ticketId: string;
  has: boolean;
}) {
  const [pending, start] = useTransition();
  const [problem, setProblem] = useState<string | null>(null);
  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        disabled={pending}
        onClick={() =>
          start(async () => {
            setProblem((await summarizeTicket(slug, ticketId)).error ?? null);
          })
        }
        className="-mr-1.5"
      >
        <Sparkles aria-hidden />
        {pending ? "Reading…" : has ? "Refresh" : "Summarize"}
      </Button>
      {problem && <p className="text-brick basis-full text-xs">{problem}</p>}
    </>
  );
}

export function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      aria-label={label}
      title={copied ? "Copied" : label}
      onClick={() =>
        void navigator.clipboard?.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        })
      }
      className="text-muted-foreground hover:text-foreground focus-visible:ring-ochre shrink-0 rounded-sm outline-none focus-visible:ring-2"
    >
      {copied ? (
        <Check aria-hidden className="size-3.5" />
      ) : (
        <Copy aria-hidden className="size-3.5" />
      )}
    </button>
  );
}

/** Drops an order's plain-text summary into the reply box, and returns to the conversation on a small screen. */
export function AddToReply({ text, closeHref }: { text: string; closeHref: string | null }) {
  const router = useRouter();
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={() => {
        window.dispatchEvent(new CustomEvent(INSERT_EVENT, { detail: text }));
        if (closeHref && !window.matchMedia("(min-width: 1280px)").matches) router.push(closeHref);
      }}
    >
      <Plus aria-hidden />
      Add to reply
    </Button>
  );
}
