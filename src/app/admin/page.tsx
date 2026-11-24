import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input, Label, Select } from "@/components/ui/input";
import { PageHeader } from "@/components/ui/page-header";
import { loadHealth, loadWorkspaces } from "@/lib/admin/data";
import {
  HEALTH_TONE,
  attentionReasons,
  compactNumber,
  filterAndSort,
  formatDay,
  formatMoment,
  planWords,
  rowEntitlements,
  type Health,
  type WorkspaceSort,
} from "@/lib/admin/facts";
import { requirePlatformAdmin } from "@/lib/admin/platform";
import { cn } from "@/lib/utils";

function HealthStrip({ health }: { health: Health }) {
  const totals: { label: string; value: number; worry?: boolean }[] = [
    { label: "Workspaces", value: health.workspaces },
    { label: "Trialing", value: health.trialing },
    { label: "Paying", value: health.paying },
    { label: "Past due", value: health.past_due, worry: true },
    { label: "Internal plans", value: health.internal },
    { label: "Failed jobs, last 24h", value: health.failed_jobs_24h, worry: true },
    { label: "Need reconnecting", value: health.needs_reconnect, worry: true },
    { label: "Jobs stuck over an hour", value: health.stuck_jobs, worry: true },
    { label: "Stripe events waiting", value: health.stripe_events_waiting, worry: true },
    { label: "Emails waiting", value: health.inbound_emails_waiting, worry: true },
  ];
  return (
    <section aria-label="How things are running">
      <dl className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
        {totals.map((total) => {
          const bad = total.worry && total.value > 0;
          return (
            <div
              key={total.label}
              className={cn(
                "bg-card flex flex-col-reverse gap-0.5 rounded-xl border px-4 py-3",
                bad ? "border-brick/30 bg-brick-soft" : "border-border",
              )}
            >
              <dt className={cn("text-xs", bad ? "text-brick" : "text-muted-foreground")}>
                {total.label}
              </dt>
              <dd className={cn("text-2xl font-bold tabular-nums", bad && "text-brick")}>
                {total.value}
              </dd>
            </div>
          );
        })}
      </dl>
      <p className="text-muted-foreground mt-2 text-xs">
        Stripe events and inbound emails count once they&apos;ve waited more than ten minutes.
      </p>
    </section>
  );
}

export default async function AdminWorkspacesPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; sort?: string }>;
}) {
  await requirePlatformAdmin();
  const params = await searchParams;
  const query = typeof params.q === "string" ? params.q : "";
  const sort: WorkspaceSort = params.sort === "attention" ? "attention" : "newest";
  const [health, all] = await Promise.all([loadHealth(), loadWorkspaces()]);
  const now = new Date();
  const rows = filterAndSort(all, query, sort, now);

  return (
    <>
      <PageHeader
        title="Workspaces"
        description="Every workspace on the suite, and how it's getting on. You see how things are running, never what a workspace's customers wrote or bought."
      />

      <HealthStrip health={health} />

      <form method="get" action="/admin" className="flex flex-wrap items-end gap-3">
        <div className="flex w-full min-w-0 flex-col gap-1 sm:w-auto sm:max-w-sm sm:flex-1">
          <Label htmlFor="q">Search</Label>
          <Input
            id="q"
            name="q"
            type="search"
            defaultValue={query}
            placeholder="Name, web address or owner's email"
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="sort">Order</Label>
          <Select id="sort" name="sort" defaultValue={sort}>
            <option value="newest">Newest first</option>
            <option value="attention">Needs attention first</option>
          </Select>
        </div>
        <Button type="submit" variant="outline">
          Show
        </Button>
      </form>

      {rows.length === 0 ? (
        <Card className="text-muted-foreground p-5 text-sm">
          {all.length === 0
            ? "No workspaces yet. The first one will show up here."
            : "No workspace matches that search."}
        </Card>
      ) : (
        <Card className="overflow-hidden">
          <ul className="divide-border divide-y">
            {rows.map((row) => {
              const entitlements = rowEntitlements(row, now);
              const plan = planWords(entitlements, row);
              const reasons = attentionReasons(row, now);
              const allowance = entitlements.limit("ai_credits");
              return (
                <li key={row.tenant_id}>
                  <Link
                    href={`/admin/${row.tenant_id}`}
                    className="hover:bg-hover focus-visible:ring-ochre grid gap-x-6 gap-y-3 p-4 outline-none focus-visible:ring-2 focus-visible:ring-inset md:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)_minmax(0,1.3fr)_minmax(0,1fr)] md:px-5"
                  >
                    <div className="min-w-0">
                      <p className="truncate font-bold">{row.name}</p>
                      <p className="text-muted-foreground truncate text-xs">
                        /w/{row.slug} · since {formatDay(row.created_at)}
                      </p>
                      <p className="text-muted-foreground mt-1 truncate text-xs">
                        {row.owner_email ?? "No owner"} · {row.member_count}{" "}
                        {row.member_count === 1 ? "person" : "people"}
                      </p>
                    </div>

                    <div className="min-w-0">
                      <p className="flex flex-wrap items-center gap-1.5 text-sm">
                        {plan.word !== "No plan" && (
                          <span className="font-medium">{plan.plan}</span>
                        )}
                        <Badge tone={plan.tone}>{plan.word}</Badge>
                      </p>
                      {plan.date && (
                        <p className="text-muted-foreground mt-1 text-xs">
                          {plan.date.label} {formatDay(plan.date.at)}
                        </p>
                      )}
                    </div>

                    <div className="min-w-0">
                      {row.connections.length === 0 ? (
                        <p className="text-muted-foreground text-sm">Nothing connected</p>
                      ) : (
                        <ul className="flex flex-wrap gap-1.5">
                          {row.connections.map((c) => (
                            <li key={c.provider}>
                              <Badge tone={HEALTH_TONE[c.health]}>
                                {c.provider}: {c.health}
                              </Badge>
                            </li>
                          ))}
                        </ul>
                      )}
                      <p className="text-muted-foreground mt-1 text-xs">
                        {row.last_synced_at
                          ? `Last good sync ${formatMoment(row.last_synced_at)}`
                          : "No sync yet"}
                      </p>
                    </div>

                    <div className="min-w-0 text-xs">
                      {reasons.length > 0 ? (
                        <ul className="text-brick flex flex-col gap-0.5 font-medium">
                          {reasons.map((reason) => (
                            <li key={reason}>{reason}</li>
                          ))}
                        </ul>
                      ) : (
                        <p className="text-muted-foreground">Nothing needs a look</p>
                      )}
                      <p className="text-muted-foreground mt-1">
                        AI this month: {compactNumber(row.ai_tokens_month)} of{" "}
                        {compactNumber(allowance)}
                      </p>
                    </div>
                  </Link>
                </li>
              );
            })}
          </ul>
        </Card>
      )}
    </>
  );
}
