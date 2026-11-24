import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Badge, type BadgeTone } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { loadWorkspace } from "@/lib/admin/data";
import {
  HEALTH_TONE,
  auditWords,
  compactNumber,
  entitlementsFor,
  formatDay,
  formatMoment,
  planWords,
} from "@/lib/admin/facts";
import { requirePlatformAdmin } from "@/lib/admin/platform";
import { PLANS, PLAN_ORDER } from "@/lib/billing/plans";
import { MODULES } from "@/lib/modules";
import { EndGrantForm, PlanGrantForm, RequeueSyncButton } from "../admin-forms";

export const metadata: Metadata = { title: "Workspace" };

const JOB_TONE: Record<string, BadgeTone> = {
  queued: "waiting",
  running: "open",
  succeeded: "good",
  failed: "bad",
};

const ROLE_WORDS: Record<string, string> = { owner: "Owner", admin: "Admin", member: "Member" };

const COUNT_WORDS = {
  orders: "Orders",
  tickets: "Help desk conversations",
  bookings: "Bookings",
  posts: "Social posts",
  stock_items: "Stock items",
  parcels: "Parcels sent",
} as const;

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd className="text-sm break-words">{children}</dd>
    </div>
  );
}

/** An id to copy: plain text that selects in one click. */
function Copyable({ value }: { value: string }) {
  return (
    <code className="bg-sunken rounded-sm px-1.5 py-0.5 font-mono text-xs break-all select-all">
      {value}
    </code>
  );
}

export default async function AdminWorkspacePage({
  params,
}: {
  params: Promise<{ tenantId: string }>;
}) {
  const { tenantId } = await params;
  await requirePlatformAdmin(`/admin/${tenantId}`);
  const detail = await loadWorkspace(tenantId);
  if (!detail) notFound();

  const { workspace, subscription, grant } = detail;
  const now = new Date();
  const entitlements = entitlementsFor(workspace.id, subscription, grant, now);
  const plan = planWords(entitlements, subscription);
  const allowance = entitlements.limit("ai_credits");
  const grantRunning = entitlements.internal !== null;

  return (
    <>
      <PageHeader
        back={{ href: "/admin", label: "All workspaces" }}
        title={workspace.name}
        description={`/w/${workspace.slug} · since ${formatDay(workspace.created_at)} · ${workspace.timezone} · ${workspace.currency}`}
      >
        <Badge tone={plan.tone}>
          {plan.word === "No plan" ? plan.word : `${plan.plan} · ${plan.word}`}
        </Badge>
      </PageHeader>

      <div className="grid items-start gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Plan and billing</CardTitle>
            <CardDescription>
              {grantRunning
                ? "On an internal plan, so Stripe's answer is set aside for now."
                : "What Stripe says, as the worker last recorded it."}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {subscription ? (
              <dl className="grid gap-4 sm:grid-cols-2">
                <Fact label="Stripe plan">
                  {PLANS[subscription.plan as keyof typeof PLANS]?.name ?? subscription.plan}
                </Fact>
                <Fact label="Stripe status">{subscription.status.replaceAll("_", " ")}</Fact>
                <Fact label="Trial ends">{formatMoment(subscription.trial_end)}</Fact>
                <Fact label={subscription.cancel_at_period_end ? "Ends" : "Period ends"}>
                  {formatMoment(subscription.current_period_end)}
                </Fact>
                {subscription.ended_at && (
                  <Fact label="Ended">{formatMoment(subscription.ended_at)}</Fact>
                )}
                {subscription.purge_after && (
                  <Fact label="Data deleted after">{formatMoment(subscription.purge_after)}</Fact>
                )}
                <Fact label="Stripe customer">
                  <Copyable value={subscription.stripe_customer_id} />
                </Fact>
                <Fact label="Stripe subscription">
                  <Copyable value={subscription.stripe_subscription_id} />
                </Fact>
              </dl>
            ) : (
              <p className="text-muted-foreground text-sm">
                This workspace has never started a plan through Stripe.
              </p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Internal plan</CardTitle>
            <CardDescription>
              Give this workspace a plan without Stripe: our own business, a thank-you, a longer
              try-out. It behaves as that plan until the end date, then goes back to whatever Stripe
              says. Stripe itself is never touched.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            {grant && (
              <dl className="bg-sunken grid gap-4 rounded-lg p-4 sm:grid-cols-2">
                <Fact label={grantRunning ? "On now" : "Was on (ended)"}>
                  {PLANS[grant.plan as keyof typeof PLANS]?.name ?? grant.plan}
                </Fact>
                <Fact label="Ends">
                  {grant.ends_at ? formatMoment(grant.ends_at) : "No end date"}
                </Fact>
                <Fact label="Set">
                  {formatMoment(grant.granted_at)}
                  {grant.granted_by ? ` by ${grant.granted_by}` : ""}
                </Fact>
                <Fact label="Why">{grant.note}</Fact>
              </dl>
            )}
            <PlanGrantForm
              tenantId={workspace.id}
              plans={PLAN_ORDER.map((key) => ({ key, name: PLANS[key].name }))}
              current={
                grant && grantRunning
                  ? { plan: grant.plan, endsOn: grant.ends_at?.slice(0, 10) ?? "" }
                  : null
              }
            />
            <p className="text-muted-foreground text-xs">
              The end date runs through the end of that day, UTC. To give someone a longer trial,
              use this with an end date: a real trial lives on the Stripe subscription, and this
              page doesn&apos;t change Stripe.
            </p>
            {grant && <EndGrantForm tenantId={workspace.id} name={workspace.name} />}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>What they can use today</CardTitle>
            <CardDescription>
              Worked out the same way the workspace itself is: {plan.plan}
              {plan.word === "No plan" ? "" : `, ${plan.word.toLowerCase()}`}.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <ul className="flex flex-wrap gap-1.5">
              {MODULES.map((m) => {
                const on = entitlements.can(`module.${m.key}`);
                return (
                  <li key={m.key}>
                    <Badge tone={on ? "good" : "closed"}>
                      {m.name}: {on ? "on" : "off"}
                    </Badge>
                  </li>
                );
              })}
              <li>
                <Badge tone={entitlements.can("mcp") ? "good" : "closed"}>
                  Own Claude: {entitlements.can("mcp") ? "on" : "off"}
                </Badge>
              </li>
            </ul>
            <dl className="grid gap-4 sm:grid-cols-3">
              <Fact label="Can make changes">
                {entitlements.canWrite ? "Yes" : "No, read-only"}
              </Fact>
              <Fact label="Seats">
                {detail.members.length} of {entitlements.limit("seats")}
              </Fact>
              <Fact label="AI this month">
                {compactNumber(detail.ai_tokens_month)} of {compactNumber(allowance)}
              </Fact>
            </dl>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>What&apos;s in here</CardTitle>
            <CardDescription>How much, never what.</CardDescription>
          </CardHeader>
          <CardContent>
            <dl className="grid grid-cols-2 gap-4 sm:grid-cols-3">
              {(Object.keys(COUNT_WORDS) as (keyof typeof COUNT_WORDS)[]).map((key) => (
                <Fact key={key} label={COUNT_WORDS[key]}>
                  <span className="text-lg font-bold tabular-nums">
                    {detail.counts[key].toLocaleString("en-US")}
                  </span>
                </Fact>
              ))}
            </dl>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>People</CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="divide-border divide-y">
            {detail.members.map((member) => (
              <li
                key={`${member.email}-${member.joined_at}`}
                className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 py-2 text-sm first:pt-0 last:pb-0"
              >
                <span className="min-w-0 break-all">{member.email ?? "No email"}</span>
                <span className="text-muted-foreground flex items-center gap-2 text-xs">
                  <Badge tone={member.role === "owner" ? "open" : "closed"}>
                    {ROLE_WORDS[member.role] ?? member.role}
                  </Badge>
                  joined {formatDay(member.joined_at)}
                </span>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Connections</CardTitle>
          <CardDescription>
            {detail.failed_jobs_7d > 0
              ? `${detail.failed_jobs_7d} background ${detail.failed_jobs_7d === 1 ? "job" : "jobs"} failed in the last 7 days.`
              : "No background jobs failed in the last 7 days."}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {detail.connections.length === 0 ? (
            <p className="text-muted-foreground text-sm">Nothing connected yet.</p>
          ) : (
            <ul className="divide-border divide-y">
              {detail.connections.map((c) => (
                <li
                  key={c.id}
                  className="flex flex-wrap items-start justify-between gap-x-6 gap-y-2 py-3 first:pt-0 last:pb-0"
                >
                  <div className="min-w-0 flex-1">
                    <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                      {c.provider} <Badge tone={HEALTH_TONE[c.health]}>{c.health}</Badge>
                    </p>
                    <p className="text-muted-foreground mt-1 text-xs">
                      {c.last_synced_at
                        ? `Last good sync ${formatMoment(c.last_synced_at)}`
                        : "No sync yet"}{" "}
                      · connected {formatDay(c.connected_at)}
                    </p>
                    {c.last_error && (
                      <p className="text-brick mt-1 font-mono text-xs break-words">
                        {c.last_error}
                      </p>
                    )}
                  </div>
                  {c.status === "active" && (
                    <RequeueSyncButton
                      tenantId={workspace.id}
                      connectionId={c.id}
                      provider={c.provider}
                    />
                  )}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Recent background jobs</CardTitle>
          <CardDescription>The last 30, newest first.</CardDescription>
        </CardHeader>
        <CardContent>
          {detail.jobs.length === 0 ? (
            <p className="text-muted-foreground text-sm">No jobs have run yet.</p>
          ) : (
            <ul className="divide-border divide-y">
              {detail.jobs.map((job) => (
                <li key={job.id} className="py-2 text-sm first:pt-0 last:pb-0">
                  <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
                    <span className="flex min-w-0 flex-wrap items-center gap-2">
                      <Badge tone={JOB_TONE[job.status] ?? "closed"}>{job.status}</Badge>
                      <span>
                        {job.provider} · {job.type}
                        {job.topic ? ` · ${job.topic}` : ""}
                      </span>
                    </span>
                    <span className="text-muted-foreground text-xs">
                      {formatMoment(job.finished_at ?? job.created_at)}
                      {job.attempts > 1 ? ` · ${job.attempts} tries` : ""}
                    </span>
                  </div>
                  {job.error && (
                    <p className="text-brick mt-1 font-mono text-xs break-words">{job.error}</p>
                  )}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>What we&apos;ve done here</CardTitle>
          <CardDescription>
            Every change made from this admin area, with who and why.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {detail.audit.length === 0 ? (
            <p className="text-muted-foreground text-sm">Nothing yet.</p>
          ) : (
            <ul className="divide-border divide-y">
              {detail.audit.map((entry) => (
                <li key={entry.id} className="py-2 text-sm first:pt-0 last:pb-0">
                  <p>{auditWords(entry.action, entry.details)}</p>
                  {entry.note && <p className="font-read mt-0.5">“{entry.note}”</p>}
                  <p className="text-muted-foreground mt-0.5 text-xs">
                    {entry.admin_email ?? "Someone no longer here"} ·{" "}
                    {formatMoment(entry.created_at)}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <p className="text-muted-foreground text-xs">
        Not here yet: seeing a workspace as its owner does, changing or deleting a workspace, adding
        admins from this page, and emailing customers. Admins are added by hand; see docs/admin.md.
      </p>
    </>
  );
}
