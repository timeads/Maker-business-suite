import type { Metadata } from "next";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { inboundDomain, supportAddress } from "@/lib/helpdesk/addresses";
import { createClient } from "@/lib/supabase/server";
import { cn } from "@/lib/utils";
import { helpdeskAccess } from "./gate";

export const metadata: Metadata = { title: "Help desk" };

const VIEWS = [
  { key: "open", label: "Needs a reply" },
  { key: "pending", label: "Waiting on customer" },
  { key: "closed", label: "Closed" },
] as const;
type View = (typeof VIEWS)[number]["key"];

type Row = {
  id: string;
  number: number;
  subject: string;
  status: View;
  last_message_at: string;
  contacts:
    { email: string; name: string | null } | { email: string; name: string | null }[] | null;
  ticket_tags: { tags: { name: string } | { name: string }[] | null }[] | null;
};

const one = <T,>(value: T | T[] | null): T | null =>
  Array.isArray(value) ? (value[0] ?? null) : value;

export default async function HelpdeskPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ view?: string }>;
}) {
  const { slug } = await params;
  const query = await searchParams;
  const access = await helpdeskAccess(slug, `/w/${slug}/helpdesk`);
  if (!access.ok) return access.upsell;
  const { tenant } = access;
  const base = `/w/${tenant.slug}/helpdesk`;
  const view: View = VIEWS.some((v) => v.key === query.view) ? (query.view as View) : "open";

  const supabase = await createClient();
  const [{ data }, counts] = await Promise.all([
    supabase
      .from("tickets")
      .select(
        "id, number, subject, status, last_message_at, contacts(email, name), ticket_tags(tags(name))",
      )
      .eq("tenant_id", tenant.id)
      .eq("status", view)
      .order("last_message_at", { ascending: false })
      .limit(100),
    Promise.all(
      VIEWS.map((v) =>
        supabase
          .from("tickets")
          .select("id", { count: "exact", head: true })
          .eq("tenant_id", tenant.id)
          .eq("status", v.key),
      ),
    ),
  ]);
  const tickets = (data as Row[] | null) ?? [];
  const total = counts.reduce((sum, result) => sum + (result.count ?? 0), 0);
  const domain = inboundDomain();
  const when = new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: tenant.timezone,
  });

  return (
    <>
      <header className="flex flex-wrap items-end justify-between gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">Help desk</h1>
        <Button asChild variant="outline" size="sm">
          <Link href={`${base}/settings`}>Help desk settings</Link>
        </Button>
      </header>

      {total === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>No conversations yet</CardTitle>
            <CardDescription>
              {domain
                ? "Emails sent to your help desk address show up here, with the customer's orders alongside."
                : "Incoming email isn't switched on for this environment yet."}
            </CardDescription>
          </CardHeader>
          {domain && (
            <CardContent className="flex flex-col gap-3 text-sm">
              <p>
                Your address:{" "}
                <span className="bg-muted rounded px-1.5 py-0.5 font-mono text-xs">
                  {supportAddress(tenant.slug, domain)}
                </span>
              </p>
              <p className="text-muted-foreground">
                Send it a test email, or set your existing support address to forward there.
              </p>
            </CardContent>
          )}
        </Card>
      ) : (
        <>
          <nav
            aria-label="Conversations"
            className="bg-muted flex w-fit flex-wrap gap-1 rounded-lg p-1"
          >
            {VIEWS.map((v, index) => (
              <Link
                key={v.key}
                href={`${base}?view=${v.key}`}
                aria-current={v.key === view ? "true" : undefined}
                className={cn(
                  "rounded-md px-3 py-1.5 text-sm transition-colors",
                  v.key === view
                    ? "bg-card font-medium shadow-xs"
                    : "text-muted-foreground hover:bg-card/60",
                )}
              >
                {v.label}
                <span className="text-muted-foreground ml-1.5 text-xs tabular-nums">
                  {counts[index].count ?? 0}
                </span>
              </Link>
            ))}
          </nav>

          <Card>
            <CardContent className="p-0">
              {tickets.length === 0 ? (
                <p className="text-muted-foreground p-6 text-sm">
                  {view === "open" ? "All caught up. Nothing needs a reply." : "Nothing here."}
                </p>
              ) : (
                <ul className="divide-border divide-y">
                  {tickets.map((ticket) => {
                    const contact = one(ticket.contacts);
                    const tags = (ticket.ticket_tags ?? [])
                      .map((tt) => one(tt.tags)?.name)
                      .filter((name): name is string => Boolean(name));
                    return (
                      <li key={ticket.id}>
                        <Link
                          href={`${base}/${ticket.number}`}
                          className="hover:bg-muted/60 flex flex-col gap-1 px-6 py-4 sm:flex-row sm:items-baseline sm:justify-between sm:gap-4"
                        >
                          <span className="min-w-0">
                            <span className="block truncate font-medium">{ticket.subject}</span>
                            <span className="text-muted-foreground block truncate text-sm">
                              {contact?.name ?? contact?.email ?? "Unknown sender"}
                              {tags.map((tag) => (
                                <span
                                  key={tag}
                                  className="bg-muted ml-2 rounded-full px-2 py-0.5 text-xs"
                                >
                                  {tag}
                                </span>
                              ))}
                            </span>
                          </span>
                          <span className="text-muted-foreground shrink-0 text-xs">
                            #{ticket.number} · {when.format(new Date(ticket.last_message_at))}
                          </span>
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </>
  );
}
