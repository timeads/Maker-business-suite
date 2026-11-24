import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import {
  Boxes,
  CalendarDays,
  Inbox,
  LineChart,
  Megaphone,
  MessagesSquare,
  Truck,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { formatMoney } from "@/lib/dashboard/format";
import { requireUser } from "@/lib/auth";
import { daysFromNow, formatTime, localDay } from "@/lib/bookings/slots";
import { getEntitlements } from "@/lib/entitlements";
import type { ModuleKey } from "@/lib/modules";
import { loadStockHomeFacts, stockHomeLines } from "@/lib/stock/home-summary";
import { createClient } from "@/lib/supabase/server";
import { canManage, getTenantContext } from "@/lib/tenants";
import { HomeCards } from "./home-cards";

export const metadata: Metadata = { title: "Today" };

type Row = {
  key: ModuleKey;
  icon: typeof Inbox;
  name: string;
  /** What's waiting, in a few words. */
  headline: string;
  detail?: string;
  /** Something here wants doing today. */
  waiting: boolean;
  href: string;
};

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** "96 units due…" → "96 units due…": the first letter raised, for a line that starts a card. */
const sentence = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/**
 * Home is the day's to-do list: one line per tool, the ones that need
 * someone at the top. Every count is read as the signed-in member.
 */
export default async function WorkspaceHomePage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const user = await requireUser(`/w/${slug}`);
  const ctx = await getTenantContext(slug, user.id);
  if (!ctx) notFound();
  const { tenant, role } = ctx;
  const entitlements = await getEntitlements(tenant.id);
  const has = (key: ModuleKey) => entitlements.can(`module.${key}`);
  const base = `/w/${tenant.slug}`;
  const supabase = await createClient();
  const now = daysFromNow(0);
  const skip = Promise.resolve({ data: null, count: null });
  const count = (table: string) =>
    supabase.from(table).select("id", { count: "exact", head: true }).eq("tenant_id", tenant.id);

  const [chat, tickets, urgent, sessions, toSend, onOrder, nextPost, failedPosts, drafts, brand] =
    await Promise.all([
      has("messages") ? supabase.rpc("chat_overview", { p_tenant_id: tenant.id }) : skip,
      has("helpdesk")
        ? count("tickets")
            .eq("status", "open")
            .is("merged_into", null)
            .or(`snoozed_until.is.null,snoozed_until.lte.${now}`)
        : skip,
      has("helpdesk")
        ? count("tickets").eq("status", "open").is("merged_into", null).eq("priority", "urgent")
        : skip,
      has("bookings")
        ? supabase
            .from("sessions")
            .select("starts_at, capacity, services(name), bookings(seats, status)")
            .eq("tenant_id", tenant.id)
            .is("cancelled_at", null)
            .gte("starts_at", now)
            .lt("starts_at", daysFromNow(7))
            .order("starts_at")
            .limit(60)
        : skip,
      has("shipping")
        ? count("shipping_orders")
            .gt("units_left", 0)
            .eq("cancelled", false)
            .eq("on_hold", false)
            .eq("paid", true)
        : skip,
      has("stock") ? count("purchase_orders").in("status", ["ordered", "partial"]) : skip,
      has("social")
        ? supabase
            .from("social_posts")
            .select("scheduled_for")
            .eq("tenant_id", tenant.id)
            .eq("status", "scheduled")
            .gte("scheduled_for", now)
            .order("scheduled_for")
            .limit(1)
        : skip,
      has("social") ? count("social_posts").eq("status", "failed") : skip,
      has("social") ? count("social_posts").eq("status", "draft") : skip,
      canManage(role)
        ? supabase
            .from("configs")
            .select("key", { count: "exact", head: true })
            .eq("tenant_id", tenant.id)
            .eq("module", "brand")
            .eq("key", "kit")
        : skip,
    ]);

  const { data: recentOrders } = has("dashboard")
    ? await supabase
        .from("orders")
        .select("net_sales")
        .eq("tenant_id", tenant.id)
        .is("cancelled_at", null)
        .gte("processed_at", daysFromNow(-7))
        .limit(1000)
    : { data: null };
  const weekOrders = (recentOrders ?? []) as { net_sales: number | null }[];

  const rows: Row[] = [];
  if (has("helpdesk")) {
    const n = tickets.count ?? 0;
    rows.push({
      key: "helpdesk",
      icon: Inbox,
      name: "Help desk",
      headline: n
        ? `${plural(n, "conversation needs", "conversations need")} a reply`
        : "All caught up",
      detail: (urgent.count ?? 0) > 0 ? `${urgent.count} marked urgent` : undefined,
      waiting: n > 0,
      href: `${base}/helpdesk`,
    });
  }
  if (has("shipping")) {
    const n = toSend.count ?? 0;
    rows.push({
      key: "shipping",
      icon: Truck,
      name: "Shipping",
      headline: n ? `${plural(n, "order", "orders")} ready to send` : "Nothing waiting to go out",
      waiting: n > 0,
      href: `${base}/shipping`,
    });
  }
  if (has("bookings")) {
    type Session = {
      starts_at: string;
      capacity: number;
      services: { name: string } | null;
      bookings: { seats: number; status: string }[];
    };
    const booked = ((sessions.data ?? []) as unknown as Session[])
      .map((s) => ({
        ...s,
        seats: s.bookings.filter((b) => b.status === "confirmed").reduce((n, b) => n + b.seats, 0),
      }))
      .filter((s) => s.seats > 0);
    const today = localDay(new Date(now), tenant.timezone);
    const todays = booked.filter((s) => localDay(new Date(s.starts_at), tenant.timezone) === today);
    const next = booked[0];
    rows.push({
      key: "bookings",
      icon: CalendarDays,
      name: "Bookings",
      headline: todays.length
        ? `${plural(todays.length, "session", "sessions")} today, ${plural(
            todays.reduce((n, s) => n + s.seats, 0),
            "person",
            "people",
          )} coming`
        : booked.length
          ? `${plural(booked.length, "session", "sessions")} with bookings this week`
          : "Nobody booked in this week",
      detail: next
        ? `Next: ${next.services?.name ?? "a session"}, ${
            localDay(new Date(next.starts_at), tenant.timezone) === today
              ? "today"
              : new Intl.DateTimeFormat("en-US", {
                  timeZone: tenant.timezone,
                  weekday: "long",
                }).format(new Date(next.starts_at))
          } at ${formatTime(next.starts_at, tenant.timezone)}`
        : undefined,
      waiting: todays.length > 0,
      href: `${base}/bookings`,
    });
  }
  if (has("social")) {
    const failed = failedPosts.count ?? 0;
    const at = (nextPost.data as { scheduled_for: string }[] | null)?.[0]?.scheduled_for;
    rows.push({
      key: "social",
      icon: Megaphone,
      name: "Social",
      headline: failed
        ? `${plural(failed, "post", "posts")} didn't go out`
        : at
          ? `Next post goes out ${new Intl.DateTimeFormat("en-US", {
              timeZone: tenant.timezone,
              weekday: "long",
            }).format(new Date(at))} at ${formatTime(at, tenant.timezone)}`
          : "Nothing scheduled",
      detail:
        (drafts.count ?? 0) > 0
          ? `${plural(drafts.count ?? 0, "draft", "drafts")} waiting on you`
          : undefined,
      waiting: failed > 0,
      href: `${base}/social`,
    });
  }
  if (has("stock")) {
    const n = onOrder.count ?? 0;
    // A line or two of good news from Stock. Never allowed to cost the page.
    let stockLines: string[] = [];
    try {
      stockLines = stockHomeLines(await loadStockHomeFacts(supabase, tenant));
    } catch {
      stockLines = [];
    }
    rows.push({
      key: "stock",
      icon: Boxes,
      name: "Stock",
      headline: n
        ? `${plural(n, "order", "orders")} on the way from suppliers`
        : "See what needs reordering",
      detail: stockLines.length > 0 ? sentence(stockLines.slice(0, 3).join(" · ")) : undefined,
      waiting: false,
      href: `${base}/stock`,
    });
  }
  if (has("messages")) {
    const unread = ((chat.data ?? []) as { unread: number }[]).reduce(
      (n, c) => n + Number(c.unread ?? 0),
      0,
    );
    rows.push({
      key: "messages",
      icon: MessagesSquare,
      name: "Messages",
      headline: unread ? `${plural(unread, "new message", "new messages")}` : "No new messages",
      waiting: unread > 0,
      href: `${base}/messages`,
    });
  }
  if (has("dashboard")) {
    rows.push({
      key: "dashboard",
      icon: LineChart,
      name: "Money",
      headline: weekOrders.length
        ? `${formatMoney(
            weekOrders.reduce((sum, o) => sum + Number(o.net_sales ?? 0), 0),
            tenant.currency,
          )} in sales this week`
        : "No sales in the last 7 days",
      detail: weekOrders.length
        ? `${plural(weekOrders.length, "order", "orders")} in the last 7 days`
        : "Sales, margins and cash",
      waiting: false,
      href: `${base}/dashboard`,
    });
  }
  // What needs someone first; otherwise the order above.
  rows.sort((a, b) => Number(b.waiting) - Number(a.waiting));
  const waiting = rows.filter((row) => row.waiting).length;
  const hour = Number(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: tenant.timezone,
      hour: "2-digit",
      hourCycle: "h23",
    }).format(new Date(now)),
  );
  const greeting = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";

  return (
    <>
      <PageHeader
        title={`${greeting}, ${tenant.name}`}
        description={
          rows.length === 0
            ? "Pick a plan to switch your tools on."
            : waiting === 0
              ? "Nothing is waiting on you right now."
              : `${plural(waiting, "thing wants", "things want")} your attention today.`
        }
      />

      {canManage(role) && brand.count === 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Set up your brand kit</CardTitle>
            <CardDescription>
              Your colours and the way you sound. Claude follows it whenever it drafts a post or an
              email for you. Build one in two minutes, or upload the guide you already have.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button asChild variant="outline">
              <Link href={`${base}/settings/brand?welcome=1`}>Set up brand kit</Link>
            </Button>
          </CardContent>
        </Card>
      )}

      {rows.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>Your tools are waiting</CardTitle>
            <CardDescription>
              {canManage(role)
                ? "Choose a plan and they switch on straight away. The first 14 days are free."
                : "Ask a workspace owner to pick a plan."}
            </CardDescription>
          </CardHeader>
          {canManage(role) && (
            <CardContent>
              <Button asChild>
                <Link href={`${base}/settings/billing`}>See plans</Link>
              </Button>
            </CardContent>
          )}
        </Card>
      ) : (
        <HomeCards
          slug={tenant.slug}
          cards={rows.map(({ key, name, headline, detail, waiting: wants, href }) => ({
            key,
            name,
            headline,
            detail,
            waiting: wants,
            href,
          }))}
        />
      )}

      {canManage(role) && (
        <p className="text-muted-foreground text-sm">
          Working with others?{" "}
          <Link
            href={`${base}/settings/team`}
            className="text-ochre-text font-medium hover:underline"
          >
            Invite a teammate
          </Link>
        </p>
      )}
    </>
  );
}
