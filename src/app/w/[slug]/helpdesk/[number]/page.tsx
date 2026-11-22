import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatMoney } from "@/lib/dashboard/format";
import { inboundDomain } from "@/lib/helpdesk/addresses";
import {
  HELPDESK_MODULE,
  TEMPLATES_KEY,
  fillTemplate,
  parseTemplates,
} from "@/lib/helpdesk/config";
import { createClient } from "@/lib/supabase/server";
import { cn } from "@/lib/utils";
import { setTicketStatus } from "../actions";
import { helpdeskAccess } from "../gate";
import { ReplyForm } from "./reply-form";
import { TagsForm } from "./tags-form";

export const metadata: Metadata = { title: "Conversation" };

const STATUS_LABELS = {
  open: "Needs a reply",
  pending: "Waiting on customer",
  closed: "Closed",
} as const;
type Status = keyof typeof STATUS_LABELS;

const one = <T,>(value: T | T[] | null): T | null =>
  Array.isArray(value) ? (value[0] ?? null) : value;

export default async function TicketPage({
  params,
}: {
  params: Promise<{ slug: string; number: string }>;
}) {
  const { slug, number } = await params;
  const access = await helpdeskAccess(slug, `/w/${slug}/helpdesk/${number}`);
  if (!access.ok) return access.upsell;
  const { tenant, entitlements } = access;
  const base = `/w/${tenant.slug}/helpdesk`;
  if (!/^\d{1,9}$/.test(number)) notFound();

  const supabase = await createClient();
  const { data: ticket } = await supabase
    .from("tickets")
    .select("id, number, subject, status, contacts(email, name), ticket_tags(tags(name))")
    .eq("tenant_id", tenant.id)
    .eq("number", Number(number))
    .maybeSingle();
  if (!ticket) notFound();
  const contact = one(
    ticket.contacts as
      { email: string; name: string | null } | { email: string; name: string | null }[] | null,
  );
  const tags = (
    (ticket.ticket_tags as { tags: { name: string } | { name: string }[] | null }[] | null) ?? []
  )
    .map((tt) => one(tt.tags)?.name)
    .filter((name): name is string => Boolean(name));

  const [{ data: messages }, { data: orders }, { data: templateConfig }] = await Promise.all([
    supabase
      .from("messages")
      .select("id, direction, from_email, from_name, body, created_at")
      .eq("tenant_id", tenant.id)
      .eq("ticket_id", ticket.id)
      .order("created_at", { ascending: true }),
    contact
      ? supabase
          .from("orders")
          .select(
            "id, name, processed_at, total, currency, financial_status, fulfillment_status, order_lines(title, quantity)",
          )
          .eq("tenant_id", tenant.id)
          .eq("email", contact.email)
          .order("processed_at", { ascending: false })
          .limit(5)
      : Promise.resolve({ data: [] }),
    supabase
      .from("configs")
      .select("body")
      .eq("tenant_id", tenant.id)
      .eq("module", HELPDESK_MODULE)
      .eq("key", TEMPLATES_KEY)
      .maybeSingle(),
  ]);

  const firstName = contact?.name?.trim().split(/\s+/)[0] ?? "there";
  const templates = parseTemplates(templateConfig?.body).templates.map((template) => ({
    ...template,
    body: fillTemplate(template.body, { first_name: firstName, workspace: tenant.name }),
  }));
  const status = ticket.status as Status;
  const when = new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: tenant.timezone,
  });
  const day = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeZone: tenant.timezone });
  const canSend = Boolean(
    inboundDomain() && process.env.POSTMARK_SERVER_TOKEN && process.env.SUPABASE_SECRET_KEY,
  );
  const canDraft = Boolean(process.env.ANTHROPIC_API_KEY && process.env.SUPABASE_SECRET_KEY);

  return (
    <>
      <header className="flex flex-col gap-2">
        <Link
          href={`${base}?view=${status}`}
          className="text-muted-foreground text-sm hover:underline"
        >
          ← {STATUS_LABELS[status]}
        </Link>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-2xl font-semibold tracking-tight text-balance">{ticket.subject}</h1>
            <p className="text-muted-foreground text-sm">
              #{ticket.number} · {contact?.name ? `${contact.name} · ` : ""}
              {contact?.email}
            </p>
          </div>
          {entitlements.canWrite && (
            <form action={setTicketStatus.bind(null, tenant.slug, ticket.id)}>
              <input type="hidden" name="status" value={status === "closed" ? "open" : "closed"} />
              <Button type="submit" variant="outline" size="sm">
                {status === "closed" ? "Reopen" : "Close conversation"}
              </Button>
            </form>
          )}
        </div>
      </header>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_18rem]">
        <div className="flex min-w-0 flex-col gap-4">
          <ol className="flex flex-col gap-3">
            {(messages ?? []).map((message) => {
              const ours = message.direction === "outbound";
              return (
                <li
                  key={message.id}
                  className={cn(
                    "border-border rounded-xl border p-4",
                    ours ? "bg-muted ml-6" : "bg-card mr-6",
                  )}
                >
                  <p className="text-muted-foreground mb-2 text-xs">
                    {ours ? tenant.name : (message.from_name ?? message.from_email)} ·{" "}
                    {when.format(new Date(message.created_at))}
                  </p>
                  {/* Plain text only: customer email is never rendered as HTML. */}
                  <p className="text-sm break-words whitespace-pre-wrap">{message.body}</p>
                </li>
              );
            })}
          </ol>

          {entitlements.canWrite && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Reply</CardTitle>
              </CardHeader>
              <CardContent>
                <ReplyForm
                  slug={tenant.slug}
                  ticketId={ticket.id}
                  templates={templates}
                  canDraft={canDraft}
                  canSend={canSend}
                />
              </CardContent>
            </Card>
          )}
        </div>

        <aside className="flex flex-col gap-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Their orders</CardTitle>
            </CardHeader>
            <CardContent>
              {(orders ?? []).length === 0 ? (
                <p className="text-muted-foreground text-sm">
                  No orders found for {contact?.email ?? "this sender"}. Orders appear here once
                  Shopify is connected and the email addresses match.
                </p>
              ) : (
                <ul className="flex flex-col gap-4">
                  {(orders ?? []).map((order) => (
                    <li key={order.id} className="flex flex-col gap-1 text-sm">
                      <span className="flex items-baseline justify-between gap-2">
                        <span className="font-medium">{order.name ?? "Order"}</span>
                        <span className="tabular-nums">
                          {formatMoney(Number(order.total), order.currency ?? tenant.currency)}
                        </span>
                      </span>
                      <span className="text-muted-foreground text-xs">
                        {day.format(new Date(order.processed_at))}
                        {order.financial_status
                          ? ` · ${order.financial_status.toLowerCase().replaceAll("_", " ")}`
                          : ""}
                        {order.fulfillment_status
                          ? ` · ${order.fulfillment_status.toLowerCase().replaceAll("_", " ")}`
                          : ""}
                      </span>
                      <span className="text-muted-foreground text-xs">
                        {((order.order_lines as { title: string; quantity: number }[] | null) ?? [])
                          .map((line) => `${line.quantity} × ${line.title}`)
                          .join(", ")}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Tags</CardTitle>
            </CardHeader>
            <CardContent>
              <TagsForm
                slug={tenant.slug}
                ticketId={ticket.id}
                tags={tags}
                canEdit={entitlements.canWrite}
              />
            </CardContent>
          </Card>
        </aside>
      </div>
    </>
  );
}
