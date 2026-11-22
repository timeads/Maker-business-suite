"use client";

import { Hash, Pencil, Plus, Trash2 } from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  useTransition,
} from "react";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import {
  appName,
  initials,
  layoutMessages,
  mentionsMe,
  nameOf,
  splitBody,
  timeLabel,
  type ChatMessage,
  type Person,
} from "@/lib/messages/format";
import { getBrowserClient } from "@/lib/supabase/browser";
import { cn } from "@/lib/utils";
import {
  createChannel,
  deleteMessage,
  editMessage,
  loadChanges,
  loadChat,
  loadMessages,
  markRead,
  openDm,
  sendMessage,
  setDisplayName,
  type Conversation,
} from "./actions";

type Thread = { messages: ChatMessage[]; more: boolean; loaded: boolean };
type Pending = { key: string; channelId: string; body: string };

const EMPTY: Thread = { messages: [], more: false, loaded: false };

function subscribeHash(onChange: () => void) {
  window.addEventListener("hashchange", onChange);
  return () => window.removeEventListener("hashchange", onChange);
}
const readHash = () => window.location.hash.slice(1);
const setHash = (value: string) => {
  window.location.hash = value;
};

function merge(existing: ChatMessage[], incoming: ChatMessage[]): ChatMessage[] {
  const byId = new Map(existing.map((m) => [m.id, m]));
  for (const message of incoming) byId.set(message.id, message);
  return [...byId.values()].sort((a, b) => a.id - b.id);
}

function Avatar({ name, tone }: { name: string; tone: "me" | "person" | "app" }) {
  return (
    <span
      aria-hidden
      className={cn(
        "flex size-7 shrink-0 items-center justify-center text-[11px] font-bold",
        tone === "app" ? "bg-teal text-on-teal rounded-sm" : "rounded-full",
        tone === "me" && "bg-ochre text-primary-foreground",
        tone === "person" && "bg-teal-soft text-teal-soft-ink",
      )}
    >
      {initials(name)}
    </span>
  );
}

export function ChatApp({
  slug,
  tenantId,
  timeZone,
  myId,
  canWrite,
  initialConversations,
  initialPeople,
  loadError,
  nowIso,
}: {
  slug: string;
  tenantId: string;
  timeZone: string;
  myId: string;
  canWrite: boolean;
  initialConversations: Conversation[];
  initialPeople: Person[];
  loadError: string | null;
  /** The server's clock when the page was made, so "Today" matches on both sides. */
  nowIso: string;
}) {
  const [conversations, setConversations] = useState(initialConversations);
  const [people, setPeople] = useState(initialPeople);
  const [threads, setThreads] = useState<Record<string, Thread>>({});
  const [pending, setPending] = useState<Pending[]>([]);
  const [online, setOnline] = useState<Set<string>>(new Set());
  const [live, setLive] = useState(false);
  const [clock, setClock] = useState(nowIso);
  const [notice, setNotice] = useState<string | null>(loadError);
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState<{ id: number; body: string } | null>(null);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [busy, startTransition] = useTransition();

  const hash = useSyncExternalStore(subscribeHash, readHash, () => "");
  const firstId = conversations[0]?.channel_id ?? "";
  // On a phone an empty address means "show the list"; on a wide screen the
  // first conversation is open by default.
  const activeId = conversations.some((c) => c.channel_id === hash) ? hash : "";
  const shownId = activeId || firstId;
  const shown = conversations.find((c) => c.channel_id === shownId);
  const thread = threads[shownId] ?? EMPTY;

  const personById = useMemo(() => new Map(people.map((p) => [p.user_id, p])), [people]);
  const titleOf = useCallback(
    (c: Conversation) => {
      if (c.kind === "channel") return c.name ?? "";
      if (!c.other_user_id) return `${nameOf(personById.get(myId))} (just you)`;
      return nameOf(personById.get(c.other_user_id));
    },
    [personById, myId],
  );

  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToEnd = useRef(true);
  const lastSync = useRef(nowIso);
  const threadsRef = useRef(threads);
  const shownRef = useRef(shownId);
  useEffect(() => {
    threadsRef.current = threads;
    shownRef.current = shownId;
  });

  const openConversation = (id: string) => {
    stickToEnd.current = true;
    setEditing(null);
    setHash(id);
  };

  /** Brings the list and the open conversation up to date. */
  const sync = useCallback(async () => {
    const since = lastSync.current;
    lastSync.current = new Date().toISOString();
    setClock(lastSync.current);
    const overview = await loadChat(slug);
    if (overview.ok) {
      setConversations(overview.conversations);
      setPeople(overview.people);
    }
    const id = shownRef.current;
    const current = threadsRef.current[id];
    if (!id || !current?.loaded) return;
    const lastId = current.messages[current.messages.length - 1]?.id ?? 0;
    const [fresh, changed] = await Promise.all([
      loadMessages(slug, id, { after: lastId }),
      loadChanges(slug, id, since),
    ]);
    const incoming = [...(fresh.ok ? fresh.messages : []), ...(changed.ok ? changed.messages : [])];
    if (incoming.length === 0) return;
    setThreads((all) => {
      const base = all[id] ?? EMPTY;
      return { ...all, [id]: { ...base, messages: merge(base.messages, incoming) } };
    });
  }, [slug]);

  // First page of whichever conversation is open.
  useEffect(() => {
    if (!shownId || threadsRef.current[shownId]?.loaded) return;
    let cancelled = false;
    void loadMessages(slug, shownId).then((result) => {
      if (cancelled) return;
      if (!result.ok) {
        setNotice(result.error);
        return;
      }
      setThreads((all) => ({
        ...all,
        [shownId]: { messages: result.messages, more: result.more, loaded: true },
      }));
    });
    return () => {
      cancelled = true;
    };
  }, [slug, shownId]);

  // Live updates: a nudge whenever a message is added or changed, who's
  // online, and a slow poll in case the live connection drops.
  useEffect(() => {
    let channel: ReturnType<ReturnType<typeof getBrowserClient>["channel"]> | null = null;
    try {
      const supabase = getBrowserClient();
      channel = supabase.channel(`chat:${tenantId}`, { config: { presence: { key: myId } } });
      channel
        .on(
          "postgres_changes",
          {
            event: "*",
            schema: "public",
            table: "chat_messages",
            filter: `tenant_id=eq.${tenantId}`,
          },
          () => void sync(),
        )
        .on("presence", { event: "sync" }, () => {
          setOnline(new Set(Object.keys(channel?.presenceState() ?? {})));
        })
        .subscribe((status) => {
          setLive(status === "SUBSCRIBED");
          if (status === "SUBSCRIBED") void channel?.track({ at: Date.now() });
        });
    } catch {
      // No live connection: the poll below still keeps things current.
    }
    const poll = window.setInterval(() => void sync(), 20_000);
    const onVisible = () => {
      if (document.visibilityState === "visible") void sync();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(poll);
      document.removeEventListener("visibilitychange", onVisible);
      if (channel) void getBrowserClient().removeChannel(channel);
    };
  }, [tenantId, myId, sync]);

  // Keep the newest message in view unless the reader has scrolled up.
  const newestId = thread.messages[thread.messages.length - 1]?.id ?? 0;
  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickToEnd.current) el.scrollTop = el.scrollHeight;
  }, [shownId, newestId, pending.length]);

  // Reading a conversation clears its unread count.
  useEffect(() => {
    if (!activeId && window.matchMedia("(max-width: 767px)").matches) return;
    if (!shownId || !newestId || document.visibilityState !== "visible") return;
    const timer = window.setTimeout(() => {
      void markRead(slug, shownId, newestId);
      setConversations((all) =>
        all.map((c) => (c.channel_id === shownId ? { ...c, unread: 0 } : c)),
      );
    }, 300);
    return () => window.clearTimeout(timer);
  }, [slug, shownId, activeId, newestId]);

  const totalUnread = conversations.reduce((sum, c) => sum + c.unread, 0);
  useEffect(() => {
    document.title = `${totalUnread > 0 ? `(${totalUnread}) ` : ""}Messages`;
  }, [totalUnread]);

  function send() {
    const body = draft.trim();
    if (!body || !shownId || !canWrite) return;
    const item: Pending = { key: `${Date.now()}-${Math.random()}`, channelId: shownId, body };
    stickToEnd.current = true;
    setPending((all) => [...all, item]);
    setDraft("");
    setNotice(null);
    void sendMessage(slug, shownId, body).then((result) => {
      setPending((all) => all.filter((p) => p.key !== item.key));
      if (!result.ok) {
        // Give the words back so nothing is lost.
        setNotice(result.error);
        setDraft((current) => current || body);
        return;
      }
      setThreads((all) => {
        const base = all[item.channelId] ?? EMPTY;
        return {
          ...all,
          [item.channelId]: { ...base, messages: merge(base.messages, [result.message]) },
        };
      });
    });
  }

  function loadEarlier() {
    const oldest = thread.messages[0]?.id;
    if (!oldest) return;
    const el = scrollRef.current;
    const before = el ? el.scrollHeight - el.scrollTop : 0;
    stickToEnd.current = false;
    startTransition(async () => {
      const result = await loadMessages(slug, shownId, { before: oldest });
      if (!result.ok) return;
      setThreads((all) => {
        const base = all[shownId] ?? EMPTY;
        return {
          ...all,
          [shownId]: {
            messages: merge(base.messages, result.messages),
            more: result.more,
            loaded: true,
          },
        };
      });
      requestAnimationFrame(() => {
        if (el) el.scrollTop = el.scrollHeight - before;
      });
    });
  }

  function saveEdit() {
    if (!editing) return;
    const { id, body } = editing;
    startTransition(async () => {
      const result = await editMessage(slug, id, body);
      if (!result.ok) {
        setNotice(result.error);
        return;
      }
      setEditing(null);
      await sync();
    });
  }

  function remove(id: number) {
    startTransition(async () => {
      const result = await deleteMessage(slug, id);
      if (!result.ok) setNotice(result.error);
      await sync();
    });
  }

  const channelDialog = useRef<HTMLDialogElement>(null);
  const dmDialog = useRef<HTMLDialogElement>(null);
  const nameDialog = useRef<HTMLDialogElement>(null);
  const openDialog = (ref: React.RefObject<HTMLDialogElement | null>) => {
    setDialogError(null);
    ref.current?.showModal();
  };

  function submitChannel(formData: FormData) {
    startTransition(async () => {
      const result = await createChannel(
        slug,
        String(formData.get("name") ?? ""),
        String(formData.get("topic") ?? ""),
      );
      if (!result.ok) {
        setDialogError(result.error);
        return;
      }
      channelDialog.current?.close();
      await sync();
      openConversation(result.channelId);
    });
  }

  function startDm(userId: string) {
    startTransition(async () => {
      const result = await openDm(slug, userId);
      if (!result.ok) {
        setDialogError(result.error);
        return;
      }
      dmDialog.current?.close();
      await sync();
      openConversation(result.channelId);
    });
  }

  function submitName(formData: FormData) {
    startTransition(async () => {
      const result = await setDisplayName(slug, String(formData.get("name") ?? ""));
      if (!result.ok) {
        setDialogError(result.error);
        return;
      }
      nameDialog.current?.close();
      await sync();
    });
  }

  const rows = layoutMessages(thread.messages, timeZone, new Date(clock));
  const me = personById.get(myId);
  const channels = conversations.filter((c) => c.kind === "channel");
  const dms = conversations.filter((c) => c.kind === "dm");
  const groupLabel =
    "text-muted-foreground flex items-center justify-between px-2.5 pt-4 pb-1 text-[10.5px] font-semibold tracking-[0.16em] uppercase";
  const sheet =
    "border-border bg-card text-foreground m-auto w-[min(26rem,calc(100vw-2rem))] rounded-2xl border p-5 shadow-lg backdrop:bg-teal/40";

  const listRow = (c: Conversation) => {
    const other = c.other_user_id ? personById.get(c.other_user_id) : undefined;
    return (
      <li key={c.channel_id}>
        <button
          type="button"
          onClick={() => openConversation(c.channel_id)}
          aria-current={c.channel_id === shownId ? "true" : undefined}
          className={cn(
            "focus-visible:ring-ochre flex w-full items-center gap-2 rounded-sm px-2.5 py-1.5 text-left text-sm outline-none focus-visible:ring-2",
            c.channel_id === shownId ? "bg-card md:shadow-xs" : "hover:bg-hover",
            c.unread > 0 && "font-bold",
          )}
        >
          {c.kind === "channel" ? (
            <Hash className="text-muted-foreground size-4 shrink-0" aria-hidden />
          ) : (
            <span
              className={cn(
                "size-2 shrink-0 rounded-full",
                c.other_user_id && online.has(c.other_user_id) ? "bg-mint-ink" : "bg-input",
              )}
              title={c.other_user_id && online.has(c.other_user_id) ? "Online" : "Away"}
            />
          )}
          <span className="min-w-0 flex-1 truncate">
            {c.kind === "channel" ? c.name : other ? nameOf(other) : titleOf(c)}
          </span>
          {c.unread > 0 && (
            <span className="bg-ochre text-primary-foreground rounded-full px-1.5 text-[11px] font-bold">
              {c.unread}
              <span className="sr-only"> unread</span>
            </span>
          )}
        </button>
      </li>
    );
  };

  return (
    <main className="flex h-dvh min-w-0 flex-1 pb-[57px] md:pb-0">
      {/* Conversation list */}
      <section
        aria-label="Conversations"
        className={cn(
          "border-border bg-panel flex w-full flex-col border-r md:w-[280px] md:shrink-0",
          activeId && "max-md:hidden",
        )}
      >
        <header className="flex items-center justify-between px-4 pt-5 pb-2">
          <h1 className="text-lg font-bold tracking-[-0.01em]">Messages</h1>
          <span
            className={cn("size-2 rounded-full", live ? "bg-mint-ink" : "bg-input")}
            title={live ? "Live" : "Reconnecting…"}
          />
        </header>
        <nav className="flex-1 overflow-y-auto px-1.5 pb-3">
          <p className={groupLabel}>
            Channels
            {canWrite && (
              <button
                type="button"
                onClick={() => openDialog(channelDialog)}
                className="hover:bg-hover rounded-sm p-1"
                aria-label="New channel"
              >
                <Plus className="size-3.5" aria-hidden />
              </button>
            )}
          </p>
          <ul>{channels.map(listRow)}</ul>
          <p className={groupLabel}>
            Direct messages
            {canWrite && (
              <button
                type="button"
                onClick={() => openDialog(dmDialog)}
                className="hover:bg-hover rounded-sm p-1"
                aria-label="New direct message"
              >
                <Plus className="size-3.5" aria-hidden />
              </button>
            )}
          </p>
          <ul>{dms.map(listRow)}</ul>
          {dms.length === 0 && (
            <p className="text-muted-foreground font-read px-2.5 py-1 text-sm">
              Message a teammate privately with the + above.
            </p>
          )}
        </nav>
        <footer className="border-border flex items-center gap-2 border-t px-3 py-2.5">
          <Avatar name={nameOf(me)} tone="me" />
          <span className="min-w-0 flex-1 truncate text-sm font-semibold">{nameOf(me)}</span>
          <button
            type="button"
            onClick={() => openDialog(nameDialog)}
            className="text-muted-foreground text-xs underline underline-offset-2"
          >
            Edit name
          </button>
        </footer>
      </section>

      {/* Message pane */}
      <section
        aria-label={shown ? titleOf(shown) : "Conversation"}
        className={cn("bg-card flex min-w-0 flex-1 flex-col", !activeId && "max-md:hidden")}
      >
        <header className="border-border flex items-center gap-3 border-b px-4 py-3">
          <button
            type="button"
            onClick={() => setHash("")}
            className="text-muted-foreground text-sm md:hidden"
          >
            ← Back
          </button>
          <div className="min-w-0">
            <h2 className="truncate text-[15.5px] font-bold">
              {shown?.kind === "channel" ? `# ${shown.name}` : shown ? titleOf(shown) : "Messages"}
            </h2>
            {shown?.topic && (
              <p className="text-muted-foreground truncate text-xs">{shown.topic}</p>
            )}
          </div>
        </header>

        <div
          ref={scrollRef}
          onScroll={(event) => {
            const el = event.currentTarget;
            stickToEnd.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
          }}
          className="flex-1 overflow-y-auto px-4 py-4"
        >
          <div className="mx-auto flex max-w-[820px] flex-col">
            {thread.more && (
              <Button
                variant="outline"
                size="sm"
                className="mb-3 self-center"
                onClick={loadEarlier}
                disabled={busy}
              >
                Show earlier messages
              </Button>
            )}
            {thread.loaded && thread.messages.length === 0 && pending.length === 0 && (
              <p className="text-muted-foreground font-read py-10 text-center text-sm">
                {shown?.name === "alerts"
                  ? "Heads-ups from your tools will show up here."
                  : "Nothing here yet. Say hello below."}
              </p>
            )}
            {rows.map((row) => {
              if (row.kind === "day") {
                return (
                  <div key={row.key} className="flex items-center gap-3 py-3" role="separator">
                    <span className="bg-border h-px flex-1" />
                    <span className="text-muted-foreground text-xs font-semibold">{row.label}</span>
                    <span className="bg-border h-px flex-1" />
                  </div>
                );
              }
              const m = row.message;
              const author = m.app ? appName(m.app) : nameOf(personById.get(m.author_id ?? ""));
              const mine = m.author_id === myId;
              const isEditing = editing?.id === m.id;
              return (
                <div
                  key={row.key}
                  className={cn(
                    "group hover:bg-hover relative -mx-2 flex gap-2.5 rounded-sm px-2",
                    row.head ? "mt-2 pt-1.5 pb-0.5" : "py-0.5",
                    !m.deleted_at && mentionsMe(m.body, people, myId) && "bg-ochre-soft/60",
                  )}
                >
                  <div className="w-7 shrink-0">
                    {row.head && (
                      <Avatar name={author} tone={m.app ? "app" : mine ? "me" : "person"} />
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    {row.head && (
                      <p className="flex items-baseline gap-2">
                        <span className="text-sm font-bold">{author}</span>
                        <time className="text-muted-foreground text-xs" dateTime={m.created_at}>
                          {timeLabel(m.created_at, timeZone)}
                        </time>
                      </p>
                    )}
                    {isEditing ? (
                      <div className="flex flex-col gap-1.5 py-1">
                        <textarea
                          autoFocus
                          rows={2}
                          maxLength={4000}
                          value={editing.body}
                          onChange={(e) => setEditing({ id: m.id, body: e.target.value })}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" && !e.shiftKey) {
                              e.preventDefault();
                              saveEdit();
                            }
                            if (e.key === "Escape") setEditing(null);
                          }}
                          aria-label="Edit message"
                          className="border-input bg-card focus-visible:border-ochre font-read w-full rounded-lg border px-3 py-2 text-[14.5px] outline-none"
                        />
                        <div className="flex gap-2">
                          <Button size="sm" onClick={saveEdit} disabled={busy}>
                            Save
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>
                            Cancel
                          </Button>
                        </div>
                      </div>
                    ) : m.deleted_at ? (
                      <p className="text-muted-foreground font-read text-[14.5px] italic">
                        Message deleted
                      </p>
                    ) : (
                      <p className="font-read text-[14.5px] leading-[1.55] break-words whitespace-pre-wrap">
                        {splitBody(m.body, people, myId).map((piece, i) =>
                          piece.kind === "link" ? (
                            <a
                              key={i}
                              href={piece.href}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-ochre-text underline underline-offset-2"
                            >
                              {piece.text}
                            </a>
                          ) : piece.kind === "mention" ? (
                            <span
                              key={i}
                              className={cn(
                                "rounded-sm px-0.5 font-semibold",
                                piece.me ? "bg-ochre-soft text-ochre-text" : "text-teal-soft-ink",
                              )}
                            >
                              {piece.text}
                            </span>
                          ) : (
                            piece.text
                          ),
                        )}
                        {m.edited_at && (
                          <span
                            className="text-muted-foreground ml-1 text-xs"
                            title={`Edited ${timeLabel(m.edited_at, timeZone)}`}
                          >
                            (edited)
                          </span>
                        )}
                      </p>
                    )}
                  </div>
                  {mine && canWrite && !m.deleted_at && !isEditing && (
                    <div className="border-border bg-card absolute top-0 right-2 hidden -translate-y-1/2 rounded-sm border shadow-xs group-focus-within:flex group-hover:flex">
                      <button
                        type="button"
                        onClick={() => setEditing({ id: m.id, body: m.body })}
                        className="hover:bg-hover p-1.5"
                        aria-label="Edit message"
                      >
                        <Pencil className="size-3.5" aria-hidden />
                      </button>
                      <button
                        type="button"
                        onClick={() => remove(m.id)}
                        className="text-brick hover:bg-brick-soft p-1.5"
                        aria-label="Delete message"
                      >
                        <Trash2 className="size-3.5" aria-hidden />
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
            {pending
              .filter((p) => p.channelId === shownId)
              .map((p) => (
                <div key={p.key} className="flex gap-2.5 px-0 py-0.5 opacity-60">
                  <div className="w-7 shrink-0" />
                  <p className="font-read text-[14.5px] leading-[1.55] break-words whitespace-pre-wrap">
                    {p.body}
                  </p>
                </div>
              ))}
          </div>
        </div>

        <footer className="px-4 pb-4">
          <div className="mx-auto max-w-[820px]">
            {notice && (
              <p
                role="alert"
                className="bg-brick-soft text-brick mb-2 rounded-lg px-3 py-2 text-sm"
              >
                {notice}
              </p>
            )}
            {canWrite ? (
              <>
                <label htmlFor="chat-composer" className="sr-only">
                  Message
                </label>
                <textarea
                  id="chat-composer"
                  rows={2}
                  maxLength={4000}
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                      e.preventDefault();
                      send();
                    }
                  }}
                  placeholder={
                    shown?.kind === "channel"
                      ? `Message #${shown.name}`
                      : shown
                        ? `Message ${titleOf(shown)}`
                        : "Write a message"
                  }
                  className="border-input bg-card focus-visible:border-ochre font-read w-full resize-none rounded-xl border px-3.5 py-2.5 text-base outline-none md:text-[14.5px]"
                />
                <p className="text-muted-foreground mt-1 text-xs">
                  Enter to send, Shift+Enter for a new line. @name to get someone&apos;s attention.
                </p>
              </>
            ) : (
              <p className="text-muted-foreground text-sm">
                This workspace is read-only, so new messages are switched off.
              </p>
            )}
          </div>
        </footer>
      </section>

      <dialog ref={channelDialog} className={sheet}>
        <form action={submitChannel} className="flex flex-col gap-3">
          <h2 className="text-lg font-bold">New channel</h2>
          <p className="text-muted-foreground font-read text-sm">
            Everyone in the workspace can see and post in a channel.
          </p>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="channel-name">Name</Label>
            <Input
              id="channel-name"
              name="name"
              maxLength={30}
              placeholder="new-products"
              required
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="channel-topic">What it&apos;s for (optional)</Label>
            <Input id="channel-topic" name="topic" maxLength={120} />
          </div>
          {dialogError && <p className="text-brick text-sm">{dialogError}</p>}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => channelDialog.current?.close()}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              Create channel
            </Button>
          </div>
        </form>
      </dialog>

      <dialog ref={dmDialog} className={sheet}>
        <div className="flex flex-col gap-3">
          <h2 className="text-lg font-bold">Message someone</h2>
          <ul className="flex max-h-72 flex-col overflow-y-auto">
            {people.map((p) => (
              <li key={p.user_id}>
                <button
                  type="button"
                  onClick={() => startDm(p.user_id)}
                  disabled={busy}
                  className="hover:bg-hover flex w-full items-center gap-2.5 rounded-sm px-2 py-2 text-left text-sm"
                >
                  <Avatar name={nameOf(p)} tone={p.user_id === myId ? "me" : "person"} />
                  <span className="min-w-0 flex-1 truncate">
                    {nameOf(p)}
                    {p.user_id === myId && " (just you)"}
                  </span>
                  {online.has(p.user_id) && (
                    <span className="text-mint-ink text-xs font-semibold">Online</span>
                  )}
                </button>
              </li>
            ))}
          </ul>
          {dialogError && <p className="text-brick text-sm">{dialogError}</p>}
          <Button
            type="button"
            variant="ghost"
            className="self-end"
            onClick={() => dmDialog.current?.close()}
          >
            Cancel
          </Button>
        </div>
      </dialog>

      <dialog ref={nameDialog} className={sheet}>
        <form action={submitName} className="flex flex-col gap-3">
          <h2 className="text-lg font-bold">Your name</h2>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="display-name">Shown next to your messages</Label>
            <Input id="display-name" name="name" maxLength={40} defaultValue={nameOf(me)} />
          </div>
          {dialogError && <p className="text-brick text-sm">{dialogError}</p>}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => nameDialog.current?.close()}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              Save name
            </Button>
          </div>
        </form>
      </dialog>
    </main>
  );
}
