import type { Metadata } from "next";
import { cookies } from "next/headers";
import Link from "next/link";
import {
  Activity,
  ChevronLeft,
  ExternalLink,
  Folder,
  Mail,
  MessageCircle,
  MessageSquare,
  Package,
  Paperclip,
  Search,
  Send,
  StickyNote,
  Truck,
  X,
} from "lucide-react";
import { PanelButton } from "@/components/shell/menu-panel";
import { PanelExtras } from "@/components/shell/nav-context";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { localDay } from "@/lib/bookings/slots";
import { formatMoney } from "@/lib/dashboard/format";
import {
  ACTIVITY_GROUPS,
  THREAD_EVENTS,
  buildActivity,
  describeEvent,
  isActivityGroup,
  type Names,
  type TicketEvent,
} from "@/lib/helpdesk/activity";
import { inboundDomain, supportAddress } from "@/lib/helpdesk/addresses";
import {
  HELPDESK_MODULE,
  TEMPLATES_KEY,
  fillTemplate,
  parseTemplates,
  type Priority,
} from "@/lib/helpdesk/config";
import { orderSummaryText } from "@/lib/helpdesk/customer";
import {
  SORTS,
  isSort,
  isUnread,
  listTotal,
  openedAgo,
  passesFilters,
  sortRows,
  timeAgo,
} from "@/lib/helpdesk/list";
import { isPicture } from "@/lib/helpdesk/files";
import { fileSize, replyAllCopies } from "@/lib/helpdesk/outbound";
import { parseRichDoc, type RichDoc } from "@/lib/helpdesk/rich";
import { loadRailTopics } from "@/lib/helpdesk/manual/match";
import { SAVED_VIEWS_KEY, matchesConditions, parseSavedViews } from "@/lib/helpdesk/saved-views";
import { DESK_SETTINGS_KEY, parseDeskSettings } from "@/lib/helpdesk/settings";
import {
  CHANNELS_KEY,
  CHANNEL_LABELS,
  TEXT_LIMITS,
  COMMENT_LIMITS,
  channelState,
  commentAbilities,
  commentState,
  isSocialChannel,
  parseChannelSettings,
  personLabel,
  profileUrl,
} from "@/lib/helpdesk/social/channels";
import {
  conversationWords,
  latestComment,
  postLink,
  privateReplyState,
  privateReplyWords,
} from "@/lib/helpdesk/social/comments";
import { connectionFacts } from "@/lib/helpdesk/social/server";
import { controlWords } from "@/lib/helpdesk/social/control";
import { lastInboundAt, replyWindow, windowWords } from "@/lib/helpdesk/social/window";
import { TAG_GROUPS_KEY, parseTagGroups } from "@/lib/helpdesk/tag-groups";
import { foldThread, placeInline, splitQuote } from "@/lib/helpdesk/thread";
import {
  PRIORITY_LABELS,
  SHELF_LABELS,
  STATUS_LABELS,
  VIEWS,
  byUrgency,
  inFolder,
  inView,
  isShelf,
  isSnoozed,
  parseView,
  snoozeChoices,
  viewParam,
  type Shelf,
} from "@/lib/helpdesk/views";
import type { OutboxRow } from "@/lib/helpdesk/outbox";
import { handlesFor, initials, nameOf, splitBody, type Person } from "@/lib/messages/format";
import {
  HELPDESK_FOLDERS_GROUP,
  HELPDESK_TAGS_GROUP,
  HELPDESK_VIEWS_GROUP,
  helpdeskFolderItems,
  helpdeskSavedViewItems,
  helpdeskTagItems,
} from "@/lib/nav/model";
import { loadStockForBought, type BoughtItemStock, type BoughtLine } from "@/lib/stock/restock";
import { createClient } from "@/lib/supabase/server";
import { canManage } from "@/lib/tenants";
import { cn } from "@/lib/utils";
import { HowWorkedOut } from "@/components/setup/how-worked-out";
import { AUTO_REPLIES_KEY, parseAutoReplies } from "@/lib/helpdesk/auto-reply/config";
import { autoReplyExplained, replyWindowExplained, viewExplained } from "@/lib/helpdesk/explain";
import { HELPDESK_TOOL, helpdeskSetupItems } from "@/lib/helpdesk/setup";
import { SETUP_CONFIG_KEYS, loadHelpdeskSetupFacts } from "@/lib/helpdesk/setup-data";
import { loadNotNow } from "@/lib/setup/data";
import { requiredItems, sortItems } from "@/lib/setup/items";
import { addTicketToManual } from "../(app)/helpdesk/manual/actions";
import { AskButton } from "../(app)/helpdesk/manual/editor";
import { MessageFiles, type ShownFile } from "./attachments";
import { AutoOpen, BulkBar, BulkBox, BulkProvider, ExportList, NewFolderDialog } from "./bulk";
import { Composer } from "./composer";
import { loadCustomerSide, type CustomerSide } from "./data";
import {
  AddToReply,
  CopyButton,
  EmptyTrash,
  DeskKeys,
  FieldSelect,
  ListTools,
  NewEmailTo,
  RailFrame,
  RailShell,
  RailToggle,
  SubjectEdit,
  SummarizeButton,
  TagEditor,
  TicketControls,
} from "./desk-tools";
import { helpdeskAccess } from "./gate";
import { DiscardEmpty, OutboxNotices, SendWatch } from "./send-watch";
import { CommentTools, ForgetPerson, KnownEmail } from "./social-tools";

export const metadata: Metadata = { title: "Help desk" };

type Contact = {
  id: string;
  email: string | null;
  name: string | null;
  handle: string | null;
  known_email: string | null;
};
type FileRow = {
  id: string;
  message_id: string;
  name: string;
  mime_type: string;
  bytes: number;
  content_id: string | null;
  state: string;
  reason: string | null;
};
type Row = {
  id: string;
  number: number;
  subject: string;
  status: "open" | "pending" | "closed";
  priority: Priority;
  assignee_id: string | null;
  snoozed_until: string | null;
  merged_into: string | null;
  folder_id: string | null;
  shelf: Shelf | null;
  /** "email", "instagram" or "facebook". */
  channel: string;
  /** "message", or "comment" for a conversation about a comment on a post. */
  kind: string;
  comment_post_id: string | null;
  /** The Instagram account or Facebook Page the customer wrote to. */
  social_account_id: string | null;
  last_message_at: string;
  created_at: string;
  contact_id: string;
  contacts: Contact | Contact[] | null;
  ticket_tags: { tags: { name: string } | { name: string }[] | null }[] | null;
};
type Facts = {
  ticket_id: string;
  message_count: number;
  preview: string | null;
  last_direction: string | null;
  last_inbound_at: string | null;
};
type Message = {
  id: string;
  direction: string;
  /** The automatic first reply: fixed words from Settings, sent by nobody in particular. */
  automatic: boolean | null;
  kind: string | null;
  from_email: string | null;
  from_name: string | null;
  body: string;
  /** Our own few words for a message that isn't only text ("Sent a photo"). */
  summary: string | null;
  /** When Meta says it was sent (messages on Instagram and Facebook). */
  sent_at: string | null;
  /** The customer took it back. */
  removed_at: string | null;
  /** A comment: changed by its author, hidden on the platform, and whether it has had its private message. */
  edited_at: string | null;
  hidden: boolean | null;
  private_reply: string | null;
  /** The comment it was written under, when it is a reply. */
  parent_external_id: string | null;
  /** Meta's id for it (a comment's id is what a reply is written under). */
  provider_message_id: string | null;
  created_at: string;
  author_id: string | null;
  to_emails: string[] | null;
  cc_emails: string[] | null;
  format: unknown;
  attachments: { name: string; size: number }[] | null;
};

const one = <T,>(value: T | T[] | null): T | null =>
  Array.isArray(value) ? (value[0] ?? null) : value;
const tagsOf = (row: Row) =>
  (row.ticket_tags ?? [])
    .map((tt) => one(tt.tags)?.name)
    .filter((name): name is string => Boolean(name));

const FIELDS =
  "id, number, subject, status, priority, assignee_id, snoozed_until, merged_into, folder_id, shelf, channel, kind, comment_post_id, social_account_id, last_message_at, created_at, contact_id, contacts(id, email, name, handle, known_email), ticket_tags(tags(name))";
const UUID = /^[0-9a-f-]{36}$/;
const heading = "text-[13px] font-bold tracking-[-0.005em]";
const card = "border-border border-b px-4 py-4";

/** Our own reply, drawn from its small document as React nodes. Never as HTML. */
function RichView({ doc }: { doc: RichDoc }) {
  const run = (
    r: RichDoc[number] extends infer B ? (B extends { runs: (infer R)[] } ? R : never) : never,
    i: number,
  ) => {
    let node: React.ReactNode = r.text;
    if (r.b) node = <strong>{node}</strong>;
    if (r.i) node = <em>{node}</em>;
    if (r.u) node = <u>{node}</u>;
    if (r.s) node = <s>{node}</s>;
    if (r.href) {
      node = (
        <a
          href={r.href}
          target="_blank"
          rel="noopener noreferrer"
          className="text-ochre-text underline"
        >
          {node}
        </a>
      );
    }
    return <span key={i}>{node}</span>;
  };
  return (
    <div className="font-read rich flex flex-col gap-2 text-sm break-words whitespace-pre-wrap">
      {doc.map((block, i) =>
        block.t === "p" ? (
          <p key={i}>{block.runs.map(run)}</p>
        ) : block.t === "ul" ? (
          <ul key={i} className="list-disc pl-5">
            {block.items.map((item, at) => (
              <li key={at}>{item.map(run)}</li>
            ))}
          </ul>
        ) : (
          <ol key={i} className="list-decimal pl-5">
            {block.items.map((item, at) => (
              <li key={at}>{item.map(run)}</li>
            ))}
          </ol>
        ),
      )}
    </div>
  );
}

export default async function HelpdeskPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const { slug } = await params;
  const query = await searchParams;
  const access = await helpdeskAccess(slug, `/w/${slug}/helpdesk`);
  if (!access.ok) {
    return (
      <main className="flex-1 px-4 pt-6 pb-24 md:px-8 md:pt-8">
        <div className="flex w-full flex-col gap-6">{access.upsell}</div>
      </main>
    );
  }
  const { tenant, user, entitlements, role } = access;
  const canWrite = entitlements.canWrite;
  const base = `/w/${tenant.slug}/helpdesk`;
  const choice = parseView(query.view);
  const view = viewParam(choice);
  const tag = (query.tag ?? "").trim().toLowerCase().slice(0, 30);
  const q = (query.q ?? "").trim().toLowerCase().slice(0, 80);
  const selected = /^\d{1,9}$/.test(query.t ?? "") ? Number(query.t) : null;
  const sort = isSort(query.sort) ? query.sort : null;
  const assignee =
    query.assignee === "me" || query.assignee === "none" || UUID.test(query.assignee ?? "")
      ? query.assignee
      : undefined;
  const priority = (["low", "normal", "high", "urgent"] as const).find((p) => p === query.priority);
  const unreadOnly = query.unread === "1";
  const channelFilter = (["email", "social", "instagram", "facebook"] as const).find(
    (c) => c === query.channel,
  );
  const kindFilter = (["message", "comment"] as const).find((k) => k === query.kind);
  const accountFilter = UUID.test(query.account ?? "") ? (query.account as string) : null;
  // "Show more": each step reads further back, up to a thousand conversations.
  const pages = /^[2-5]$/.test(query.n ?? "") ? Number(query.n) : 1;
  const side = query.side === "activity" || query.side === "details" ? query.side : null;
  const act = isActivityGroup(query.act) ? query.act : "all";
  const now = new Date();
  const nowMs = now.getTime();

  const supabase = await createClient();
  const shelfView = choice.kind === "built" && isShelf(choice.key) ? choice.key : null;
  const wantsClosed =
    (choice.kind === "built" && ["closed", "all", "mentions"].includes(choice.key)) ||
    choice.kind === "saved" ||
    Boolean(q);
  const [
    { data: live },
    { data: closed },
    { count: closedCount },
    { data: team },
    { data: folderRows },
    { data: deskConfigs },
    { data: readRows },
    { data: mentionRows },
    { data: found },
    { data: shelved },
    { count: spamCount },
    cookieJar,
    { data: metaRow },
  ] = await Promise.all([
    supabase
      .from("tickets")
      .select(FIELDS)
      .eq("tenant_id", tenant.id)
      .neq("status", "closed")
      .order("last_message_at", { ascending: false })
      // The database hands back a thousand rows at most in one go.
      .limit(Math.min(1000, 500 * pages)),
    wantsClosed
      ? supabase
          .from("tickets")
          .select(FIELDS)
          .eq("tenant_id", tenant.id)
          .eq("status", "closed")
          // Spam and the Trash are read only when someone is looking at them.
          .or("shelf.is.null,shelf.eq.archived")
          .order("last_message_at", { ascending: false })
          .limit(Math.min(1000, 250 * pages))
      : Promise.resolve({ data: [] }),
    supabase
      .from("tickets")
      .select("id", { count: "exact", head: true })
      .eq("tenant_id", tenant.id)
      .eq("status", "closed")
      .is("shelf", null)
      .is("merged_into", null),
    supabase.rpc("chat_people", { p_tenant_id: tenant.id }),
    supabase.from("ticket_folders").select("id, name").eq("tenant_id", tenant.id).order("name"),
    supabase
      .from("configs")
      .select("key, body")
      .eq("tenant_id", tenant.id)
      .eq("module", HELPDESK_MODULE)
      // The inbox's own settings, and the ones the Set up row's count looks at.
      .in("key", [
        ...new Set([SAVED_VIEWS_KEY, DESK_SETTINGS_KEY, TAG_GROUPS_KEY, ...SETUP_CONFIG_KEYS]),
      ]),
    // This person's own read marks, newest first.
    supabase
      .from("ticket_reads")
      .select("ticket_id, read_at")
      .eq("tenant_id", tenant.id)
      .order("read_at", { ascending: false })
      .limit(5000),
    supabase
      .from("ticket_notes")
      .select("ticket_id")
      .eq("tenant_id", tenant.id)
      .contains("mentions", [user.id])
      .limit(500),
    // A search also reads what was said, as this member.
    q.length >= 3
      ? supabase.rpc("search_ticket_messages", { p_tenant_id: tenant.id, p_q: q })
      : Promise.resolve({ data: [] }),
    shelfView
      ? supabase
          .from("tickets")
          .select(FIELDS)
          .eq("tenant_id", tenant.id)
          .eq("shelf", shelfView)
          .order("last_message_at", { ascending: false })
          .limit(Math.min(1000, 250 * pages))
      : Promise.resolve({ data: [] }),
    supabase
      .from("tickets")
      .select("id", { count: "exact", head: true })
      .eq("tenant_id", tenant.id)
      .eq("shelf", "spam"),
    cookies(),
    // The Facebook & Instagram connection, by the columns members may read.
    // Allowed to fail: without it, messages simply read as not connected.
    supabase
      .from("connections")
      .select("status, scopes, display_name, metadata")
      .eq("tenant_id", tenant.id)
      .eq("provider", "meta")
      .maybeSingle(),
  ]);
  // The workspace's Instagram accounts and Facebook Pages, to name and filter by.
  const { data: accountRows } = await supabase
    .from("social_accounts")
    .select("id, network, name, handle, active")
    .eq("tenant_id", tenant.id);
  const socialAccounts = (accountRows ?? []) as {
    id: string;
    network: string;
    name: string | null;
    handle: string | null;
    active: boolean;
  }[];
  const accountName = (id: string | null) => {
    const account = socialAccounts.find((a) => a.id === id);
    if (!account) return null;
    return account.handle ? `@${account.handle}` : (account.name ?? null);
  };
  /** Name the account only where there is more than one of its network to tell apart. */
  const accountNote = (row: Pick<Row, "channel" | "social_account_id">) =>
    socialAccounts.filter((a) => a.network === row.channel).length > 1
      ? accountName(row.social_account_id)
      : null;
  const people = (team ?? []) as Person[];
  const person = (id: string | null) => people.find((p) => p.user_id === id);
  const folders = (folderRows ?? []) as { id: string; name: string }[];
  const configOf = (key: string) =>
    ((deskConfigs ?? []) as { key: string; body: unknown }[]).find((row) => row.key === key)?.body;
  const savedViews = parseSavedViews(configOf(SAVED_VIEWS_KEY)).views;
  const deskSettings = parseDeskSettings(configOf(DESK_SETTINGS_KEY));
  const tagGroups = parseTagGroups(configOf(TAG_GROUPS_KEY)).groups;
  const channelSettings = parseChannelSettings(configOf(CHANNELS_KEY));
  const metaFacts = metaRow ? connectionFacts(metaRow as Record<string, unknown>) : null;
  // An Instagram account is "linked" when the workspace uses one, on any of its Pages.
  const usedInstagram = socialAccounts.find((a) => a.network === "instagram" && a.active);
  const metaConnection =
    metaFacts && usedInstagram ? { ...metaFacts, instagramId: usedInstagram.id } : metaFacts;
  const autoReplies = parseAutoReplies(configOf(AUTO_REPLIES_KEY));
  const commentsOn = channelSettings.instagram_comments || channelSettings.facebook_comments;
  const socialOn = channelSettings.instagram || channelSettings.facebook || commentsOn;
  const savedView = choice.kind === "saved" ? savedViews.find((v) => v.id === choice.id) : null;
  const folder = choice.kind === "folder" ? folders.find((f) => f.id === choice.id) : null;
  const readAt = new Map((readRows ?? []).map((r) => [r.ticket_id as string, r.read_at as string]));
  const mentioned = new Set((mentionRows ?? []).map((r) => r.ticket_id as string));
  const saidIn = new Set(((found ?? []) as unknown as (string | { id?: string })[]).map(String));
  const all = [
    ...new Map(
      [
        ...((live ?? []) as unknown as Row[]),
        ...((closed ?? []) as unknown as Row[]),
        ...((shelved ?? []) as unknown as Row[]),
      ].map((row) => [row.id, row]),
    ).values(),
  ];
  const facts = (row: Row) => ({ ...row, mentioned: mentioned.has(row.id) });
  const customerOf = (row: Row) => {
    const contact = one(row.contacts);
    return `${contact?.name ?? ""} ${contact?.email ?? ""} ${contact?.handle ? `@${contact.handle}` : ""}`;
  };
  /** Who a conversation is with, as the list and its header name them. */
  const whoOf = (row: Row) =>
    personLabel(isSocialChannel(row.channel) ? row.channel : "email", one(row.contacts));

  const inChoice = (row: Row): boolean => {
    if (choice.kind === "folder") return inFolder(row, choice.id);
    if (choice.kind === "saved") {
      if (!savedView) return false;
      return matchesConditions(
        { ...row, tags: tagsOf(row), customer: customerOf(row), unread: false },
        { ...savedView.conditions, unread: undefined },
        user.id,
        nowMs,
      );
    }
    return inView(facts(row), choice.key, user.id, nowMs);
  };
  const matchesSearch = (row: Row) => {
    if (!q) return true;
    if (saidIn.has(row.id)) return true;
    return [row.subject, customerOf(row), `#${row.number}`, ...tagsOf(row)]
      .join(" ")
      .toLowerCase()
      .includes(q);
  };
  // A search looks everywhere that isn't joined away, in Spam or in the Trash
  // (or only on the shelf you are looking at); otherwise the view decides.
  const searchable = (row: Row) =>
    !row.merged_into &&
    (shelfView ? row.shelf === shelfView : row.shelf !== "spam" && row.shelf !== "trash");
  const candidates = all
    .filter((row) => (q ? searchable(row) : inChoice(row)))
    .filter(matchesSearch)
    .slice(0, 300 * pages);
  const { data: factRows } =
    candidates.length > 0
      ? await supabase.rpc("ticket_list_facts", { p_ticket_ids: candidates.map((row) => row.id) })
      : { data: [] };
  const factOf = new Map(((factRows ?? []) as Facts[]).map((f) => [f.ticket_id, f]));
  const listRows = candidates.map((row) => {
    const fact = factOf.get(row.id);
    return {
      ...row,
      tags: tagsOf(row),
      last_inbound_at: fact?.last_inbound_at ?? null,
      preview: fact?.preview ?? "",
      messages: fact?.message_count ?? 0,
      unread: isUnread(fact?.last_inbound_at ?? null, readAt.get(row.id) ?? null, row.status),
    };
  });
  const wantUnread = unreadOnly || Boolean(savedView?.conditions.unread);
  const filtered = listRows.filter(
    (row) =>
      passesFilters(
        row,
        { tag, assignee, priority, unread: wantUnread, channel: channelFilter, kind: kindFilter },
        user.id,
      ) &&
      (!accountFilter || row.social_account_id === accountFilter),
  );
  const mixed =
    Boolean(q) ||
    choice.kind === "saved" ||
    (choice.kind === "built" && ["all", "mentions", "mine"].includes(choice.key));
  const ordered = sort
    ? sortRows(filtered, sort)
    : mixed || (choice.kind === "built" && choice.key === "closed")
      ? filtered
      : [...filtered].sort(byUrgency);
  const list = ordered.slice(0, 200 * pages);
  // More to show: the list was cut, or one of the reads came back full.
  const readFull =
    (live ?? []).length >= Math.min(1000, 500 * pages) ||
    (closed ?? []).length >= Math.min(1000, 250 * pages) ||
    (shelved ?? []).length >= Math.min(1000, 250 * pages);
  const more = ordered.length > list.length || candidates.length === 300 * pages || readFull;
  const allTags = [...new Set(all.flatMap(tagsOf))].sort().slice(0, 30);

  const counts: Record<string, number> = {};
  for (const v of VIEWS) {
    if (v.key === "all" || v.key === "archived" || v.key === "trash") continue;
    if (v.key === "spam") {
      counts["helpdesk.spam"] = spamCount ?? 0;
      continue;
    }
    counts[`helpdesk.${v.key}`] =
      v.key === "closed"
        ? (closedCount ?? 0)
        : all.filter((row) => inView(facts(row), v.key, user.id, nowMs)).length;
  }
  for (const f of folders)
    counts[`helpdesk.f.${f.id}`] = all.filter((row) => inFolder(row, f.id)).length;
  for (const v of savedViews) {
    // "Unread only" and closed conversations can't be counted from what the list has read.
    if (v.conditions.unread || ["closed", "any"].includes(v.conditions.status)) continue;
    counts[`helpdesk.v.${v.id}`] = all.filter((row) =>
      matchesConditions(
        { ...row, tags: tagsOf(row), customer: customerOf(row), unread: false },
        v.conditions,
        user.id,
        nowMs,
      ),
    ).length;
  }

  // The Set up row's count: what's still required, from the settings and
  // connection just read, plus "has an email come in?" and the shop's state.
  // Never stops the inbox drawing.
  counts["helpdesk.setup"] = await Promise.all([
    loadHelpdeskSetupFacts(supabase, tenant, {
      loaded: {
        configs: new Map(
          ((deskConfigs ?? []) as { key: string; body: unknown }[]).map((row) => [
            row.key,
            row.body,
          ]),
        ),
        meta: metaConnection,
      },
    }),
    loadNotNow(supabase, tenant.id, HELPDESK_TOOL),
  ])
    .then(
      ([setupFacts, notNow]) =>
        requiredItems(sortItems(helpdeskSetupItems(setupFacts), notNow).open).length,
    )
    .catch(() => 0);

  const kept = {
    view,
    tag,
    q,
    sort: sort ?? "",
    assignee: assignee ?? "",
    priority: priority ?? "",
    unread: unreadOnly ? "1" : "",
    channel: channelFilter ?? "",
    kind: kindFilter ?? "",
    account: accountFilter ?? "",
    n: pages > 1 ? String(pages) : "",
  };
  const href = (changes: Record<string, string | number | null>) => {
    const next = new URLSearchParams();
    const merged: Record<string, string | number | null> = {
      ...kept,
      t: selected,
      side,
      ...changes,
    };
    for (const [key, value] of Object.entries(merged)) {
      if (value !== null && value !== "" && !(key === "view" && value === "open")) {
        next.set(key, String(value));
      }
    }
    const text = next.toString();
    return text ? `${base}?${text}` : base;
  };
  const when = new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: tenant.timezone,
  });
  const day = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeZone: tenant.timezone });
  const domain = inboundDomain();
  const title = q
    ? "Search results"
    : choice.kind === "folder"
      ? (folder?.name ?? "Folder")
      : choice.kind === "saved"
        ? (savedView?.name ?? "View")
        : (VIEWS.find((v) => v.key === choice.key)?.label ?? "Help desk");

  // ---- The open conversation -------------------------------------------------
  const { data: ticketRow } = selected
    ? await supabase
        .from("tickets")
        .select(`${FIELDS}, ai_summary, ai_mood, ai_kind, ai_updated_at`)
        .eq("tenant_id", tenant.id)
        .eq("number", selected)
        .maybeSingle()
    : { data: null };
  const ticket = ticketRow as unknown as
    | (Row & {
        ai_summary: string | null;
        ai_mood: string | null;
        ai_kind: string | null;
        ai_updated_at: string | null;
      })
    | null;
  const contact = ticket ? one(ticket.contacts) : null;
  const [messages, notes, events, earlier, templateConfig, mergedTarget, customer] = ticket
    ? await Promise.all([
        supabase
          .from("messages")
          .select(
            "id, direction, automatic, kind, from_email, from_name, body, summary, sent_at, removed_at, edited_at, hidden, private_reply, parent_external_id, provider_message_id, created_at, author_id, to_emails, cc_emails, format, attachments",
          )
          .eq("tenant_id", tenant.id)
          .eq("ticket_id", ticket.id)
          .order("created_at"),
        supabase
          .from("ticket_notes")
          .select("id, author_id, body, created_at")
          .eq("tenant_id", tenant.id)
          .eq("ticket_id", ticket.id)
          .order("created_at"),
        supabase
          .from("ticket_events")
          .select("id, kind, detail, actor_id, created_at")
          .eq("tenant_id", tenant.id)
          .eq("ticket_id", ticket.id)
          .order("created_at")
          .limit(300),
        supabase
          .from("tickets")
          .select("id, number, subject, status, kind, last_message_at")
          .eq("tenant_id", tenant.id)
          .eq("contact_id", ticket.contact_id)
          .neq("id", ticket.id)
          .is("merged_into", null)
          .order("last_message_at", { ascending: false })
          .limit(6),
        supabase
          .from("configs")
          .select("body")
          .eq("tenant_id", tenant.id)
          .eq("module", HELPDESK_MODULE)
          .eq("key", TEMPLATES_KEY)
          .maybeSingle(),
        ticket.merged_into
          ? supabase.from("tickets").select("number").eq("id", ticket.merged_into).maybeSingle()
          : Promise.resolve({ data: null }),
        // The shop's side of the story. Trouble reading it never costs the conversation.
        // Someone who messaged is matched to the shop only by an email the
        // team wrote down for them. Never by a name.
        (contact?.email ?? contact?.known_email)
          ? loadCustomerSide(
              supabase,
              tenant.id,
              (contact?.email ?? contact?.known_email) as string,
            ).catch((): CustomerSide | null => null)
          : Promise.resolve(null),
      ])
    : [null, null, null, null, null, null, null];

  const thread = (messages?.data ?? []) as unknown as Message[];
  // The post a comment is on: its address and the start of its caption. Read on
  // its own and allowed to fail; the conversation is readable without it.
  const { data: postRow } =
    ticket?.kind === "comment" && ticket.comment_post_id
      ? await supabase
          .from("comment_posts")
          .select("permalink, excerpt, checked_at")
          .eq("tenant_id", tenant.id)
          .eq("id", ticket.comment_post_id)
          .maybeSingle()
      : { data: null };
  // Who was answering this person at Meta when we last heard. Read on its
  // own and allowed to fail: the conversation works without it.
  const { data: controlRow } =
    ticket && ticket.kind !== "comment" && isSocialChannel(ticket.channel) && ticket.contact_id
      ? await supabase
          .from("contacts")
          .select("thread_control, thread_control_app, thread_control_at")
          .eq("tenant_id", tenant.id)
          .eq("id", ticket.contact_id)
          .maybeSingle()
      : { data: null };
  // Topics from the manual that fit this conversation, found by its words.
  // Read on its own and allowed to fail.
  const railManual = ticket
    ? await loadRailTopics(supabase, tenant.id, ticket.subject, thread)
    : { name: "Manual", topics: [] };
  // The pictures and files on these messages. Read on its own, and allowed to
  // fail: a conversation is still readable without them.
  const { data: fileRows } =
    thread.length > 0
      ? await supabase
          .from("message_attachments")
          .select("id, message_id, name, mime_type, bytes, content_id, state, reason")
          .eq("tenant_id", tenant.id)
          .in(
            "message_id",
            thread.map((m) => m.id),
          )
          .order("created_at")
      : { data: [] };
  // Email waiting to go on this conversation, or that didn't go. Allowed to fail.
  const { data: outboxRows } = ticket
    ? await supabase.rpc("ticket_outbox", { p_ticket_id: ticket.id })
    : { data: [] };
  const outbox = (outboxRows ?? []) as OutboxRow[];
  const filesOf = new Map<string, FileRow[]>();
  for (const row of (fileRows ?? []) as FileRow[]) {
    filesOf.set(row.message_id, [...(filesOf.get(row.message_id) ?? []), row]);
  }
  const shown = (row: FileRow): ShownFile => ({
    id: row.id,
    name: row.name,
    type: row.mime_type,
    size: Number(row.bytes),
    kept: row.state === "kept",
    reason: row.reason,
  });
  // What a forward can carry: the conversation's kept files, newest first.
  const forwardFiles = ((fileRows ?? []) as FileRow[])
    .filter((row) => row.state === "kept")
    .reverse()
    .slice(0, 20)
    .map((row) => ({ id: row.id, name: row.name, size: Number(row.bytes) }));
  const lastMail = thread.filter((m) => m.direction === "inbound" && m.from_email).at(-1);
  const replyAllCc = replyAllCopies(
    lastMail ? { ...lastMail, from_email: lastMail.from_email as string } : null,
    {
      domain,
      addresses: [
        ...(domain ? [supportAddress(tenant.slug, domain)] : []),
        ...deskSettings.own_addresses,
      ],
    },
  );
  const eventRows = (events?.data ?? []) as TicketEvent[];
  const latestOrder = customer?.recent[0];
  // "When is this back?": for what they bought, what is on the shelf and what
  // is on its way. Read straight from Stock as this member, only where the
  // workspace has Stock; trouble reading it never costs the conversation.
  let boughtStock: BoughtItemStock[] = [];
  if (ticket && customer && entitlements.can("module.stock") && customer.recent.length > 0) {
    try {
      boughtStock = (
        await loadStockForBought(
          supabase,
          tenant,
          customer.recent.flatMap((order) => (order.order_lines as BoughtLine[] | null) ?? []),
          localDay(new Date(), tenant.timezone),
        )
      ).filter((item) => item.onHand <= 0 || item.incoming !== null);
    } catch {
      boughtStock = [];
    }
  }
  const firstName = contact?.name?.trim().split(/\s+/)[0] ?? null;
  const templates = parseTemplates(templateConfig?.data?.body).templates.map((template) => ({
    ...template,
    body: fillTemplate(template.body, {
      first_name: firstName ?? "there",
      name: contact?.name ?? "",
      email: contact?.email ?? contact?.known_email ?? "",
      workspace: tenant.name,
      my_name: nameOf(person(user.id)).split(/\s+/)[0],
      ...(latestOrder
        ? {
            order_number: latestOrder.name ?? "",
            order_date: new Intl.DateTimeFormat("en-US", {
              dateStyle: "long",
              timeZone: tenant.timezone,
            }).format(new Date(latestOrder.processed_at)),
            order_total: formatMoney(
              Number(latestOrder.total),
              latestOrder.currency ?? tenant.currency,
            ),
            order_status: (latestOrder.fulfillment_status ?? "not shipped yet")
              .toLowerCase()
              .replaceAll("_", " "),
          }
        : {}),
    }),
  }));
  const names: Names = {
    person: (id) => (id && person(id) ? nameOf(person(id)) : null),
    when: (instant) => when.format(new Date(instant)),
  };
  type Entry =
    | { kind: "message"; at: string; id: string; m: Message }
    | { kind: "note"; at: string; id: string; who: string; body: string }
    | { kind: "event"; at: string; id: string; text: string };
  const channel = ticket && isSocialChannel(ticket.channel) ? ticket.channel : null;
  const customerLabel = personLabel(channel ?? "email", contact);
  const entries: Entry[] = [
    ...thread.map((m): Entry =>
      m.kind === "reaction"
        ? // A reaction is a small line in the conversation, not a message to answer.
          { kind: "event", at: m.created_at, id: m.id, text: `${customerLabel} reacted ${m.body}` }
        : { kind: "message", at: m.created_at, id: m.id, m },
    ),
    ...(notes?.data ?? []).map((n): Entry => ({
      kind: "note",
      at: n.created_at as string,
      id: n.id as string,
      who: nameOf(person(n.author_id as string | null)),
      body: n.body as string,
    })),
    ...eventRows
      .filter((e) => THREAD_EVENTS.has(e.kind))
      .map((e): Entry => ({
        kind: "event",
        at: e.created_at,
        id: e.id,
        text: describeEvent(e, names),
      })),
  ].sort((a, b) => a.at.localeCompare(b.at));
  const folded = foldThread(entries);

  const index = ticket ? list.findIndex((row) => row.id === ticket.id) : -1;
  const neighbour = (offset: number) => {
    const row = index >= 0 ? list[index + offset] : undefined;
    return row ? href({ t: row.number, side: null }) : null;
  };
  const backHref = href({ t: null, side: null });
  // After closing: the next one, the list, or stay put (a setting).
  const afterHref =
    deskSettings.after_close === "list"
      ? backHref
      : deskSettings.after_close === "stay" && ticket
        ? href({ t: ticket.number })
        : (neighbour(1) ?? neighbour(-1) ?? backHref);
  const snoozedLabel =
    ticket && isSnoozed(ticket, nowMs) ? when.format(new Date(ticket.snoozed_until!)) : null;
  const choices = snoozeChoices(now, tenant.timezone);
  const canSend = Boolean(
    domain && process.env.POSTMARK_SERVER_TOKEN && process.env.SUPABASE_SECRET_KEY,
  );
  const canDraft = Boolean(process.env.ANTHROPIC_API_KEY && process.env.SUPABASE_SECRET_KEY);
  // An Instagram or Facebook conversation: Meta's limits and its 24-hour
  // reply window, worked out here from the customer's last message.
  const windowTime = new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
    timeZone: tenant.timezone,
  });
  const isComment = Boolean(channel && ticket?.kind === "comment");
  const socialState = channel
    ? isComment
      ? commentState(channel, channelSettings, metaConnection)
      : channelState(channel, channelSettings, metaConnection)
    : null;
  const socialWindow = channel
    ? replyWindow(lastInboundAt(thread), nowMs, { humanAgent: channelSettings.human_agent })
    : null;
  // A comment is answered under the customer's latest comment that still
  // stands: in public, or with the one private message Meta allows about it.
  const answering = isComment ? latestComment(thread) : null;
  const canComment = channel ? commentAbilities(channel, metaConnection?.scopes ?? null) : null;
  const privately =
    channel && isComment
      ? privateReplyState(
          answering
            ? {
                at: answering.sent_at ?? answering.created_at,
                privateReply: answering.private_reply,
              }
            : null,
          nowMs,
          Boolean(canComment?.privately),
        )
      : null;
  const postUrl = channel && postRow ? postLink(channel, postRow.permalink) : null;
  const commentReply =
    channel && isComment && socialState && privately && canComment
      ? {
          channel,
          name: CHANNEL_LABELS[channel],
          to: customerLabel,
          max: TEXT_LIMITS[channel].max,
          unit: TEXT_LIMITS[channel].unit,
          open: Boolean(answering),
          words: "There is no comment left here to answer: it was removed. Notes still work.",
          blocked: !(process.env.META_APP_SECRET && process.env.SUPABASE_SECRET_KEY)
            ? `${CHANNEL_LABELS[channel]} comments aren't switched on for this environment yet. Notes still work.`
            : socialState.state === "on"
              ? null
              : `${socialState.why ?? `${CHANNEL_LABELS[channel]} comments are switched off.`} See Settings → Help desk → Channels. Notes still work.`,
          comment: answering?.provider_message_id
            ? {
                commentId: answering.provider_message_id,
                public: {
                  ok: canComment.reply && !(channel === "instagram" && answering.hidden),
                  why: !canComment.reply
                    ? "Facebook didn't give permission to reply to comments. An owner or admin can allow it in Settings → Help desk → Channels."
                    : channel === "instagram" && answering.hidden
                      ? "Instagram doesn't allow a public reply to a hidden comment. Show it again first."
                      : null,
                  max: COMMENT_LIMITS[channel].max,
                },
                private: {
                  ok: privately.state === "available",
                  words: privateReplyWords(channel, privately.state, privately.until, (at) =>
                    windowTime.format(new Date(at)),
                  ),
                },
              }
            : null,
        }
      : null;
  const socialReply =
    commentReply ??
    (channel && socialState && socialWindow
      ? {
          channel,
          name: CHANNEL_LABELS[channel],
          to: customerLabel,
          max: TEXT_LIMITS[channel].max,
          unit: TEXT_LIMITS[channel].unit,
          open: socialWindow.open,
          words: windowWords(channel, socialWindow, (at) => windowTime.format(new Date(at))),
          control: controlWords(
            controlRow
              ? {
                  state: controlRow.thread_control as string | null,
                  appId: controlRow.thread_control_app as string | null,
                  at: controlRow.thread_control_at as string | null,
                }
              : null,
            channel,
            (at) => when.format(new Date(at)),
          ),
          blocked: !(process.env.META_APP_SECRET && process.env.SUPABASE_SECRET_KEY)
            ? `${CHANNEL_LABELS[channel]} messages aren't switched on for this environment yet. Notes still work.`
            : socialState.state === "on"
              ? null
              : `${socialState.why ?? `${CHANNEL_LABELS[channel]} messages are switched off.`} See Settings → Help desk → Channels. Notes still work.`,
        }
      : null);
  const editable = Boolean(ticket && canWrite && !ticket.merged_into);
  const ticketUnread =
    ticket &&
    isUnread(
      thread.filter((m) => m.direction === "inbound" && m.kind !== "reaction").at(-1)?.created_at ??
        null,
      readAt.get(ticket.id) ?? null,
      ticket.status,
    );
  const railClosed = cookieJar.get("mbs-desk-rail")?.value === "closed";
  const money = (value: number, currency?: string | null) =>
    formatMoney(value, currency ?? tenant.currency).replace(/\.00$/, "");
  const peopleOptions = people.map((p) => ({ value: p.user_id, label: nameOf(p) }));

  const avatar = (name: string, ours: boolean, size = "size-8 text-[11px]") => (
    <span
      aria-hidden
      className={cn(
        "flex shrink-0 items-center justify-center rounded-full font-bold",
        size,
        ours ? "bg-teal text-on-teal" : "bg-ochre-soft text-ochre-text",
      )}
    >
      {initials(name)}
    </span>
  );

  const drawEntry = (entry: Entry) => {
    if (entry.kind === "event") {
      return (
        <li key={entry.id} className="text-muted-foreground text-center text-xs">
          {entry.text} · {timeAgo(entry.at, nowMs)}
        </li>
      );
    }
    if (entry.kind === "note") {
      return (
        <li
          key={entry.id}
          className="bg-note border-note-border mx-auto w-full max-w-[64ch] rounded-lg border px-4 py-3"
        >
          <p className="text-muted-foreground mb-1 flex items-center gap-1.5 text-xs">
            <StickyNote aria-hidden className="size-3.5" />
            Internal note · {entry.who} · {when.format(new Date(entry.at))}
          </p>
          <p className="font-read text-sm break-words whitespace-pre-wrap">
            {splitBody(entry.body, people, user.id).map((piece, i) =>
              piece.kind === "mention" ? (
                <span key={i} className="text-ochre-text font-semibold">
                  {piece.text}
                </span>
              ) : (
                <span key={i}>{piece.text}</span>
              ),
            )}
          </p>
        </li>
      );
    }
    const m = entry.m;
    const ours = m.direction === "outbound";
    const who = ours
      ? m.automatic
        ? "Automatic reply"
        : m.author_id
          ? nameOf(person(m.author_id))
          : tenant.name
      : channel
        ? customerLabel
        : (m.from_name ?? m.from_email ?? "Unknown sender");
    // A reply sent from the Instagram or Facebook app itself, not from here.
    const fromApp = ours && !m.author_id && !m.automatic && channel ? m.from_name : null;
    const KIND_WORDS: Record<string, string> = {
      story_reply: "replied to your story",
      story_mention: "mentioned you in their story",
      share: "shared a post",
    };
    const isReply = m.kind === "comment" && !ours && Boolean(m.parent_external_id);
    const doc = ours ? parseRichDoc(m.format) : null;
    const text = ours ? { own: m.body, quoted: null } : splitQuote(m.body);
    const to =
      (m.to_emails ?? []).length > 0 ? (m.to_emails ?? []) : contact?.email ? [contact.email] : [];
    const files = filesOf.get(m.id) ?? [];
    const body = ours
      ? { pieces: [{ kind: "text" as const, text: text.own }], placed: new Set<string>() }
      : placeInline(
          text.own,
          files
            .filter((file) => file.state === "kept" && isPicture(file.mime_type))
            .map((file) => ({ id: file.id, contentId: file.content_id, name: file.name })),
        );
    const copied = ours ? [] : [...(m.to_emails ?? []), ...(m.cc_emails ?? [])];
    return (
      <li
        key={entry.id}
        className={cn(
          "w-full max-w-[76ch] rounded-lg border px-4 py-3.5 shadow-sm",
          ours ? "bg-out border-out-border ml-auto" : "bg-card border-border mr-auto",
        )}
      >
        <div className="mb-2.5 flex items-start gap-2.5">
          {avatar(who, ours)}
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm leading-tight font-bold">{who}</p>
            <p className="text-muted-foreground truncate text-xs">
              {channel && m.kind === "comment"
                ? ours
                  ? `Public reply on ${CHANNEL_LABELS[channel]} · everyone can see this${fromApp ? ` · sent from the ${fromApp}` : ""}`
                  : `${CHANNEL_LABELS[channel]} comment${isReply ? " · a reply under an earlier comment" : ""}`
                : channel && m.kind === "private_reply"
                  ? `Private ${CHANNEL_LABELS[channel]} message to ${customerLabel} about their comment`
                  : channel
                    ? ours
                      ? `${CHANNEL_LABELS[channel]} message to ${customerLabel}${fromApp ? ` · sent from the ${fromApp}` : ""}${m.automatic ? " · sent by itself, with your saved words" : ""}`
                      : `${CHANNEL_LABELS[channel]} message${KIND_WORDS[m.kind ?? ""] ? ` · ${KIND_WORDS[m.kind ?? ""]}` : ""}`
                    : ours
                      ? `${m.kind === "forward" ? "forwarded to" : "to"} ${to.join(", ")}${(m.cc_emails ?? []).length > 0 ? ` · cc ${(m.cc_emails ?? []).join(", ")}` : ""}${m.automatic ? " · sent by itself, with your saved words" : ""}`
                      : `${m.from_email ?? ""}${copied.length > 0 ? ` · also to ${copied.join(", ")}` : ""}`}
            </p>
          </div>
          <time className="text-muted-foreground shrink-0 text-xs" dateTime={m.created_at}>
            {when.format(new Date(m.created_at))}
          </time>
        </div>
        {/* Plain text only: customer email is never rendered as HTML. A picture set
            into the email is our own element, placed where the email's text marks it. */}
        {doc ? (
          <RichView doc={doc} />
        ) : (
          body.pieces.map((piece, i) =>
            piece.kind === "text" ? (
              <p key={i} className="font-read text-sm break-words whitespace-pre-wrap">
                {piece.text}
              </p>
            ) : (
              <MessageFiles
                key={i}
                inline
                files={files.filter((file) => file.id === piece.id).map(shown)}
              />
            ),
          )
        )}
        {m.kind === "comment" && !m.removed_at && (m.edited_at || m.hidden || m.private_reply) && (
          <p className="mt-1.5 flex flex-wrap gap-1.5">
            {m.edited_at && <Badge>Edited</Badge>}
            {m.private_reply === "sent" && <Badge tone="good">Private message sent</Badge>}
            {m.private_reply === "claimed" && (
              <Badge tone="waiting">Private message on its way</Badge>
            )}
            {m.hidden && (
              <Badge tone="waiting">
                Hidden on {channel ? CHANNEL_LABELS[channel] : "the post"}
              </Badge>
            )}
          </p>
        )}
        {m.removed_at && m.kind === "comment" ? (
          <p className="text-muted-foreground text-sm italic">
            This comment was removed from the post. Its words are gone here too.
          </p>
        ) : m.removed_at ? (
          <p className="text-muted-foreground text-sm italic">
            This message was removed by the person who sent it.
          </p>
        ) : !doc && body.pieces.length === 0 && m.summary ? (
          // Our own words for a message that isn't text; never the customer's.
          <p className="text-muted-foreground text-sm">{m.summary}</p>
        ) : (
          !doc &&
          body.pieces.length === 0 &&
          files.length > 0 && (
            <p className="text-muted-foreground text-xs">No words, just what&apos;s attached.</p>
          )
        )}
        {text.quoted && (
          <details className="mt-2">
            <summary className="text-muted-foreground hover:text-foreground w-fit cursor-pointer text-xs">
              Show the earlier email they quoted
            </summary>
            <p className="font-read text-muted-foreground border-border mt-1.5 border-l-2 pl-3 text-xs break-words whitespace-pre-wrap">
              {text.quoted}
            </p>
          </details>
        )}
        <MessageFiles files={files.filter((file) => !body.placed.has(file.id)).map(shown)} />
        {channel && m.kind === "comment" && !m.removed_at && canWrite && canComment?.moderate && (
          <CommentTools
            slug={tenant.slug}
            messageId={m.id}
            name={CHANNEL_LABELS[channel]}
            hidden={Boolean(m.hidden)}
            // Hiding is for a customer's comment; the team's own reply can only be deleted.
            canHide={!ours}
            canDelete={canManage(role)}
          />
        )}
        {/* Mail sent before files were kept: only their names were written down. */}
        {files.length === 0 && (m.attachments ?? []).length > 0 && (
          <ul className="mt-3 flex flex-wrap gap-1.5">
            {(m.attachments ?? []).map((file, i) => (
              <li
                key={i}
                className="border-border bg-card flex items-center gap-1.5 rounded-sm border px-2 py-1 text-xs"
              >
                <Paperclip aria-hidden className="text-muted-foreground size-3" />
                <span className="font-semibold">{file.name}</span>
                <span className="text-muted-foreground">{fileSize(Number(file.size))}</span>
              </li>
            ))}
          </ul>
        )}
      </li>
    );
  };

  return (
    <main className="relative flex h-dvh max-h-dvh min-w-0 flex-1 overflow-hidden pb-[57px] md:pb-0">
      <DeskKeys
        slug={tenant.slug}
        previous={neighbour(-1)}
        next={neighbour(1)}
        back={backHref}
        after={afterHref}
        ticket={ticket && editable ? { id: ticket.id, closed: ticket.status === "closed" } : null}
        me={user.id}
        unread={ticket && ticketUnread ? ticket.id : null}
        latest={entries.at(-1)?.id ?? null}
      />
      <SendWatch slug={tenant.slug} base={base} />
      {query.new === "folder" && canWrite && canManage(role) && (
        <NewFolderDialog slug={tenant.slug} base={base} />
      )}
      {!selected && !q && query.new !== "folder" && deskSettings.auto_open && list.length > 0 && (
        <AutoOpen href={href({ t: list[0].number, side: null })} />
      )}
      {/* The menu panel's counts, folders, views and tags: what the inbox has already read. */}
      <PanelExtras
        tool="helpdesk"
        counts={counts}
        items={{
          [HELPDESK_FOLDERS_GROUP]: helpdeskFolderItems(folders),
          [HELPDESK_VIEWS_GROUP]: helpdeskSavedViewItems(savedViews),
          [HELPDESK_TAGS_GROUP]: helpdeskTagItems(allTags),
        }}
      />

      {/* ---- The list ---- */}
      <BulkProvider>
        <section
          aria-label="Conversations"
          className={cn(
            "border-border bg-panel flex min-h-0 w-full shrink-0 flex-col border-r md:w-[300px] 2xl:w-[330px]",
            ticket && "max-md:hidden",
          )}
        >
          <header className="flex flex-wrap items-center gap-x-2 px-4 pt-3.5 pb-2">
            <PanelButton />
            <h1 className="min-w-0 truncate text-lg leading-tight font-bold tracking-[-0.015em]">
              {title}
            </h1>
            <span className="text-muted-foreground text-xs font-semibold tabular-nums">
              {listTotal(list.length, more)}
            </span>
            <ListTools
              slug={tenant.slug}
              base={base}
              params={Object.fromEntries(
                Object.entries({ ...kept, view: view === "open" ? "" : view }).filter(([, v]) => v),
              )}
              tags={allTags}
              people={peopleOptions.filter((p) => p.value !== user.id)}
              sorts={SORTS.filter((s) => s.key !== "newest").map((s) => ({
                value: s.key,
                label: s.label,
              }))}
              canWrite={canWrite}
              canSaveView={canWrite && canManage(role)}
              canSend={canSend}
              channels={socialOn}
              comments={commentsOn}
              accounts={socialAccounts
                .filter((a) => a.active || a.id === accountFilter)
                .map((a) => ({
                  value: a.id,
                  label: `${a.network === "instagram" ? "Instagram" : "Facebook"} · ${
                    a.handle ? `@${a.handle}` : (a.name ?? "account")
                  }`,
                }))}
              manageHref={`/w/${tenant.slug}/settings/helpdesk#folders`}
              extra={
                canManage(role) && canWrite ? (
                  <ExportList slug={tenant.slug} ids={list.map((row) => row.id)} />
                ) : null
              }
            />
          </header>
          <form className="relative px-4 pb-2.5" role="search" action={base}>
            {view !== "open" && <input type="hidden" name="view" value={view} />}
            <Search
              aria-hidden
              className="text-muted-foreground pointer-events-none absolute top-[9px] left-[26px] size-4"
            />
            <input
              id="desk-search"
              name="q"
              type="search"
              defaultValue={q}
              placeholder="Search tickets and messages"
              aria-label="Search tickets and messages"
              title="Names, emails, subjects, what was said, or #number"
              className="border-input bg-card focus-visible:border-ochre focus-visible:ring-ochre/25 h-[34px] w-full rounded-sm border pr-2 pl-8 text-sm outline-none focus-visible:ring-2"
            />
          </form>
          {tag && (
            <p className="flex px-4 pb-2">
              <Link
                href={href({ tag: null, t: null })}
                className="border-ochre bg-ochre-soft text-ochre-text flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-semibold"
              >
                Tagged {tag}
                <X aria-hidden className="size-3" />
                <span className="sr-only">: show every tag</span>
              </Link>
            </p>
          )}
          {shelfView && (
            <p className="text-muted-foreground flex flex-wrap items-center gap-x-2 gap-y-1 px-4 pb-2 text-xs">
              {shelfView === "trash"
                ? "Deleted conversations stay here until an owner or admin removes them for good."
                : shelfView === "spam"
                  ? "More mail on a conversation in Spam stays in Spam."
                  : "Archived conversations come back to the inbox if the customer writes again."}
              {shelfView === "trash" && canWrite && canManage(role) && list.length > 0 && (
                <EmptyTrash slug={tenant.slug} />
              )}
            </p>
          )}
          <ul className="border-border min-h-0 flex-1 overflow-y-auto border-t px-1.5 py-1.5">
            {list.length === 0 && (
              <li className="text-muted-foreground p-5 text-sm">
                {all.length === 0 && (closedCount ?? 0) === 0 ? (
                  domain ? (
                    <>
                      No conversations yet. Email sent to{" "}
                      <span className="bg-sunken rounded px-1 py-0.5 font-mono text-xs break-all">
                        {supportAddress(tenant.slug, domain)}
                      </span>{" "}
                      shows up here.
                    </>
                  ) : (
                    "Incoming email isn't switched on for this environment yet."
                  )
                ) : q ? (
                  `Nothing matches “${q}” in names, emails, subjects, what was said or ticket numbers.`
                ) : tag ||
                  assignee ||
                  priority ||
                  unreadOnly ||
                  channelFilter ||
                  kindFilter ||
                  accountFilter ? (
                  "No conversations match these filters."
                ) : choice.kind === "built" && choice.key === "social" ? (
                  "No Instagram or Facebook messages are waiting."
                ) : choice.kind === "built" &&
                  ["open", "mine", "unassigned"].includes(choice.key) ? (
                  "Inbox zero. Nothing needs a reply."
                ) : shelfView === "trash" ? (
                  "The Trash is empty."
                ) : shelfView === "spam" ? (
                  "No spam. Lovely."
                ) : shelfView === "archived" ? (
                  "Nothing has been archived yet."
                ) : (
                  "Nothing here."
                )}
              </li>
            )}
            {list.map((row) => {
              const who = one(row.contacts);
              const active = ticket?.id === row.id;
              const owner = person(row.assignee_id);
              const rowFolder = row.folder_id ? folders.find((f) => f.id === row.folder_id) : null;
              const showStatus = mixed || isSnoozed(row, nowMs);
              return (
                <li key={row.id} className="group relative">
                  {canWrite && (
                    <BulkBox
                      id={row.id}
                      label={`#${row.number} from ${who ? whoOf(row) : "an unknown sender"}`}
                    />
                  )}
                  <Link
                    href={href({ t: row.number, side: null })}
                    aria-current={active ? "true" : undefined}
                    className={cn(
                      "relative flex flex-col gap-0.5 rounded-md border py-2.5 pr-3 pl-6 transition-colors duration-150",
                      active
                        ? "bg-card border-border shadow-sm"
                        : "hover:bg-hover border-transparent",
                    )}
                  >
                    {row.unread && (
                      <span className="bg-ochre absolute top-[15px] left-2 size-2 rounded-full">
                        <span className="sr-only">Unread</span>
                      </span>
                    )}
                    <span className="flex items-baseline justify-between gap-2">
                      <span
                        className={cn(
                          "font-read truncate text-sm",
                          row.unread ? "font-bold" : "font-semibold",
                        )}
                      >
                        {whoOf(row)}
                      </span>
                      <time
                        dateTime={row.last_message_at}
                        title={when.format(new Date(row.last_message_at))}
                        className={cn(
                          "shrink-0 text-xs tabular-nums",
                          row.unread ? "text-ochre-text font-semibold" : "text-muted-foreground",
                        )}
                      >
                        {timeAgo(row.last_message_at, nowMs)}
                      </time>
                    </span>
                    <span className="text-foreground flex items-center gap-1.5 truncate text-[13px]">
                      {row.priority === "urgent" && <Badge tone="bad">Urgent</Badge>}
                      {row.priority === "high" && <Badge tone="waiting">High</Badge>}
                      <span className="truncate">{row.subject}</span>
                    </span>
                    {row.preview && (
                      <span className="font-read text-muted-foreground line-clamp-2 text-xs leading-snug">
                        {row.preview}
                      </span>
                    )}
                    <span className="flex flex-wrap items-center gap-1 pt-1">
                      {isSocialChannel(row.channel) && (
                        <span
                          className={cn(
                            "flex items-center gap-1 rounded-sm border px-1.5 py-0.5 text-[11px] font-semibold",
                            row.channel === "instagram"
                              ? "border-ochre bg-ochre-soft text-ochre-text"
                              : "border-border bg-teal-soft text-teal-soft-ink",
                          )}
                        >
                          <MessageCircle aria-hidden className="size-3" />
                          {conversationWords(row.channel, row.kind)}
                        </span>
                      )}
                      {rowFolder && choice.kind !== "folder" && (
                        <span className="border-border text-text-2 flex items-center gap-1 rounded-sm border px-1.5 py-0.5 text-[11px] font-semibold">
                          <Folder aria-hidden className="size-3" />
                          {rowFolder.name}
                        </span>
                      )}
                      {row.shelf && !shelfView ? (
                        <Badge>{SHELF_LABELS[row.shelf]}</Badge>
                      ) : row.shelf ? null : isSnoozed(row, nowMs) ? (
                        <Badge>Snoozed · {when.format(new Date(row.snoozed_until!))}</Badge>
                      ) : (
                        showStatus && (
                          <Badge
                            tone={
                              row.status === "open"
                                ? "open"
                                : row.status === "pending"
                                  ? "waiting"
                                  : "closed"
                            }
                          >
                            {STATUS_LABELS[row.status]}
                          </Badge>
                        )
                      )}
                      {owner ? (
                        <span
                          title={`Assigned to ${nameOf(owner)}`}
                          className="text-text-2 flex items-center gap-1 text-[11px] font-semibold"
                        >
                          {avatar(nameOf(owner), true, "size-[18px] text-[8px]")}
                          {nameOf(owner).split(/\s+/)[0]}
                        </span>
                      ) : (
                        row.status === "open" && <Badge tone="waiting">Unassigned</Badge>
                      )}
                      {row.tags.slice(0, 2).map((name) => (
                        <Badge key={name} tone="open">
                          {name}
                        </Badge>
                      ))}
                      {row.tags.length > 2 && <Badge>+{row.tags.length - 2}</Badge>}
                      {row.messages > 1 && (
                        <span
                          title={`${row.messages} messages`}
                          className="text-muted-foreground ml-auto flex items-center gap-1 text-[11px] tabular-nums"
                        >
                          <MessageSquare aria-hidden className="size-3" />
                          {row.messages}
                          <span className="sr-only"> messages</span>
                        </span>
                      )}
                    </span>
                  </Link>
                </li>
              );
            })}
            {more && (
              <li className="text-muted-foreground flex flex-wrap items-center gap-2 px-4 py-3 text-xs">
                Showing the first {list.length}.
                {pages < 5 ? (
                  <Link
                    href={href({ n: pages + 1 })}
                    scroll={false}
                    className="text-ochre-text font-semibold hover:underline"
                  >
                    Show more
                  </Link>
                ) : (
                  "Search or filter to find older ones."
                )}
              </li>
            )}
          </ul>
          {canWrite && (
            <BulkBar
              slug={tenant.slug}
              listIds={list.map((row) => row.id)}
              people={peopleOptions}
              folders={folders.map((f) => ({ value: f.id, label: f.name }))}
              snoozeChoices={choices}
              shelf={shelfView}
              closedView={choice.kind === "built" && choice.key === "closed"}
              canExport={canManage(role)}
            />
          )}
        </section>
      </BulkProvider>

      {/* ---- The conversation and its details ---- */}
      <RailFrame startClosed={railClosed}>
        <section
          aria-label="Conversation"
          className={cn(
            "bg-background flex min-h-0 min-w-0 flex-1 flex-col",
            !ticket && "max-md:hidden",
            side && "max-md:hidden",
          )}
        >
          {!ticket ? (
            <div className="text-muted-foreground flex flex-1 flex-col items-center justify-center gap-1 p-8 text-sm">
              <p className="text-foreground text-base font-semibold">
                {selected
                  ? "That conversation couldn't be found."
                  : list.length > 0
                    ? "Pick a conversation"
                    : "Nothing to answer"}
              </p>
              <p>
                Press{" "}
                <kbd className="border-border bg-card rounded border px-1.5 py-0.5 font-mono text-[11px]">
                  ?
                </kbd>{" "}
                for keyboard shortcuts.
              </p>
            </div>
          ) : (
            <>
              <header className="border-border bg-card flex flex-col gap-1.5 border-b px-4 py-3 md:px-6">
                <Link
                  href={backHref}
                  className="text-muted-foreground flex w-fit items-center gap-1 text-sm md:hidden"
                >
                  <ChevronLeft className="size-4" /> Conversations
                </Link>
                <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
                  <div className="min-w-0 flex-1 basis-56">
                    <SubjectEdit
                      key={ticket.subject}
                      slug={tenant.slug}
                      ticketId={ticket.id}
                      subject={ticket.subject}
                      canEdit={editable}
                    />
                    <p className="text-muted-foreground truncate text-[13px]">
                      #{ticket.number} · <span className="font-read">{customerLabel}</span> ·{" "}
                      {channel && (
                        <>
                          {CHANNEL_LABELS[channel]}
                          {accountNote(ticket) && <> to {accountNote(ticket)}</>} ·{" "}
                        </>
                      )}
                      <span title={when.format(new Date(ticket.created_at))}>
                        {openedAgo(ticket.created_at, nowMs)}
                      </span>
                    </p>
                  </div>
                  <div className="flex items-center gap-1.5">
                    {editable ? (
                      <TicketControls
                        slug={tenant.slug}
                        ticketId={ticket.id}
                        status={ticket.status}
                        statusLabel={STATUS_LABELS[ticket.status]}
                        snoozed={snoozedLabel}
                        folderId={ticket.folder_id}
                        shelf={ticket.shelf}
                        canDelete={canManage(role)}
                        assignedToMe={ticket.assignee_id === user.id}
                        me={user.id}
                        snoozeChoices={choices}
                        folders={folders}
                        after={afterHref}
                        back={backHref}
                        others={(earlier?.data ?? [])
                          // Only ones it could be joined with: comments and messages stay apart.
                          .filter(
                            (other) =>
                              other.status !== "closed" &&
                              ticket.kind !== "comment" &&
                              other.kind !== "comment",
                          )
                          .map((other) => ({
                            number: other.number as number,
                            subject: other.subject as string,
                          }))}
                      />
                    ) : (
                      <Badge
                        tone={
                          ticket.status === "open"
                            ? "open"
                            : ticket.status === "pending"
                              ? "waiting"
                              : "closed"
                        }
                      >
                        {STATUS_LABELS[ticket.status]}
                      </Badge>
                    )}
                    <RailToggle openHref={href({ side: "details" })} />
                  </div>
                </div>
              </header>

              <div
                id="desk-thread"
                className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 py-4 md:px-6"
              >
                {ticket.shelf && (
                  <p className="bg-sunken rounded-md px-4 py-3 text-sm">
                    {ticket.shelf === "spam"
                      ? "This conversation is in Spam. More mail on it stays there until someone marks it as not spam."
                      : ticket.shelf === "trash"
                        ? "This conversation is in the Trash. More mail on it stays there until someone restores it."
                        : "This conversation is archived. It comes back to the inbox if the customer writes again."}
                  </p>
                )}
                {ticket.merged_into && (
                  <p className="bg-sunken rounded-md px-4 py-3 text-sm">
                    This conversation was joined into{" "}
                    <Link
                      href={href({ view: "all", t: mergedTarget?.data?.number ?? null })}
                      className="text-ochre-text font-semibold hover:underline"
                    >
                      #{mergedTarget?.data?.number}
                    </Link>
                    .
                  </p>
                )}
                <ol className="flex flex-col gap-3">
                  {folded.head.map(drawEntry)}
                  {folded.hidden.length > 0 && (
                    <li>
                      <details className="group">
                        <summary className="border-border bg-card text-text-2 hover:bg-hover mx-auto flex w-fit cursor-pointer list-none items-center gap-2 rounded-full border px-3 py-1 text-xs font-semibold">
                          <span className="bg-sunken rounded-full px-1.5 tabular-nums">
                            {folded.hiddenMessages}
                          </span>
                          earlier message{folded.hiddenMessages === 1 ? "" : "s"}
                        </summary>
                        <ol className="mt-3 flex flex-col gap-3">{folded.hidden.map(drawEntry)}</ol>
                      </details>
                    </li>
                  )}
                  {folded.tail.map(drawEntry)}
                </ol>
                {entries.length === 0 && (
                  <div className="text-muted-foreground flex flex-col gap-2 text-sm">
                    <p>
                      Nothing has been sent on this conversation yet.
                      {channel ? "" : " Write the first email below."}
                    </p>
                    {editable && !outbox.some((row) => row.state !== "failed") && (
                      <DiscardEmpty slug={tenant.slug} ticketId={ticket.id} back={backHref} />
                    )}
                  </div>
                )}
                <OutboxNotices
                  slug={tenant.slug}
                  rows={outbox}
                  names={Object.fromEntries(people.map((p) => [p.user_id, nameOf(p)]))}
                />
              </div>
              {editable && (
                <div className="border-border shrink-0 border-t px-4 py-3 md:px-6">
                  <Composer
                    key={ticket.id}
                    slug={tenant.slug}
                    ticketId={ticket.id}
                    customerEmail={contact?.email ?? ""}
                    customerFirstName={firstName}
                    replyAllCc={replyAllCc}
                    afterClose={deskSettings.after_close}
                    team={people
                      .filter((p) => p.user_id !== user.id)
                      .map((p) => ({
                        id: p.user_id,
                        name: nameOf(p),
                        handle: handlesFor(p)[0] ?? "",
                      }))
                      .filter((p) => p.handle)}
                    forwardFiles={forwardFiles}
                    templates={templates}
                    manualName={railManual.name}
                    snoozeChoices={choices}
                    canDraft={canDraft}
                    canSend={channel ? true : canSend}
                    afterHref={afterHref}
                    social={socialReply}
                  />
                </div>
              )}
            </>
          )}
        </section>
        {ticket && <RailShell open={side !== null}>{rail()}</RailShell>}
      </RailFrame>
    </main>
  );

  function rail() {
    if (!ticket) return null;
    const tab = side === "activity" ? "activity" : "details";
    const row = (label: string, value: React.ReactNode) => (
      <div className="flex min-h-8 items-center justify-between gap-3">
        <dt className="text-muted-foreground shrink-0 text-[13px]">{label}</dt>
        <dd className="flex min-w-0 justify-end text-right text-sm">{value}</dd>
      </div>
    );
    const customerName = channel
      ? (contact?.name ?? customerLabel)
      : (contact?.name ?? contact?.email ?? "Customer");
    return (
      <>
        <div className="border-border flex shrink-0 items-center gap-4 border-b px-4">
          <Link
            href={href({ side: null })}
            className="text-muted-foreground -ml-1 flex items-center gap-0.5 py-2 text-sm xl:hidden"
          >
            <ChevronLeft aria-hidden className="size-4" />
            Back
          </Link>
          {(["details", "activity"] as const).map((key) => (
            <Link
              key={key}
              href={href({ side: key, act: null })}
              scroll={false}
              aria-current={tab === key ? "page" : undefined}
              className={cn(
                "-mb-px border-b-2 py-2.5 text-[13px] font-semibold capitalize",
                tab === key
                  ? "border-ochre text-foreground"
                  : "text-muted-foreground hover:text-foreground border-transparent",
              )}
            >
              {key}
            </Link>
          ))}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {tab === "activity" ? activity() : details(row, customerName)}
        </div>
      </>
    );
  }

  function activity() {
    if (!ticket) return null;
    const log = buildActivity(
      {
        createdAt: ticket.created_at,
        messages: thread,
        channelName: channel ? CHANNEL_LABELS[channel] : null,
        notes: (notes?.data ?? []) as { author_id: string | null; created_at: string }[],
        events: eventRows,
      },
      names,
    ).filter((entry) => act === "all" || entry.group === act);
    const icons = { mail: Mail, send: Send, note: StickyNote, activity: Activity };
    return (
      <section className={card}>
        <div className="mb-3 flex flex-wrap items-center gap-1">
          {ACTIVITY_GROUPS.map((group) => (
            <Link
              key={group.key}
              href={href({ side: "activity", act: group.key === "all" ? null : group.key })}
              scroll={false}
              aria-current={act === group.key ? "true" : undefined}
              className={cn(
                "rounded-full px-2.5 py-1 text-xs font-semibold",
                act === group.key ? "bg-teal text-on-teal" : "bg-sunken text-text-2 hover:bg-hover",
              )}
            >
              {group.label}
            </Link>
          ))}
        </div>
        <ol className="flex flex-col gap-3">
          {log.map((entry, i) => {
            const Icon = icons[entry.icon];
            return (
              <li key={i} className="flex gap-2.5 text-sm">
                <Icon aria-hidden className="text-muted-foreground mt-0.5 size-3.5 shrink-0" />
                <span className="min-w-0">
                  <span className="block">{entry.text}</span>
                  <time className="text-muted-foreground text-xs" dateTime={entry.at}>
                    {when.format(new Date(entry.at))}
                  </time>
                </span>
              </li>
            );
          })}
          {log.length === 0 && (
            <li className="text-muted-foreground text-sm">Nothing of that kind yet.</li>
          )}
        </ol>
      </section>
    );
  }

  function details(
    row: (label: string, value: React.ReactNode) => React.ReactNode,
    customerName: string,
  ) {
    if (!ticket) return null;
    const tiles = customer?.tiles;
    return (
      <>
        <section className={card}>
          <h3 className={cn(heading, "mb-1.5")}>Ticket</h3>
          <dl className="flex flex-col">
            {row(
              "Assignee",
              <FieldSelect
                slug={tenant.slug}
                ticketId={ticket.id}
                field="assignee"
                value={ticket.assignee_id ?? ""}
                options={[{ value: "", label: "Unassigned" }, ...peopleOptions]}
                canEdit={editable}
              />,
            )}
            {row(
              "Priority",
              <FieldSelect
                slug={tenant.slug}
                ticketId={ticket.id}
                field="priority"
                value={ticket.priority}
                options={(["urgent", "high", "normal", "low"] as const).map((p) => ({
                  value: p,
                  label: PRIORITY_LABELS[p],
                }))}
                canEdit={editable}
              />,
            )}
            {row(
              "Folder",
              <FieldSelect
                slug={tenant.slug}
                ticketId={ticket.id}
                field="folder"
                value={ticket.folder_id ?? ""}
                options={[
                  { value: "", label: "Inbox" },
                  ...folders.map((f) => ({ value: f.id, label: f.name })),
                ]}
                canEdit={editable}
              />,
            )}
            {row(
              "Status",
              <Badge
                tone={
                  ticket.status === "open"
                    ? "open"
                    : ticket.status === "pending"
                      ? "waiting"
                      : "closed"
                }
              >
                {ticket.shelf
                  ? SHELF_LABELS[ticket.shelf]
                  : snoozedLabel
                    ? "Snoozed"
                    : STATUS_LABELS[ticket.status]}
              </Badge>,
            )}
            {snoozedLabel && row("Back on", snoozedLabel)}
            {row("Created", when.format(new Date(ticket.created_at)))}
            {row("Last message", when.format(new Date(ticket.last_message_at)))}
            <div className="flex items-start justify-between gap-3 pt-1.5">
              <dt className="text-muted-foreground shrink-0 pt-0.5 text-[13px]">Tags</dt>
              <dd className="min-w-0">
                <TagEditor
                  slug={tenant.slug}
                  ticketId={ticket.id}
                  tags={tagsOf(ticket)}
                  known={allTags}
                  groups={tagGroups}
                  canEdit={editable}
                />
              </dd>
            </div>
          </dl>
          {/* Why it sits where it does, and what its channel allows: worked out from what is on screen. */}
          <div className="mt-2 flex flex-col gap-1">
            <HowWorkedOut
              label="Why it's where it is"
              lines={viewExplained(
                { ...ticket, mentioned: mentioned.has(ticket.id) },
                user.id,
                nowMs,
                (at) => when.format(new Date(at)),
                { folder: folders.find((f) => f.id === ticket.folder_id)?.name ?? null },
              )}
            />
            {channel && socialWindow && !isComment && (
              <HowWorkedOut
                label="How long you can reply"
                lines={replyWindowExplained(
                  channel,
                  socialWindow,
                  (at) => windowTime.format(new Date(at)),
                  channelSettings.human_agent,
                )}
              />
            )}
            <HowWorkedOut
              label="About the automatic reply"
              lines={autoReplyExplained(autoReplies, {
                channel: channel ?? "email",
                ticketKind: ticket.kind ?? "message",
                sent: thread.some((m) => m.automatic),
                firstInboundAt: thread.find((m) => m.direction === "inbound")?.created_at ?? null,
                timeZone: tenant.timezone,
              })}
              change={
                canManage(role)
                  ? {
                      href: `/w/${tenant.slug}/settings/helpdesk/auto-replies`,
                      label: "Automatic replies",
                    }
                  : null
              }
            />
          </div>
        </section>

        {(canDraft || ticket.ai_summary) && (
          <section className={card}>
            <div className="flex flex-wrap items-center justify-between gap-x-2">
              <h3 className={heading}>AI insights</h3>
              {canDraft && editable && (
                <SummarizeButton
                  slug={tenant.slug}
                  ticketId={ticket.id}
                  has={Boolean(ticket.ai_summary)}
                />
              )}
            </div>
            {ticket.ai_summary ? (
              <>
                <p className="mt-1.5 text-sm">{ticket.ai_summary}</p>
                <p className="mt-2 flex flex-wrap items-center gap-1.5">
                  {ticket.ai_mood && (
                    <Badge
                      tone={
                        ticket.ai_mood === "positive"
                          ? "good"
                          : ticket.ai_mood === "negative"
                            ? "bad"
                            : "closed"
                      }
                    >
                      {ticket.ai_mood[0].toUpperCase() + ticket.ai_mood.slice(1)}
                    </Badge>
                  )}
                  {ticket.ai_kind && <Badge>{ticket.ai_kind}</Badge>}
                  {ticket.ai_updated_at && (
                    <span className="text-muted-foreground text-xs">
                      updated {timeAgo(ticket.ai_updated_at, nowMs)}
                    </span>
                  )}
                </p>
              </>
            ) : (
              <p className="text-muted-foreground mt-1.5 text-[13px]">
                A short summary, the customer&apos;s mood and what kind of request this is. It
                counts against your plan&apos;s AI allowance.
              </p>
            )}
          </section>
        )}

        {(railManual.topics.length > 0 || (canDraft && editable && canManage(role))) && (
          <section className={card}>
            <div className="flex flex-wrap items-center justify-between gap-x-2">
              <h3 className={heading}>{railManual.name}</h3>
              <Link
                href={`/w/${tenant.slug}/helpdesk/manual`}
                className="text-muted-foreground text-xs hover:underline"
              >
                Open
              </Link>
            </div>
            {railManual.topics.length > 0 ? (
              <ul className="mt-1.5 flex flex-col gap-1.5">
                {railManual.topics.map((topic) => (
                  <li key={topic.id}>
                    <Link
                      href={`/w/${tenant.slug}/helpdesk/manual/${topic.id}`}
                      className="hover:bg-hover -mx-1.5 block rounded-sm px-1.5 py-1"
                    >
                      <span className="block text-sm font-semibold">{topic.title}</span>
                      {topic.summary && (
                        <span className="text-muted-foreground font-read line-clamp-2 text-xs">
                          {topic.summary}
                        </span>
                      )}
                    </Link>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-muted-foreground mt-1.5 text-[13px]">
                No published topic matches this one yet.
              </p>
            )}
            {canDraft &&
              editable &&
              canManage(role) &&
              thread.some((m) => m.direction === "outbound" && !m.automatic) && (
                <div className="mt-2">
                  <AskButton
                    action={addTicketToManual.bind(null, tenant.slug, ticket.id)}
                    label="Add this conversation"
                    pendingLabel="Asking…"
                    variant="ghost"
                    size="sm"
                  />
                </div>
              )}
          </section>
        )}

        <section className={card}>
          <div className="mb-2.5 flex items-center justify-between gap-2">
            <h3 className={heading}>Customer</h3>
            {customer?.customerUrl && (
              <a
                href={customer.customerUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-ochre-text flex items-center gap-1 text-xs font-semibold hover:underline"
              >
                View on {customer.shopName ?? "the shop"}
                <ExternalLink aria-hidden className="size-3" />
              </a>
            )}
          </div>
          <div className="flex items-center gap-3">
            {avatar(customerName, false, "size-10 text-sm")}
            <div className="min-w-0 flex-1">
              <p className="font-read truncate text-[15px] leading-tight font-bold">
                {customerName}
              </p>
              {contact?.email && (
                <p className="text-muted-foreground flex items-center gap-1.5 text-xs">
                  <span className="font-read truncate">{contact.email}</span>
                  <CopyButton text={contact.email} label="Copy email" />
                </p>
              )}
              {channel && (
                <p className="text-muted-foreground flex flex-wrap items-center gap-x-1.5 text-xs">
                  <span>{conversationWords(channel, ticket.kind)}</span>
                  {contact?.handle && <span className="font-read">· @{contact.handle}</span>}
                  {profileUrl(channel, contact?.handle) && (
                    // A plain link to their public profile. Nothing of it is loaded here.
                    <a
                      href={profileUrl(channel, contact?.handle)!}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-ochre-text flex items-center gap-0.5 font-semibold hover:underline"
                    >
                      profile
                      <ExternalLink aria-hidden className="size-3" />
                    </a>
                  )}
                </p>
              )}
              {customer?.phone && (
                <a
                  href={`tel:${customer.phone.replace(/[^\d+]/g, "")}`}
                  className="text-muted-foreground font-read block text-xs hover:underline"
                >
                  {customer.phone}
                </a>
              )}
            </div>
          </div>
          {tiles && tiles.orders > 0 && (
            <dl className="border-border divide-border mt-3 grid grid-cols-3 divide-x rounded-md border">
              {(
                [
                  [String(tiles.orders), tiles.orders === 1 ? "Order" : "Orders"],
                  [money(tiles.lifetime), "Lifetime"],
                  [tiles.last === null ? "—" : money(tiles.last), "Last order"],
                ] as const
              ).map(([value, label]) => (
                <div
                  key={label}
                  className="bg-card px-2.5 py-2 first:rounded-l-md last:rounded-r-md"
                >
                  <dd className="truncate text-sm font-bold tabular-nums">{value}</dd>
                  <dt className="text-muted-foreground text-[11px]">{label}</dt>
                </div>
              ))}
            </dl>
          )}
          {channel && contact && (
            <KnownEmail
              key={contact.known_email ?? ""}
              slug={tenant.slug}
              contactId={contact.id}
              email={contact.known_email}
              canEdit={canWrite}
              name={CHANNEL_LABELS[channel]}
            />
          )}
          {customer && !customer.known && (
            <p className="bg-sunken mt-3 rounded-md px-3 py-2 text-xs">
              {customer.shopName
                ? "Nobody in your shop uses this email. They may have ordered with a different address."
                : "Connect your shop to see this customer's orders here."}
            </p>
          )}
          {!customer && (contact?.email ?? contact?.known_email) && (
            <p className="bg-sunken mt-3 rounded-md px-3 py-2 text-xs">
              Their orders couldn&apos;t be read just now.
            </p>
          )}
          {canWrite && (contact?.email ?? contact?.known_email) && (
            <div className="mt-3">
              <NewEmailTo email={(contact?.email ?? contact?.known_email) as string} />
            </div>
          )}
          {channel && contact && canWrite && canManage(role) && (
            <ForgetPerson slug={tenant.slug} contactId={contact.id} back={backHref} />
          )}
        </section>

        {channel && isComment && (
          <section className={card}>
            <h3 className={cn(heading, "mb-2")}>The post</h3>
            {/* A few of the post's own words as plain text, and a plain link. Nothing of it is loaded here. */}
            {postRow?.excerpt ? (
              <p className="font-read text-sm break-words">{postRow.excerpt}</p>
            ) : (
              <p className="text-muted-foreground text-sm">
                {postRow?.checked_at
                  ? "This post has no caption, or it couldn't be read."
                  : "The post's caption hasn't been read yet."}
              </p>
            )}
            {postUrl && (
              <a
                href={postUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-ochre-text mt-2 flex w-fit items-center gap-1 text-sm font-semibold hover:underline"
              >
                Open the post on {CHANNEL_LABELS[channel]}
                <ExternalLink aria-hidden className="size-3" />
              </a>
            )}
            <p className="text-muted-foreground mt-2 text-xs">
              {(earlier?.data ?? []).some((other) => other.kind !== "comment")
                ? `${customerLabel} has also messaged you: see “Earlier conversations” below.`
                : `If ${customerLabel} answers a private message, it arrives as its own ${CHANNEL_LABELS[channel]} message conversation and is listed below.`}
            </p>
          </section>
        )}

        {customer && customer.tiles.orders > 0 && (
          <section className={card}>
            <h3 className={cn(heading, "mb-2.5 flex items-center gap-2")}>
              Orders
              <span className="text-muted-foreground font-semibold tabular-nums">
                {customer.tiles.orders}
              </span>
            </h3>
            <ul className="flex flex-col gap-2.5">
              {customer.cards.map((order, i) => (
                <li key={order.id}>
                  <details open={i === 0} className="bg-card border-border group rounded-md border">
                    <summary className="cursor-pointer list-none px-3 py-2.5">
                      <span className="flex items-baseline gap-2">
                        <span className="text-sm font-bold">{order.name}</span>
                        <span className="text-muted-foreground text-xs">
                          {day.format(new Date(order.placedAt))}
                        </span>
                        <span className="ml-auto text-sm font-bold tabular-nums">
                          {formatMoney(order.total, order.currency ?? tenant.currency)}
                        </span>
                      </span>
                      <span className="mt-1.5 flex flex-wrap gap-1">
                        {order.cancelled && <Badge tone="bad">Cancelled</Badge>}
                        {order.paid && <Badge tone={order.paid.tone}>{order.paid.label}</Badge>}
                        <Badge tone={order.fulfilment.tone}>{order.fulfilment.label}</Badge>
                      </span>
                    </summary>
                    <div className="border-border flex flex-col gap-3 border-t px-3 py-3">
                      <ul className="flex flex-col gap-2">
                        {order.lines.map((line, at) => (
                          <li key={at} className="flex items-center gap-2.5">
                            {line.photo ? (
                              // eslint-disable-next-line @next/next/no-img-element -- a small photo from the shop platform's own image servers
                              <img
                                src={line.photo}
                                alt=""
                                loading="lazy"
                                className="border-border size-9 shrink-0 rounded-sm border object-cover"
                              />
                            ) : (
                              <span className="bg-sunken text-muted-foreground flex size-9 shrink-0 items-center justify-center rounded-sm">
                                <Package aria-hidden className="size-4" />
                              </span>
                            )}
                            <span className="min-w-0 flex-1">
                              <span className="font-read block text-[13px] leading-snug">
                                {line.title}
                              </span>
                              {line.variant && (
                                <span className="text-muted-foreground block text-xs">
                                  {line.variant}
                                </span>
                              )}
                            </span>
                            <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
                              × {line.quantity}
                            </span>
                          </li>
                        ))}
                      </ul>
                      {order.tracking.length > 0 && (
                        <div>
                          <p className="text-muted-foreground mb-1 text-[11px] font-semibold">
                            Tracking
                          </p>
                          <ul className="flex flex-col gap-1">
                            {order.tracking.map((parcel) => (
                              <li
                                key={parcel.number}
                                className="flex flex-wrap items-center gap-1.5 text-xs"
                              >
                                <Badge tone="good">Sent</Badge>
                                {parcel.url ? (
                                  <a
                                    href={parcel.url}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="text-ochre-text font-mono break-all underline"
                                  >
                                    {parcel.carrier} {parcel.number}
                                  </a>
                                ) : (
                                  <span className="font-mono break-all">
                                    {parcel.carrier} {parcel.number}
                                  </span>
                                )}
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}
                      {order.shipTo && (
                        <div>
                          <p className="text-muted-foreground mb-1 text-[11px] font-semibold">
                            Ship to{order.shipTo.method ? ` · ${order.shipTo.method}` : ""}
                          </p>
                          <p className="font-read text-[13px] leading-snug whitespace-pre-line">
                            {order.shipTo.lines.join("\n")}
                          </p>
                        </div>
                      )}
                      {order.note && (
                        <p className="bg-note border-note-border font-read rounded-sm border px-2.5 py-1.5 text-xs whitespace-pre-wrap">
                          {order.note}
                        </p>
                      )}
                      <div className="flex flex-wrap items-center gap-1.5">
                        {editable && (
                          <AddToReply
                            text={orderSummaryText(order, day.format(new Date(order.placedAt)))}
                            closeHref={side ? href({ side: null }) : null}
                          />
                        )}
                        {order.toShipId && entitlements.can("module.shipping") && (
                          <Button asChild variant="dark" size="sm">
                            <Link href={`/w/${tenant.slug}/shipping/orders/${order.toShipId}`}>
                              <Truck aria-hidden />
                              Label
                            </Link>
                          </Button>
                        )}
                        {order.shopUrl && (
                          <a
                            href={order.shopUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            title={`Open ${order.name} in the shop`}
                            aria-label={`Open ${order.name} in the shop`}
                            className="text-text-2 hover:bg-hover flex size-[30px] items-center justify-center rounded-sm"
                          >
                            <ExternalLink aria-hidden className="size-4" />
                          </a>
                        )}
                      </div>
                    </div>
                  </details>
                </li>
              ))}
            </ul>
            {customer.tiles.orders > customer.cards.length && (
              <p className="text-muted-foreground mt-2 text-xs">
                The newest {customer.cards.length} of {customer.tiles.orders} are shown.
              </p>
            )}
          </section>
        )}

        {boughtStock.length > 0 && (
          <section className={card}>
            <h3 className={cn(heading, "mb-2")}>Back in stock?</h3>
            <ul className="flex flex-col gap-1.5 text-sm">
              {boughtStock.slice(0, 8).map((item) => (
                <li key={item.itemId}>
                  <Link
                    href={`/w/${tenant.slug}/stock/items/${item.itemId}`}
                    className="font-read hover:underline"
                  >
                    {item.name}
                  </Link>
                  <span
                    className={`block text-xs ${item.incoming?.late ? "text-brick" : "text-muted-foreground"}`}
                  >
                    {item.words}
                  </span>
                </li>
              ))}
            </ul>
            <p className="text-muted-foreground mt-1.5 text-xs">
              From Stock: things they bought that are sold out or have more on the way.
            </p>
          </section>
        )}

        {(earlier?.data ?? []).length > 0 && (
          <section className={card}>
            <h3 className={cn(heading, "mb-2")}>Earlier conversations</h3>
            {editable &&
              ticket.kind !== "comment" &&
              (earlier?.data ?? []).some(
                (other) => other.status !== "closed" && other.kind !== "comment",
              ) && (
                <p className="bg-teal-soft text-teal-soft-ink mb-2 rounded-md px-3 py-2 text-xs">
                  This customer has another open conversation. “Merge…” under the ⋯ menu joins them.
                </p>
              )}
            <ul className="flex flex-col gap-1.5 text-sm">
              {(earlier?.data ?? []).map((other) => (
                <li key={other.id}>
                  <Link
                    href={href({ view: "all", t: other.number as number, side: null })}
                    className="hover:underline"
                  >
                    <span className="text-muted-foreground tabular-nums">#{other.number}</span>{" "}
                    <span className="font-read">{other.subject}</span>
                  </Link>
                  <span className="text-muted-foreground block text-xs">
                    {STATUS_LABELS[other.status as keyof typeof STATUS_LABELS]} ·{" "}
                    {timeAgo(other.last_message_at as string, nowMs)}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}
      </>
    );
  }
}
