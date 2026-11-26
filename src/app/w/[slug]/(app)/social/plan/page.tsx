import type { Metadata } from "next";
import { PLACE_RULES, type Place } from "@/lib/social/networks";
import Link from "next/link";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { daysFromNow, formatDay, formatMinutes, parseClock } from "@/lib/bookings/slots";
import { monthReview, openSlots } from "@/lib/social/plan";
import { loadBrands } from "@/lib/brand/brands";
import { createClient } from "@/lib/supabase/server";
import { canManage } from "@/lib/tenants";
import { reviewDayFor, reviewDayWords, upcomingMonth, todayIn } from "@/lib/social/month";
import { describeMonthRun, type MonthRunRow } from "@/lib/social/month-run";
import { Badge } from "@/components/ui/badge";
import { DraftMonthForm, PlanForm } from "../forms";
import { ReviewDaysForm, RunNowForm } from "../month-forms";
import { socialAccess } from "../gate";
import { composerChoices } from "../shared";

export const metadata: Metadata = { title: "Content plan" };

export default async function SocialPlanPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const access = await socialAccess(slug, `/w/${slug}/social/plan`);
  if (!access.ok) return access.upsell;
  const { tenant, entitlements, role } = access;
  const base = `/w/${tenant.slug}/social`;
  const supabase = await createClient();
  const [{ plan }, { data: ahead }, { data: lately }, brands, { data: runRows }] =
    await Promise.all([
      composerChoices(supabase, tenant.id, []),
      supabase
        .from("social_posts")
        .select("status, scheduled_for, planned_for, topic")
        .eq("tenant_id", tenant.id)
        .or(`scheduled_for.gte.${daysFromNow(-1)},planned_for.gte.${daysFromNow(-1)}`)
        .limit(500),
      supabase
        .from("social_posts")
        .select("status, topic, channels")
        .eq("tenant_id", tenant.id)
        .gte("scheduled_for", daysFromNow(-30))
        .lt("scheduled_for", daysFromNow(0))
        .limit(1000),
      loadBrands(supabase, tenant.id),
      supabase
        .from("social_month_runs")
        .select(
          "id, brand_id, window_start, window_end, status, source, created_at, finished_at, counts, error",
        )
        .eq("tenant_id", tenant.id)
        .order("created_at", { ascending: false })
        .limit(6),
    ]);
  const liveBrands = brands.filter((brand) => !brand.archived_at);
  const runs = (runRows ?? []) as MonthRunRow[];
  const manager = canManage(role) && entitlements.canWrite;
  const today = todayIn(new Date(daysFromNow(0)), tenant.timezone);
  const brandName = (id: string) => brands.find((brand) => brand.id === id)?.name ?? "";
  const dayWords = (day: string) =>
    new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "long", day: "numeric" }).format(
      new Date(`${day}T00:00:00Z`),
    );
  const open = openSlots(plan, ahead ?? [], new Date(daysFromNow(0)), 28, tenant.timezone);
  const review = monthReview(plan, (lately ?? []) as never);
  const topicName = (id: string | null) =>
    plan.topics.find((topic) => topic.id === id)?.name ?? "Anything";
  const canDraft = Boolean(process.env.ANTHROPIC_API_KEY && process.env.SUPABASE_SECRET_KEY);

  return (
    <>
      <PageHeader
        title="Plan"
        description="What you post about and when, so there's always something lined up."
      />

      {plan.slots.length > 0 && (
        <div className="grid gap-6 lg:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle>
                {open.length === 0
                  ? "The next four weeks are covered"
                  : `${open.length} posting time${open.length === 1 ? "" : "s"} with nothing lined up`}
              </CardTitle>
              <CardDescription>Over the next four weeks.</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              {open.length > 0 && (
                <ul className="divide-border flex max-h-64 flex-col divide-y overflow-y-auto text-sm">
                  {open.map((slot) => (
                    <li key={slot.at} className="flex items-center gap-3 py-2">
                      <span className="min-w-0 flex-1">
                        {formatDay(slot.day)}, {formatMinutes(parseClock(slot.time) ?? 0)}
                        <span className="text-muted-foreground block text-xs">
                          {topicName(slot.topic)}
                        </span>
                      </span>
                      {entitlements.canWrite && (
                        <Link
                          href={`${base}/new?day=${slot.day}&time=${slot.time}${slot.topic ? `&topic=${slot.topic}` : ""}`}
                          className="text-ochre-text font-medium hover:underline"
                        >
                          Write it
                        </Link>
                      )}
                    </li>
                  ))}
                </ul>
              )}
              {open.length > 0 && entitlements.canWrite && canDraft && (
                <DraftMonthForm
                  slug={tenant.slug}
                  open={open.length}
                  brands={brands
                    .filter((brand) => !brand.archived_at)
                    .map((brand) => ({ id: brand.id, name: brand.name, main: brand.is_default }))}
                />
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>The last 30 days</CardTitle>
              <CardDescription>
                {review.posted} posted
                {review.failed > 0 && `, ${review.failed} didn't go out`}
                {review.channels.length > 0 &&
                  ` · ${review.channels.map(([channel, n]) => `${n} on ${channel === "instagram_story" ? "Instagram Stories" : (PLACE_RULES[channel as Place]?.label ?? channel)}`).join(", ")}`}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <ul className="flex flex-col gap-2.5 text-sm">
                {review.topics.map((topic) => {
                  const share = topic.planned ? Math.min(1, topic.posted / topic.planned) : 0;
                  return (
                    <li
                      key={topic.id}
                      className="grid grid-cols-[9rem_1fr_4.5rem] items-center gap-3"
                    >
                      <span className="truncate">{topic.name}</span>
                      <span aria-hidden className="bg-sunken h-2 overflow-hidden rounded-full">
                        <span
                          className="bg-chart-1 block h-full rounded-full"
                          style={{ width: `${share * 100}%` }}
                        />
                      </span>
                      <span className="text-right tabular-nums">
                        {topic.posted}
                        {topic.planned > 0 && (
                          <span className="text-muted-foreground"> of {topic.planned}</span>
                        )}
                      </span>
                    </li>
                  );
                })}
                {review.other > 0 && (
                  <li className="text-muted-foreground">Plus {review.other} with no topic.</li>
                )}
                {review.topics.length === 0 && (
                  <li className="text-muted-foreground">
                    Add topics below to see how your month splits between them.
                  </li>
                )}
              </ul>
            </CardContent>
          </Card>
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle>The monthly run</CardTitle>
          <CardDescription>
            Pick the day each month you sit down to review posts. Claude drafts the month ahead for
            you to read, change and approve.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-5">
          <ul className="flex flex-col gap-1.5 text-sm">
            {liveBrands.map((brand) => {
              const day = reviewDayFor(plan, brand);
              const month = day ? upcomingMonth(today, day) : null;
              return (
                <li key={brand.id}>
                  {liveBrands.length > 1 && <span className="font-semibold">{brand.name}: </span>}
                  {day && month ? (
                    <>
                      You review on {reviewDayWords(day)}. Next month runs {dayWords(month.start)}{" "}
                      to {dayWords(month.end)}
                      {day.auto ? ", drafted by itself." : ". It isn't drafted by itself."}
                    </>
                  ) : (
                    <span className="text-muted-foreground">No review day yet.</span>
                  )}
                </li>
              );
            })}
          </ul>
          {manager ? (
            <ReviewDaysForm
              slug={tenant.slug}
              rows={liveBrands.map((brand) => {
                const day = reviewDayFor(plan, brand);
                return {
                  brandId: brand.id,
                  brandName: brand.name,
                  week: day?.week ?? null,
                  weekday: day?.weekday ?? 1,
                  leadDays: day?.lead_days ?? 0,
                  auto: day?.auto ?? false,
                };
              })}
            />
          ) : (
            <p className="text-muted-foreground text-sm">
              An owner or admin sets the review day and switches the monthly run on.
            </p>
          )}
          {manager && canDraft && liveBrands.some((brand) => reviewDayFor(plan, brand)) && (
            <RunNowForm
              slug={tenant.slug}
              brands={liveBrands
                .filter((brand) => reviewDayFor(plan, brand))
                .map((brand) => ({ id: brand.id, name: brand.name }))}
            />
          )}
          {runs.length > 0 && (
            <ul className="divide-border flex flex-col divide-y text-sm">
              {runs.map((run) => (
                <li key={run.id} className="flex flex-col gap-1 py-2">
                  <span className="flex flex-wrap items-center gap-2">
                    <Badge
                      tone={
                        run.status === "done" ? "good" : run.status === "failed" ? "bad" : "waiting"
                      }
                    >
                      {run.status === "done"
                        ? "Drafted"
                        : run.status === "failed"
                          ? "Didn't finish"
                          : run.status === "running"
                            ? "Drafting"
                            : "Waiting to start"}
                    </Badge>
                    {liveBrands.length > 1 && `${brandName(run.brand_id)} · `}
                    {dayWords(run.window_start)} to {dayWords(run.window_end)}
                    <span className="text-muted-foreground text-xs">
                      {run.source === "manual" ? "asked for" : "by itself"}
                    </span>
                  </span>
                  {(run.status === "done" || run.status === "failed") && (
                    <span className="text-muted-foreground text-xs">
                      {run.status === "failed" && run.error
                        ? run.error
                        : describeMonthRun(run.counts)}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Your plan</CardTitle>
          <CardDescription>
            Topics and times are a guide, never a rule: you can post anything at any time.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {entitlements.canWrite ? (
            <PlanForm
              slug={tenant.slug}
              topics={plan.topics}
              slots={plan.slots}
              styleNotes={plan.style_notes}
              brands={liveBrands.map((brand) => ({
                id: brand.id,
                name: brand.name,
                main: brand.is_default,
              }))}
            />
          ) : (
            <p className="text-muted-foreground text-sm">
              This workspace is read-only, so the plan can&apos;t be changed.
            </p>
          )}
        </CardContent>
      </Card>
    </>
  );
}
