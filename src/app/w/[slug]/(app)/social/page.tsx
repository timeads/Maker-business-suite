import type { Metadata } from "next";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { FormMessage } from "@/components/ui/form-message";
import { PageHeader } from "@/components/ui/page-header";
import { SetupCard } from "@/components/setup/setup-card";
import { loadNotNow } from "@/lib/setup/data";
import { sortItems, type SetupItem } from "@/lib/setup/items";
import { SOCIAL_TOOL, socialSetupItems } from "@/lib/social/setup";
import { loadSocialSetupFacts } from "@/lib/social/setup-data";
import { formatDay, formatTime, localDay, zonedTimeToUtc } from "@/lib/bookings/slots";
import { createClient } from "@/lib/supabase/server";
import { canManage } from "@/lib/tenants";
import { cn } from "@/lib/utils";
import { AllowMetaAccess } from "../settings/helpdesk/channels/form";
import { socialAccess } from "./gate";
import { PostFilterBar, filterQuery, narrow, postFilterOf } from "./post-filter";
import { REVIEW_LABELS, STATUS_LABELS, socialChannels } from "./shared";

export const metadata: Metadata = { title: "Social" };

type PostRow = {
  id: string;
  caption: string;
  channels: string[];
  status: keyof typeof STATUS_LABELS;
  scheduled_for: string | null;
  planned_for: string | null;
  updated_at: string;
  review: string | null;
};

const SAVED: Record<string, string> = {
  schedule: "Scheduled. It'll go out on time.",
  now: "On its way. It should appear within a minute.",
  draft: "Draft saved.",
  review: "Sent for review. An approver will look at it.",
  deleted: "Post deleted.",
};

const pad = (n: number) => String(n).padStart(2, "0");
const iso = (date: Date) =>
  `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// Status is always written out as well; the tint only helps scanning.
const CHIP: Record<string, string> = {
  draft: "border-dashed border-ochre/60 bg-ochre-soft/40",
  scheduled: "border-border bg-card",
  publishing: "border-border bg-card",
  published: "border-transparent bg-muted text-muted-foreground",
  failed: "border-destructive/40 bg-destructive/5 text-destructive",
};

const snippet = (caption: string) => caption.replace(/\s+/g, " ").slice(0, 60) || "Photo";

export default async function SocialPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ month?: string; saved?: string; brand?: string; account?: string }>;
}) {
  const { slug } = await params;
  const query = await searchParams;
  const access = await socialAccess(slug, `/w/${slug}/social`);
  if (!access.ok) return access.upsell;
  const { tenant, role, entitlements } = access;
  const base = `/w/${tenant.slug}/social`;
  const filter = postFilterOf(query);

  const today = localDay(new Date(), tenant.timezone);
  const month = /^\d{4}-(0[1-9]|1[0-2])$/.test(query.month ?? "")
    ? (query.month as string)
    : today.slice(0, 7);
  const [year, monthIndex] = month.split("-").map(Number);
  const first = new Date(Date.UTC(year, monthIndex - 1, 1));
  const gridStart = new Date(Date.UTC(year, monthIndex - 1, 1 - first.getUTCDay()));
  const lastDay = new Date(Date.UTC(year, monthIndex, 0));
  const weeks = Math.ceil((first.getUTCDay() + lastDay.getUTCDate()) / 7);
  const days = Array.from(
    { length: weeks * 7 },
    (_, i) => new Date(gridStart.getTime() + i * 86_400_000),
  );
  const gridEnd = new Date(gridStart.getTime() + weeks * 7 * 86_400_000);
  // A little either side covers any timezone; posts are then placed by local day.
  const from = zonedTimeToUtc(iso(gridStart), 0, tenant.timezone) ?? gridStart;
  const to = zonedTimeToUtc(iso(gridEnd), 0, tenant.timezone) ?? gridEnd;
  const monthLink = (offset: number) =>
    `${base}?month=${iso(new Date(Date.UTC(year, monthIndex - 1 + offset, 1))).slice(0, 7)}${filterQuery(filter)}`;

  const supabase = await createClient();
  const columns = "id, caption, channels, status, scheduled_for, planned_for, updated_at, review";
  const [{ data: inMonth }, { data: drafts }, { data: failed }, channels, setupItems] =
    await Promise.all([
      narrow(supabase.from("social_posts").select(columns).eq("tenant_id", tenant.id), filter)
        .neq("status", "draft")
        .gte("scheduled_for", from.toISOString())
        .lt("scheduled_for", to.toISOString())
        .order("scheduled_for"),
      narrow(supabase.from("social_posts").select(columns).eq("tenant_id", tenant.id), filter)
        .eq("status", "draft")
        .order("updated_at", { ascending: false })
        .limit(60),
      narrow(supabase.from("social_posts").select(columns).eq("tenant_id", tenant.id), filter)
        .eq("status", "failed")
        .order("scheduled_for", { ascending: false })
        .limit(10),
      socialChannels(supabase, tenant.id),
      // "Finish setting up": a few small reads, no asset rows. Never stops the page.
      Promise.all([
        loadSocialSetupFacts(supabase, tenant),
        loadNotNow(supabase, tenant.id, SOCIAL_TOOL),
      ])
        .then(([facts, notNow]) => sortItems(socialSetupItems(facts), notNow).open)
        .catch((): SetupItem[] => []),
    ]);
  const byDay = new Map<string, PostRow[]>();
  // Drafts pencilled in for a day sit on the calendar too, marked as drafts.
  const pencilled = ((drafts ?? []) as PostRow[]).filter(
    (post) =>
      post.planned_for &&
      post.planned_for >= from.toISOString() &&
      post.planned_for < to.toISOString(),
  );
  const placed = [...((inMonth ?? []) as PostRow[]), ...pencilled].sort((a, b) =>
    ((a.scheduled_for ?? a.planned_for) as string).localeCompare(
      (b.scheduled_for ?? b.planned_for) as string,
    ),
  );
  for (const post of placed) {
    const day = localDay(
      new Date((post.scheduled_for ?? post.planned_for) as string),
      tenant.timezone,
    );
    byDay.set(day, [...(byDay.get(day) ?? []), post]);
  }
  const monthName = new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    month: "long",
    year: "numeric",
  }).format(first);

  const chip = (post: PostRow) => (
    <Link
      key={post.id}
      href={`${base}/${post.id}`}
      className={cn(
        "hover:border-primary block rounded border px-1.5 py-1 text-xs leading-snug",
        CHIP[post.status] ?? CHIP.scheduled,
      )}
    >
      <span className="font-medium tabular-nums">
        {formatTime((post.scheduled_for ?? post.planned_for) as string, tenant.timezone)}
      </span>{" "}
      {post.status !== "scheduled" && (
        <span>· {(post.review && REVIEW_LABELS[post.review]) || STATUS_LABELS[post.status]} </span>
      )}
      <span className="line-clamp-2">{snippet(post.caption)}</span>
    </Link>
  );

  return (
    <>
      <PageHeader
        title="Calendar"
        description="What's going out, what's pencilled in, and what's waiting on you."
      >
        {entitlements.canWrite && (
          <Button asChild>
            <Link href={`${base}/new`}>New post</Link>
          </Button>
        )}
      </PageHeader>

      <SetupCard
        slug={tenant.slug}
        tool={SOCIAL_TOOL}
        items={setupItems}
        canSnooze={canManage(role) && entitlements.canWrite}
        canAct={canManage(role) && entitlements.canWrite}
        setupHref="social/setup"
        ending="would get your posts out in your own look"
      />

      <FormMessage kind="success">{SAVED[query.saved ?? ""]}</FormMessage>

      <PostFilterBar
        supabase={supabase}
        tenantId={tenant.id}
        action={base}
        filter={filter}
        keep={query.month ? { month } : {}}
      />

      {channels.facebook === null && channels.needsPosting && (
        <Card>
          <CardHeader>
            <CardTitle>Reconnect to allow posting</CardTitle>
            <CardDescription>
              Facebook &amp; Instagram is connected for the help desk, but it wasn&apos;t given
              permission to publish posts. You can write drafts now; to schedule and publish them,
              Facebook needs to ask you for that permission.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {canManage(role) ? (
              <AllowMetaAccess
                slug={tenant.slug}
                access="posting"
                returnTo="social"
                variant="outline"
                label="Allow posting on Facebook"
              />
            ) : (
              <p className="text-muted-foreground text-sm">
                An owner or admin can allow it from here.
              </p>
            )}
          </CardContent>
        </Card>
      )}
      {channels.facebook === null &&
        !channels.needsPosting &&
        (channels.needsReconnect || !channels.otherNetworks) && (
          <Card>
            <CardHeader>
              <CardTitle>
                {channels.needsReconnect
                  ? "Facebook & Instagram need reconnecting"
                  : "Connect Facebook & Instagram"}
              </CardTitle>
              <CardDescription>
                {channels.needsReconnect
                  ? "Scheduled posts can't go out until the connection is renewed."
                  : "You can write drafts now. Connect your Facebook Page to schedule and publish them."}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Button asChild variant="outline">
                <Link href={`/w/${tenant.slug}/connections`}>Go to Connections</Link>
              </Button>
            </CardContent>
          </Card>
        )}

      {(failed ?? []).length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Didn&apos;t post</CardTitle>
            <CardDescription>Open one to see why and schedule it again.</CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="flex flex-col gap-1 text-sm">
              {((failed ?? []) as PostRow[]).map((post) => (
                <li key={post.id}>
                  <Link href={`${base}/${post.id}`} className="hover:underline">
                    {snippet(post.caption)}
                  </Link>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle>{monthName}</CardTitle>
            <nav aria-label="Month" className="flex gap-2 text-sm">
              <Link href={monthLink(-1)} className="hover:underline">
                ← Earlier
              </Link>
              <Link href={base} className="hover:underline">
                Today
              </Link>
              <Link href={monthLink(1)} className="hover:underline">
                Later →
              </Link>
            </nav>
          </div>
        </CardHeader>
        <CardContent>
          {/* Wide screens: a month grid. */}
          <div className="hidden sm:block">
            <div className="text-muted-foreground grid grid-cols-7 pb-1 text-xs font-medium">
              {WEEKDAYS.map((name) => (
                <span key={name} className="px-1">
                  {name}
                </span>
              ))}
            </div>
            <div className="border-border grid grid-cols-7 border-t border-l">
              {days.map((date) => {
                const day = iso(date);
                const inThisMonth = date.getUTCMonth() === monthIndex - 1;
                return (
                  <div
                    key={day}
                    className={cn(
                      "border-border flex min-h-24 flex-col gap-1 border-r border-b p-1",
                      !inThisMonth && "bg-muted/40",
                    )}
                  >
                    <div className="flex items-center justify-between">
                      <span
                        className={cn(
                          "px-1 text-xs tabular-nums",
                          day === today
                            ? "bg-primary text-primary-foreground rounded font-semibold"
                            : !inThisMonth && "text-muted-foreground",
                        )}
                      >
                        {date.getUTCDate()}
                      </span>
                      {entitlements.canWrite && day >= today && (
                        <Link
                          href={`${base}/new?day=${day}`}
                          aria-label={`New post on ${formatDay(day)}`}
                          className="text-muted-foreground hover:text-ochre-text px-1 text-sm leading-none"
                        >
                          +
                        </Link>
                      )}
                    </div>
                    {(byDay.get(day) ?? []).map(chip)}
                  </div>
                );
              })}
            </div>
          </div>
          {/* Phones: the same posts as a list by day. */}
          <div className="flex flex-col gap-4 sm:hidden">
            {byDay.size === 0 && (
              <p className="text-muted-foreground text-sm">Nothing scheduled this month.</p>
            )}
            {[...byDay.entries()].map(([day, posts]) => (
              <div key={day} className="flex flex-col gap-1">
                <p className="text-sm font-medium">{formatDay(day)}</p>
                {posts.map(chip)}
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Drafts</CardTitle>
        </CardHeader>
        <CardContent>
          {(drafts ?? []).length === 0 ? (
            <p className="text-muted-foreground text-sm">
              No drafts. Start a post and save it for later whenever you like.
            </p>
          ) : (
            <ul className="divide-border flex flex-col divide-y">
              {((drafts ?? []) as PostRow[]).map((post) => (
                <li key={post.id}>
                  <Link
                    href={`${base}/${post.id}`}
                    className="hover:bg-muted -mx-2 block rounded px-2 py-2 text-sm"
                  >
                    {snippet(post.caption)}
                    {post.review && (
                      <span className="text-muted-foreground"> · {REVIEW_LABELS[post.review]}</span>
                    )}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </>
  );
}
