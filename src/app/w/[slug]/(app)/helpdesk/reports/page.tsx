import type { Metadata } from "next";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { helpdeskAccess } from "@/app/w/[slug]/helpdesk/gate";
import { daysFromNow, localDay } from "@/lib/bookings/slots";
import { formatDuration, median } from "@/lib/helpdesk/views";
import { nameOf, type Person } from "@/lib/messages/format";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "How the help desk is doing" };

type Row = {
  status: string;
  assignee_id: string | null;
  created_at: string;
  first_reply_at: string | null;
  closed_at: string | null;
  merged_into: string | null;
  ticket_tags: { tags: { name: string } | { name: string }[] | null }[] | null;
};

const DAYS = 30;

export default async function HelpdeskReportsPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const access = await helpdeskAccess(slug, `/w/${slug}/helpdesk/reports`);
  if (!access.ok) return access.upsell;
  const { tenant } = access;

  const supabase = await createClient();
  const [{ data }, { count: waiting }, { data: team }] = await Promise.all([
    supabase
      .from("tickets")
      .select(
        "status, assignee_id, created_at, first_reply_at, closed_at, merged_into, ticket_tags(tags(name))",
      )
      .eq("tenant_id", tenant.id)
      .gte("created_at", daysFromNow(-DAYS))
      .order("created_at")
      .limit(5000),
    supabase
      .from("tickets")
      .select("id", { count: "exact", head: true })
      .eq("tenant_id", tenant.id)
      .eq("status", "open"),
    supabase.rpc("chat_people", { p_tenant_id: tenant.id }),
  ]);
  const rows = ((data ?? []) as unknown as Row[]).filter((row) => !row.merged_into);
  const people = (team ?? []) as Person[];

  const replyTimes = rows
    .filter((row) => row.first_reply_at)
    .map((row) => Date.parse(row.first_reply_at!) - Date.parse(row.created_at));
  const closeTimes = rows
    .filter((row) => row.closed_at)
    .map((row) => Date.parse(row.closed_at!) - Date.parse(row.created_at));
  const typicalReply = median(replyTimes);
  const typicalClose = median(closeTimes);
  const stats = [
    { label: "New conversations", value: String(rows.length), note: `in the last ${DAYS} days` },
    {
      label: "Waiting for a reply",
      value: String(waiting ?? 0),
      note: "right now",
    },
    {
      label: "Typical first reply",
      value: typicalReply === null ? "–" : formatDuration(typicalReply),
      note: "half are answered faster than this",
    },
    {
      label: "Typical time to close",
      value: typicalClose === null ? "–" : formatDuration(typicalClose),
      note: `${closeTimes.length} closed`,
    },
  ];

  // One bar per day, oldest first, on the workspace's own calendar.
  const perDay = new Map<string, number>();
  for (let i = DAYS - 1; i >= 0; i--) {
    perDay.set(localDay(new Date(daysFromNow(-i)), tenant.timezone), 0);
  }
  for (const row of rows) {
    const day = localDay(new Date(row.created_at), tenant.timezone);
    if (perDay.has(day)) perDay.set(day, perDay.get(day)! + 1);
  }
  const busiest = Math.max(1, ...perDay.values());
  const dayLabel = (day: string) =>
    new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", day: "numeric" }).format(
      new Date(`${day}T12:00:00Z`),
    );

  const count = (values: string[]) => {
    const tally = new Map<string, number>();
    for (const value of values) tally.set(value, (tally.get(value) ?? 0) + 1);
    return [...tally].sort((a, b) => b[1] - a[1]);
  };
  const tags = count(
    rows.flatMap((row) =>
      (row.ticket_tags ?? [])
        .map((tt) => (Array.isArray(tt.tags) ? tt.tags[0] : tt.tags)?.name)
        .filter((name): name is string => Boolean(name)),
    ),
  ).slice(0, 8);
  const owners = count(
    rows.filter((row) => row.assignee_id).map((row) => row.assignee_id as string),
  ).slice(0, 8);
  const bars = (items: [string, number][], name: (key: string) => string) => {
    const top = Math.max(1, ...items.map(([, n]) => n));
    return (
      <ul className="flex flex-col gap-2 text-sm">
        {items.map(([key, n]) => (
          <li key={key} className="grid grid-cols-[9rem_1fr_2.5rem] items-center gap-3">
            <span className="font-read truncate">{name(key)}</span>
            <span aria-hidden className="bg-sunken h-2 overflow-hidden rounded-full">
              <span
                className="bg-chart-1 block h-full rounded-full"
                style={{ width: `${(n / top) * 100}%` }}
              />
            </span>
            <span className="text-right tabular-nums">{n}</span>
          </li>
        ))}
      </ul>
    );
  };

  return (
    <>
      <PageHeader
        back={{ href: `/w/${tenant.slug}/helpdesk`, label: "Help desk" }}
        title="How the help desk is doing"
        description={`The last ${DAYS} days of conversations.`}
      />

      <dl className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {stats.map((stat) => (
          <div key={stat.label} className="bg-card border-border rounded-lg border px-4 py-3">
            <dt className="text-muted-foreground text-xs font-semibold">{stat.label}</dt>
            <dd className="mt-1 text-2xl leading-none font-bold tabular-nums">{stat.value}</dd>
            <dd className="text-muted-foreground mt-1.5 text-xs">{stat.note}</dd>
          </div>
        ))}
      </dl>

      <Card>
        <CardHeader>
          <CardTitle>New conversations each day</CardTitle>
          <CardDescription>
            {dayLabel([...perDay.keys()][0])} to {dayLabel([...perDay.keys()].at(-1)!)}. The busiest
            day had {busiest === 1 && rows.length === 0 ? 0 : busiest}.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div
            role="img"
            aria-label={`New conversations per day for the last ${DAYS} days`}
            className="flex h-32 items-end gap-[3px]"
          >
            {[...perDay].map(([day, n]) => (
              <div
                key={day}
                title={`${dayLabel(day)}: ${n}`}
                className="bg-chart-1 min-h-[2px] flex-1 rounded-t-[3px]"
                style={{ height: `${(n / busiest) * 100}%`, opacity: n === 0 ? 0.25 : 1 }}
              />
            ))}
          </div>
          <details className="mt-3 text-sm">
            <summary className="text-ochre-text cursor-pointer font-medium">
              See the numbers
            </summary>
            <table className="mt-2 w-full max-w-xs text-left">
              <thead className="text-muted-foreground text-xs">
                <tr>
                  <th className="py-1 font-semibold">Day</th>
                  <th className="py-1 text-right font-semibold">New</th>
                </tr>
              </thead>
              <tbody>
                {[...perDay].map(([day, n]) => (
                  <tr key={day} className="border-border border-t">
                    <td className="py-1">{dayLabel(day)}</td>
                    <td className="py-1 text-right tabular-nums">{n}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
        </CardContent>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>What people write about</CardTitle>
            <CardDescription>By tag. Rules in settings add tags for you.</CardDescription>
          </CardHeader>
          <CardContent>
            {tags.length === 0 ? (
              <p className="text-muted-foreground text-sm">No tagged conversations yet.</p>
            ) : (
              bars(tags, (name) => name)
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Who picked them up</CardTitle>
            <CardDescription>Conversations each person had.</CardDescription>
          </CardHeader>
          <CardContent>
            {owners.length === 0 ? (
              <p className="text-muted-foreground text-sm">
                Nothing assigned yet. Replying to a conversation makes it yours.
              </p>
            ) : (
              bars(owners, (id) => nameOf(people.find((p) => p.user_id === id)))
            )}
          </CardContent>
        </Card>
      </div>
    </>
  );
}
