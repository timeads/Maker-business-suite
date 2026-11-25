import type { Metadata } from "next";
import Link from "next/link";
import { ChevronLeft, X } from "lucide-react";
import { PanelButton } from "@/components/shell/menu-panel";
import { PanelExtras } from "@/components/shell/nav-context";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { localDay } from "@/lib/bookings/slots";
import { formatMoney } from "@/lib/dashboard/format";
import { inboundDomain, supportAddress } from "@/lib/helpdesk/addresses";
import { loadStockForBought, type BoughtItemStock, type BoughtLine } from "@/lib/stock/restock";
import {
  HELPDESK_MODULE,
  TEMPLATES_KEY,
  fillTemplate,
  parseTemplates,
  type Priority,
} from "@/lib/helpdesk/config";
import {
  VIEWS,
  byUrgency,
  inView,
  isSnoozed,
  isView,
  snoozeChoices,
  type ViewKey,
} from "@/lib/helpdesk/views";
import { initials, nameOf, splitBody, type Person } from "@/lib/messages/format";
import { HELPDESK_TAGS_GROUP, helpdeskTagItems } from "@/lib/nav/model";
import { createClient } from "@/lib/supabase/server";
import { cn } from "@/lib/utils";
import { setTicketStatus } from "./actions";
import { helpdeskAccess } from "./gate";
import { TagsForm } from "./tags-form";
import { Composer, MergeForm, Shortcuts, TicketMenus } from "./ticket-tools";

export const metadata: Metadata = { title: "Help desk" };

type Contact = { email: string; name: string | null };
type Row = {
  id: string;
  number: number;
  subject: string;
  status: "open" | "pending" | "closed";
  priority: Priority;
  assignee_id: string | null;
  snoozed_until: string | null;
  merged_into: string | null;
  last_message_at: string;
  contact_id: string;
  contacts: Contact | Contact[] | null;
  ticket_tags: { tags: { name: string } | { name: string }[] | null }[] | null;
};

const one = <T,>(value: T | T[] | null): T | null =>
  Array.isArray(value) ? (value[0] ?? null) : value;
const tagsOf = (row: Row) =>
  (row.ticket_tags ?? [])
    .map((tt) => one(tt.tags)?.name)
    .filter((name): name is string => Boolean(name));

const FIELDS =
  "id, number, subject, status, priority, assignee_id, snoozed_until, merged_into, last_message_at, contact_id, contacts(email, name), ticket_tags(tags(name))";

export default async function HelpdeskPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ view?: string; tag?: string; q?: string; t?: string }>;
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
  const { tenant, user, entitlements } = access;
  const base = `/w/${tenant.slug}/helpdesk`;
  const view: ViewKey = isView(query.view) ? query.view : "open";
  const tag = (query.tag ?? "").trim().toLowerCase().slice(0, 30);
  const q = (query.q ?? "").trim().toLowerCase().slice(0, 80);
  const selected = /^\d{1,9}$/.test(query.t ?? "") ? Number(query.t) : null;
  const now = new Date();

  const supabase = await createClient();
  const [{ data: live }, { data: closed }, { count: closedCount }, { data: team }] =
    await Promise.all([
      supabase
        .from("tickets")
        .select(FIELDS)
        .eq("tenant_id", tenant.id)
        .neq("status", "closed")
        .order("last_message_at", { ascending: false })
        .limit(500),
      view === "closed" || view === "all" || q
        ? supabase
            .from("tickets")
            .select(FIELDS)
            .eq("tenant_id", tenant.id)
            .eq("status", "closed")
            .order("last_message_at", { ascending: false })
            .limit(150)
        : Promise.resolve({ data: [] }),
      supabase
        .from("tickets")
        .select("id", { count: "exact", head: true })
        .eq("tenant_id", tenant.id)
        .eq("status", "closed")
        .is("merged_into", null),
      supabase.rpc("chat_people", { p_tenant_id: tenant.id }),
    ]);
  const people = (team ?? []) as Person[];
  const person = (id: string | null) => people.find((p) => p.user_id === id);
  const all = [...((live ?? []) as unknown as Row[]), ...((closed ?? []) as unknown as Row[])];
  const counts = Object.fromEntries(
    VIEWS.map((v) => [
      v.key,
      v.key === "closed"
        ? (closedCount ?? 0)
        : v.key === "all"
          ? null
          : all.filter((row) => inView(row, v.key, user.id, now.getTime())).length,
    ]),
  ) as Record<ViewKey, number | null>;
  const matches = (row: Row) => {
    if (tag && !tagsOf(row).includes(tag)) return false;
    if (!q) return true;
    const contact = one(row.contacts);
    return [
      row.subject,
      contact?.name ?? "",
      contact?.email ?? "",
      `#${row.number}`,
      ...tagsOf(row),
    ]
      .join(" ")
      .toLowerCase()
      .includes(q);
  };
  const list = all
    .filter((row) => (q ? !row.merged_into : inView(row, view, user.id, now.getTime())))
    .filter(matches)
    .sort(view === "closed" || view === "all" || q ? () => 0 : byUrgency)
    .slice(0, 200);
  const allTags = [...new Set(all.flatMap(tagsOf))].sort().slice(0, 30);

  const href = (changes: Record<string, string | number | null>) => {
    const next = new URLSearchParams();
    const merged = { view, tag: tag || null, q: q || null, t: selected, ...changes };
    for (const [key, value] of Object.entries(merged)) {
      if (value !== null && value !== "" && !(key === "view" && value === "open")) {
        next.set(key, String(value));
      }
    }
    const text = next.toString();
    return text ? `${base}?${text}` : base;
  };
  const shortTime = (instant: string) => {
    const date = new Date(instant);
    const sameDay = localDay(date, tenant.timezone) === localDay(now, tenant.timezone);
    return new Intl.DateTimeFormat("en-US", {
      timeZone: tenant.timezone,
      ...(sameDay ? { hour: "numeric", minute: "2-digit" } : { month: "short", day: "numeric" }),
    }).format(date);
  };
  const when = new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: tenant.timezone,
  });
  const domain = inboundDomain();

  // ---- The open conversation -------------------------------------------------
  const { data: ticketRow } = selected
    ? await supabase
        .from("tickets")
        .select(FIELDS)
        .eq("tenant_id", tenant.id)
        .eq("number", selected)
        .maybeSingle()
    : { data: null };
  const ticket = ticketRow as unknown as Row | null;
  const contact = ticket ? one(ticket.contacts) : null;
  const [messages, notes, orders, earlier, templateConfig, mergedTarget] = ticket
    ? await Promise.all([
        supabase
          .from("messages")
          .select("id, direction, from_email, from_name, body, created_at, author_id")
          .eq("tenant_id", tenant.id)
          .eq("ticket_id", ticket.id)
          .order("created_at"),
        supabase
          .from("ticket_notes")
          .select("id, author_id, body, created_at")
          .eq("tenant_id", tenant.id)
          .eq("ticket_id", ticket.id)
          .order("created_at"),
        contact
          ? supabase
              .from("orders")
              .select(
                "id, name, processed_at, total, currency, financial_status, fulfillment_status, order_lines(title, quantity, sku, variant_title, product_external_id)",
              )
              .eq("tenant_id", tenant.id)
              .eq("email", contact.email)
              .order("processed_at", { ascending: false })
              .limit(5)
          : Promise.resolve({ data: [] }),
        supabase
          .from("tickets")
          .select("id, number, subject, status, last_message_at")
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
      ])
    : [null, null, null, null, null, null];

  const latestOrder = (orders?.data ?? [])[0];
  // "When is this back?": for what they bought, what is on the shelf and what
  // is on its way. Read straight from Stock as this member, only where the
  // workspace has Stock; trouble reading it never costs the conversation.
  let boughtStock: BoughtItemStock[] = [];
  if (ticket && entitlements.can("module.stock") && (orders?.data ?? []).length > 0) {
    try {
      boughtStock = (
        await loadStockForBought(
          supabase,
          tenant,
          (orders?.data ?? []).flatMap((order) => (order.order_lines as BoughtLine[] | null) ?? []),
          localDay(new Date(), tenant.timezone),
        )
      ).filter((item) => item.onHand <= 0 || item.incoming !== null);
    } catch {
      boughtStock = [];
    }
  }
  const templates = parseTemplates(templateConfig?.data?.body).templates.map((template) => ({
    ...template,
    body: fillTemplate(template.body, {
      first_name: contact?.name?.trim().split(/\s+/)[0] ?? "there",
      name: contact?.name ?? "",
      email: contact?.email ?? "",
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
  type Entry =
    | { kind: "message"; at: string; id: string; ours: boolean; who: string; body: string }
    | { kind: "note"; at: string; id: string; who: string; body: string };
  const thread: Entry[] = [
    ...(messages?.data ?? []).map((m): Entry => ({
      kind: "message",
      at: m.created_at as string,
      id: m.id as string,
      ours: m.direction === "outbound",
      who:
        m.direction === "outbound"
          ? m.author_id
            ? nameOf(person(m.author_id as string))
            : tenant.name
          : ((m.from_name as string | null) ?? (m.from_email as string)),
      body: m.body as string,
    })),
    ...(notes?.data ?? []).map((n): Entry => ({
      kind: "note",
      at: n.created_at as string,
      id: n.id as string,
      who: nameOf(person(n.author_id as string | null)),
      body: n.body as string,
    })),
  ].sort((a, b) => a.at.localeCompare(b.at));

  const index = ticket ? list.findIndex((row) => row.id === ticket.id) : -1;
  const neighbour = (offset: number) => {
    const row = index >= 0 ? list[index + offset] : undefined;
    return row ? href({ t: row.number }) : null;
  };
  const snoozedLabel =
    ticket && isSnoozed(ticket, now.getTime()) ? shortTime(ticket.snoozed_until!) : null;
  const canSend = Boolean(
    domain && process.env.POSTMARK_SERVER_TOKEN && process.env.SUPABASE_SECRET_KEY,
  );
  const canDraft = Boolean(process.env.ANTHROPIC_API_KEY && process.env.SUPABASE_SECRET_KEY);
  const day = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeZone: tenant.timezone });

  return (
    <main className="flex h-dvh min-w-0 flex-1 overflow-hidden pb-[57px] md:pb-0">
      {/* ---- Folders and the list ---- */}
      <section
        aria-label="Conversations"
        className={cn(
          "border-border bg-panel flex min-h-0 w-full shrink-0 flex-col border-r md:w-[340px]",
          ticket && "max-md:hidden",
        )}
      >
        {/* The folders and tags live in the help desk's menu panel; the inbox tells it what it counted. */}
        <PanelExtras
          tool="helpdesk"
          counts={Object.fromEntries(
            VIEWS.filter((v) => counts[v.key] !== null).map((v) => [
              `helpdesk.${v.key}`,
              counts[v.key] ?? 0,
            ]),
          )}
          items={{ [HELPDESK_TAGS_GROUP]: helpdeskTagItems(allTags) }}
        />
        <header className="flex items-center gap-2.5 px-4 pt-4 pb-2">
          <PanelButton />
          <h1 className="min-w-0 truncate text-xl leading-tight font-bold tracking-[-0.015em]">
            {q ? "Search results" : (VIEWS.find((v) => v.key === view)?.label ?? "Help desk")}
          </h1>
        </header>
        <form className="px-4 pb-2" role="search" action={base}>
          {view !== "open" && <input type="hidden" name="view" value={view} />}
          <Input
            name="q"
            type="search"
            defaultValue={q}
            placeholder="Search name, subject, #number"
            aria-label="Search conversations"
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
        <ul className="border-border bg-card min-h-0 flex-1 overflow-y-auto border-t">
          {list.length === 0 && (
            <li className="text-muted-foreground p-6 text-sm">
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
                "Nothing matches that search."
              ) : view === "open" ? (
                "All caught up. Nothing needs a reply."
              ) : (
                "Nothing here."
              )}
            </li>
          )}
          {list.map((row) => {
            const who = one(row.contacts);
            const active = ticket?.id === row.id;
            const owner = person(row.assignee_id);
            return (
              <li key={row.id} className="border-border border-b">
                <Link
                  href={href({ t: row.number })}
                  aria-current={active ? "true" : undefined}
                  className={cn(
                    "flex flex-col gap-0.5 border-l-[3px] px-4 py-2.5 transition-colors duration-150",
                    active ? "border-ochre bg-ochre-soft/50" : "hover:bg-hover border-transparent",
                  )}
                >
                  <span className="flex items-baseline justify-between gap-2">
                    <span className="font-read truncate text-sm font-semibold">
                      {who?.name ?? who?.email ?? "Unknown sender"}
                    </span>
                    <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
                      {shortTime(row.last_message_at)}
                    </span>
                  </span>
                  <span className="text-text-2 truncate text-sm">{row.subject}</span>
                  <span className="flex flex-wrap items-center gap-1 pt-0.5">
                    {row.priority === "urgent" && <Badge tone="bad">Urgent</Badge>}
                    {row.priority === "high" && <Badge tone="waiting">High</Badge>}
                    {isSnoozed(row, now.getTime()) && <Badge>Snoozed</Badge>}
                    {tagsOf(row)
                      .slice(0, 3)
                      .map((name) => (
                        <Badge key={name} tone="open">
                          {name}
                        </Badge>
                      ))}
                    {owner && (
                      <span
                        title={`${nameOf(owner)} has this`}
                        className="bg-teal ml-auto flex size-5 items-center justify-center rounded-full text-[9px] font-bold text-white"
                      >
                        {initials(nameOf(owner))}
                      </span>
                    )}
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
        <p className="text-muted-foreground hidden px-4 py-2 text-[11px] md:block">
          Keys: j / k next and previous · r reply · n note · e close
        </p>
      </section>

      {/* ---- The conversation ---- */}
      <section
        aria-label="Conversation"
        className={cn(
          "bg-background flex min-h-0 min-w-0 flex-1 flex-col",
          !ticket && "max-md:hidden",
        )}
      >
        {!ticket ? (
          <div className="text-muted-foreground flex flex-1 items-center justify-center p-8 text-sm">
            {selected ? "That conversation couldn't be found." : "Pick a conversation to read it."}
          </div>
        ) : (
          <>
            <Shortcuts
              previous={neighbour(-1)}
              next={neighbour(1)}
              back={href({ t: null })}
              closeFormId={
                entitlements.canWrite && ticket.status !== "closed" ? "close-form" : null
              }
            />
            <header className="border-border bg-card flex flex-col gap-2 border-b px-4 py-3 md:px-6">
              <Link
                href={href({ t: null })}
                className="text-muted-foreground flex w-fit items-center gap-1 text-sm md:hidden"
              >
                <ChevronLeft className="size-4" /> Conversations
              </Link>
              <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
                <div className="min-w-0">
                  <h2 className="font-read text-lg leading-snug font-semibold text-balance">
                    {ticket.subject}
                  </h2>
                  <p className="text-muted-foreground flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
                    #{ticket.number} · {contact?.name ? `${contact.name} · ` : ""}
                    {contact?.email}
                    {ticket.status === "open" && <Badge tone="open">Needs a reply</Badge>}
                    {ticket.status === "pending" && (
                      <Badge tone="waiting">Waiting on customer</Badge>
                    )}
                    {ticket.status === "closed" && <Badge>Closed</Badge>}
                  </p>
                </div>
                {entitlements.canWrite && !ticket.merged_into && (
                  <form id="close-form" action={setTicketStatus.bind(null, tenant.slug, ticket.id)}>
                    <input
                      type="hidden"
                      name="status"
                      value={ticket.status === "closed" ? "open" : "closed"}
                    />
                    <Button type="submit" variant="outline" size="sm">
                      {ticket.status === "closed" ? "Reopen" : "Close"}
                    </Button>
                  </form>
                )}
              </div>
              {entitlements.canWrite && !ticket.merged_into && (
                <TicketMenus
                  slug={tenant.slug}
                  ticketId={ticket.id}
                  assignee={ticket.assignee_id}
                  priority={ticket.priority}
                  snoozed={snoozedLabel}
                  people={people.map((p) => ({ id: p.user_id, name: nameOf(p) }))}
                  snoozeChoices={snoozeChoices(now, tenant.timezone)}
                />
              )}
            </header>

            <div className="flex min-h-0 flex-1">
              <div className="flex min-w-0 flex-1 flex-col gap-4 overflow-y-auto px-4 py-4 md:px-6">
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
                  {thread.map((entry) =>
                    entry.kind === "note" ? (
                      <li
                        key={entry.id}
                        className="bg-note border-note-border mx-auto w-full max-w-[60ch] rounded-lg border px-4 py-3"
                      >
                        <p className="text-muted-foreground mb-1 text-xs">
                          Note from {entry.who} · {when.format(new Date(entry.at))}
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
                    ) : (
                      <li
                        key={entry.id}
                        className={cn(
                          "max-w-[72ch] rounded-lg border px-4 py-3",
                          entry.ours
                            ? "bg-out border-out-border ml-auto"
                            : "bg-card border-border mr-auto",
                        )}
                      >
                        <p className="text-muted-foreground mb-1 text-xs">
                          {entry.who} · {when.format(new Date(entry.at))}
                        </p>
                        {/* Plain text only: customer email is never rendered as HTML. */}
                        <p className="font-read text-sm break-words whitespace-pre-wrap">
                          {entry.body}
                        </p>
                      </li>
                    ),
                  )}
                </ol>
                {entitlements.canWrite && !ticket.merged_into && (
                  <Composer
                    key={ticket.id}
                    slug={tenant.slug}
                    ticketId={ticket.id}
                    templates={templates}
                    canDraft={canDraft}
                    canSend={canSend}
                  />
                )}

                {/* On smaller screens the customer panel sits under the thread. */}
                <div className="xl:hidden">{customerPanel()}</div>
              </div>
              <aside className="border-border bg-panel hidden w-[300px] shrink-0 overflow-y-auto border-l p-4 xl:block">
                {customerPanel()}
              </aside>
            </div>
          </>
        )}
      </section>
    </main>
  );

  function customerPanel() {
    if (!ticket) return null;
    const heading = "text-muted-foreground text-[11px] font-semibold tracking-wide uppercase";
    return (
      <div className="flex flex-col gap-5">
        <section>
          <p className="font-read text-base font-semibold">{contact?.name ?? contact?.email}</p>
          {contact?.name && (
            <a
              href={`mailto:${contact.email}`}
              className="text-muted-foreground text-sm break-all hover:underline"
            >
              {contact.email}
            </a>
          )}
        </section>

        <section className="flex flex-col gap-2">
          <h3 className={heading}>Their orders</h3>
          {(orders?.data ?? []).length === 0 ? (
            <p className="text-muted-foreground text-sm">
              None found under this email. Orders show here once your shop is connected.
            </p>
          ) : (
            <ul className="flex flex-col gap-3">
              {(orders?.data ?? []).map((order) => (
                <li key={order.id} className="bg-card border-border rounded-md border p-3 text-sm">
                  <span className="flex items-baseline justify-between gap-2">
                    <span className="font-semibold">{order.name ?? "Order"}</span>
                    <span className="tabular-nums">
                      {formatMoney(Number(order.total), order.currency ?? tenant.currency)}
                    </span>
                  </span>
                  <span className="text-muted-foreground block text-xs">
                    {day.format(new Date(order.processed_at))}
                    {order.financial_status
                      ? ` · ${order.financial_status.toLowerCase().replaceAll("_", " ")}`
                      : ""}
                    {order.fulfillment_status
                      ? ` · ${order.fulfillment_status.toLowerCase().replaceAll("_", " ")}`
                      : ""}
                  </span>
                  <span className="text-muted-foreground font-read mt-1 block text-xs">
                    {((order.order_lines as { title: string; quantity: number }[] | null) ?? [])
                      .map((line) => `${line.quantity} × ${line.title}`)
                      .join(", ")}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        {boughtStock.length > 0 && (
          <section className="flex flex-col gap-2">
            <h3 className={heading}>Back in stock?</h3>
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
            <p className="text-muted-foreground text-xs">
              From Stock: things they bought that are sold out or have more on the way.
            </p>
          </section>
        )}

        {(earlier?.data ?? []).length > 0 && (
          <section className="flex flex-col gap-2">
            <h3 className={heading}>Other conversations</h3>
            <ul className="flex flex-col gap-1.5 text-sm">
              {(earlier?.data ?? []).map((other) => (
                <li key={other.id}>
                  <Link
                    href={href({ view: "all", t: other.number as number })}
                    className="hover:underline"
                  >
                    <span className="text-muted-foreground tabular-nums">#{other.number}</span>{" "}
                    <span className="font-read">{other.subject}</span>
                  </Link>
                  <span className="text-muted-foreground block text-xs">
                    {other.status === "closed"
                      ? "Closed"
                      : other.status === "pending"
                        ? "Waiting on customer"
                        : "Needs a reply"}{" "}
                    · {day.format(new Date(other.last_message_at as string))}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}

        <section className="flex flex-col gap-2">
          <h3 className={heading}>Tags</h3>
          <TagsForm
            slug={tenant.slug}
            ticketId={ticket.id}
            tags={tagsOf(ticket)}
            canEdit={entitlements.canWrite && !ticket.merged_into}
          />
        </section>

        {entitlements.canWrite && !ticket.merged_into && (
          <section>
            <MergeForm slug={tenant.slug} ticketId={ticket.id} />
          </section>
        )}
      </div>
    );
  }
}
