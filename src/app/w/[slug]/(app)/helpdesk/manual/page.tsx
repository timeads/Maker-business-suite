import type { Metadata } from "next";
import Link from "next/link";
import { Search } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { FormMessage } from "@/components/ui/form-message";
import { PageHeader } from "@/components/ui/page-header";
import { helpdeskAccess } from "@/app/w/[slug]/helpdesk/gate";
import { AI_EXHAUSTED, getAiUsage } from "@/lib/ai/usage";
import { HELPDESK_MODULE } from "@/lib/helpdesk/config";
import { MANUAL_KEY, hasSources, parseManual, searchHint } from "@/lib/helpdesk/manual/config";
import { loadTopics, manualDay, topicEntry } from "@/lib/helpdesk/manual/data";
import { describeRun, type RunCounts } from "@/lib/helpdesk/manual/run";
import { searchEntries } from "@/lib/helpdesk/manual/search";
import { countWaiting } from "@/lib/helpdesk/manual/waiting";
import { SAVED_VIEWS_KEY, parseSavedViews } from "@/lib/helpdesk/saved-views";
import { createClient } from "@/lib/supabase/server";
import { canManage } from "@/lib/tenants";
import { updateManualNow } from "./actions";
import { AskButton } from "./editor";
import { ManualTabs } from "./tabs";

export const metadata: Metadata = { title: "Manual" };

const one = (value: string | string[] | undefined) =>
  (Array.isArray(value) ? value[0] : value) ?? "";

export default async function ManualPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { slug } = await params;
  const sp = await searchParams;
  const access = await helpdeskAccess(slug, `/w/${slug}/helpdesk/manual`);
  if (!access.ok) return access.upsell;
  const { tenant, role, entitlements } = access;
  const manager = canManage(role);
  const base = `/w/${tenant.slug}/helpdesk/manual`;

  const supabase = await createClient();
  const [{ data: configs }, topics, { data: pending }, { data: runs }] = await Promise.all([
    supabase
      .from("configs")
      .select("key, body")
      .eq("tenant_id", tenant.id)
      .eq("module", HELPDESK_MODULE)
      .in("key", [MANUAL_KEY, SAVED_VIEWS_KEY]),
    loadTopics(supabase, tenant.id),
    supabase
      .from("manual_suggestions")
      .select("topic_id")
      .eq("tenant_id", tenant.id)
      .eq("status", "pending"),
    supabase
      .from("manual_runs")
      .select("status, source, counts, error, finished_at")
      .eq("tenant_id", tenant.id)
      .is("ticket_id", null)
      .order("created_at", { ascending: false })
      .limit(1),
  ]);
  const body = (key: string) => (configs ?? []).find((row) => row.key === key)?.body;
  const config = parseManual(body(MANUAL_KEY));
  const suggested = new Map<string, number>();
  for (const row of (pending ?? []) as { topic_id: string }[]) {
    suggested.set(row.topic_id, (suggested.get(row.topic_id) ?? 0) + 1);
  }
  const run = (runs ?? [])[0] as
    | {
        status: string;
        counts: Partial<RunCounts>;
        error: string | null;
        finished_at: string | null;
      }
    | undefined;

  // What an update would find, and whether there is allowance to read it. Managers only see this.
  const [waiting, usage] = manager
    ? await Promise.all([
        hasSources(config.sources)
          ? countWaiting(
              supabase,
              tenant.id,
              config.sources,
              parseSavedViews(body(SAVED_VIEWS_KEY)).views,
            ).catch(() => 0)
          : Promise.resolve(0),
        getAiUsage(supabase, tenant.id, entitlements.limit("ai_credits")),
      ])
    : [0, null];

  // The list's state is in the address: words, one label, drafts or published.
  const q = one(sp.q).slice(0, 100);
  const label = one(sp.label);
  const show =
    one(sp.show) === "drafts" ? "draft" : one(sp.show) === "published" ? "published" : "";
  const href = (next: Record<string, string | null>) => {
    const query = new URLSearchParams();
    const all = { q, label, show: one(sp.show), ...next };
    for (const [key, value] of Object.entries(all)) if (value) query.set(key, value);
    const text = query.toString();
    return text ? `${base}?${text}` : base;
  };
  const labelKey = (facet: string, value: string) => `${facet}:${value.toLowerCase()}`;
  const filtered = topics.filter(
    (topic) =>
      (!show || topic.status === show) &&
      (!label || topic.facets.some((f) => labelKey(f.facet, f.value) === label)),
  );
  const byId = new Map(filtered.map((topic) => [topic.id, topic]));
  const shown = searchEntries(filtered.map(topicEntry), q).map((entry) => byId.get(entry.id)!);

  // Each facet's values, most used first, as one-press filters.
  const facetValues = config.facets.map((facet) => {
    const counts = new Map<string, { value: string; n: number }>();
    for (const topic of topics) {
      for (const f of topic.facets) {
        if (f.facet !== facet.id) continue;
        const key = f.value.toLowerCase();
        counts.set(key, {
          value: counts.get(key)?.value ?? f.value,
          n: (counts.get(key)?.n ?? 0) + 1,
        });
      }
    }
    return {
      facet,
      values: [...counts.values()]
        .sort((a, b) => b.n - a.n || a.value.localeCompare(b.value))
        .slice(0, 14),
    };
  });

  // Grouped under the first label, the way the team thinks of them.
  const first = config.facets[0];
  const groups = new Map<string, typeof shown>();
  for (const topic of shown) {
    const name =
      (first && topic.facets.find((f) => f.facet === first.id)?.value) || "Everything else";
    groups.set(name, [...(groups.get(name) ?? []), topic]);
  }
  const groupNames = [...groups.keys()].sort((a, b) =>
    a === "Everything else" ? 1 : b === "Everything else" ? -1 : a.localeCompare(b),
  );
  const drafts = topics.filter((topic) => topic.status === "draft").length;

  return (
    <>
      <PageHeader
        title={config.name}
        description="Written up from finished conversations and by hand, for the team's eyes only."
      >
        {entitlements.canWrite && (
          <Button asChild>
            <Link href={`${base}/new`}>New topic</Link>
          </Button>
        )}
      </PageHeader>
      <ManualTabs slug={tenant.slug} topicsLabel={config.topics_label} />

      {manager && (
        <Card>
          <CardContent className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
            <div className="flex min-w-0 flex-1 flex-col gap-1 text-sm">
              {!hasSources(config.sources) ? (
                <>
                  <p className="font-semibold">Tell it which conversations to learn from</p>
                  <p className="text-muted-foreground font-read">
                    Pick a folder, a saved view or a tag in Settings. Closed conversations there
                    that the team answered are read by Claude and written up as draft topics. Until
                    then, topics are written by hand.
                  </p>
                </>
              ) : (
                <>
                  <p className="font-semibold">
                    {run?.status === "queued" || run?.status === "running"
                      ? "Reading conversations now…"
                      : waiting > 0
                        ? `${waiting} finished ${waiting === 1 ? "conversation is" : "conversations are"} waiting to be read`
                        : "Up to date with finished conversations"}
                  </p>
                  {run && (run.status === "done" || run.status === "failed") && (
                    <p className="text-muted-foreground font-read">
                      Last update
                      {run.finished_at
                        ? ` ${manualDay(run.finished_at, tenant.timezone)}`
                        : ""}:{" "}
                      {run.status === "failed" && run.error
                        ? run.error
                        : describeRun(run.counts ?? {}, config.name)}
                    </p>
                  )}
                  <p className="text-muted-foreground font-read">
                    {config.auto
                      ? `It brings itself up to date once a ${config.every}`
                      : "It only updates when you ask"}
                    , up to {config.monthly_cap} conversations a month. New topics arrive as drafts.
                  </p>
                </>
              )}
              {usage?.state === "exhausted" && <FormMessage>{AI_EXHAUSTED}</FormMessage>}
            </div>
            <div className="flex flex-wrap items-start gap-2">
              {hasSources(config.sources) &&
                entitlements.canWrite &&
                usage?.state !== "exhausted" &&
                run?.status !== "queued" &&
                run?.status !== "running" && (
                  <AskButton
                    action={updateManualNow.bind(null, tenant.slug)}
                    label="Update now"
                    pendingLabel="Starting…"
                  />
                )}
              <Button asChild variant="ghost">
                <Link href={`/w/${tenant.slug}/settings/helpdesk/manual`}>
                  {hasSources(config.sources) ? "Settings" : "Choose conversations"}
                </Link>
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      <div className="flex flex-col gap-3">
        <form action={base} className="relative max-w-xl">
          <Search
            aria-hidden
            className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2"
          />
          <input
            type="search"
            name="q"
            defaultValue={q}
            placeholder={searchHint(config)}
            aria-label={searchHint(config)}
            className="border-input bg-card focus-visible:border-ochre focus-visible:ring-ochre/25 h-10 w-full rounded-sm border pr-3 pl-9 text-sm outline-none focus-visible:ring-2"
          />
          {label && <input type="hidden" name="label" value={label} />}
          {one(sp.show) && <input type="hidden" name="show" value={one(sp.show)} />}
        </form>
        <div className="flex flex-col gap-2 text-sm">
          <div className="flex flex-wrap items-center gap-1.5">
            {[
              { key: null, name: `All (${topics.length})` },
              { key: "published", name: `Published (${topics.length - drafts})` },
              { key: "drafts", name: `Drafts (${drafts})` },
            ].map((choice) => {
              const on = (one(sp.show) || null) === choice.key;
              return (
                <Link
                  key={choice.name}
                  href={href({ show: choice.key })}
                  aria-current={on ? "true" : undefined}
                  className={
                    on
                      ? "bg-mint-soft rounded-full px-2.5 py-0.5 font-semibold"
                      : "text-text-2 hover:bg-hover rounded-full px-2.5 py-0.5"
                  }
                >
                  {choice.name}
                </Link>
              );
            })}
          </div>
          {facetValues
            .filter((group) => group.values.length > 0)
            .map((group) => (
              <div key={group.facet.id} className="flex flex-wrap items-center gap-1.5">
                <span className="text-muted-foreground text-xs font-semibold">
                  {group.facet.label}
                </span>
                {group.values.map((item) => {
                  const key = labelKey(group.facet.id, item.value);
                  const on = label === key;
                  return (
                    <Link
                      key={key}
                      href={href({ label: on ? null : key })}
                      aria-pressed={on}
                      className={
                        on
                          ? "bg-teal-soft text-teal-soft-ink rounded-full px-2.5 py-0.5 text-xs font-semibold"
                          : "border-border hover:bg-hover rounded-full border px-2.5 py-0.5 text-xs"
                      }
                    >
                      {item.value}
                      <span className="text-muted-foreground ml-1">{item.n}</span>
                    </Link>
                  );
                })}
              </div>
            ))}
        </div>
      </div>

      {topics.length === 0 ? (
        <Card>
          <CardContent className="font-read flex flex-col gap-2 text-sm">
            <p className="font-sans font-semibold">Nothing written down yet</p>
            <p className="text-muted-foreground max-w-prose">
              A topic is one thing the team has learned to answer: what people notice, what causes
              it, what to do. Write the first one yourself with “New topic”
              {manager
                ? ", or point it at your finished conversations and let Claude draft them"
                : ""}
              . Published topics can be dropped into a reply from the reply box.
            </p>
          </CardContent>
        </Card>
      ) : shown.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          Nothing matches.{" "}
          <Link href={base} className="underline">
            Show everything
          </Link>
        </p>
      ) : (
        <div className="flex flex-col gap-6">
          {groupNames.map((name) => (
            <section key={name} className="flex flex-col gap-2">
              {first && (
                <h2 className="text-muted-foreground text-[11px] font-semibold tracking-[0.14em] uppercase">
                  {name}
                </h2>
              )}
              <ul className="bg-card border-border divide-border divide-y rounded-lg border">
                {groups.get(name)!.map((topic) => (
                  <li key={topic.id}>
                    <Link
                      href={`${base}/${topic.id}`}
                      className="hover:bg-hover flex flex-col gap-1 px-4 py-3 sm:flex-row sm:items-center sm:gap-4"
                    >
                      <div className="min-w-0 flex-1">
                        <p className="font-semibold">{topic.title}</p>
                        {topic.summary && (
                          <p className="text-muted-foreground font-read line-clamp-1 text-sm">
                            {topic.summary}
                          </p>
                        )}
                      </div>
                      <div className="flex flex-wrap items-center gap-1.5">
                        {topic.facets
                          .filter((f) => f.facet !== first?.id)
                          .slice(0, 3)
                          .map((f) => (
                            <Badge key={`${f.facet}:${f.value}`}>{f.value}</Badge>
                          ))}
                        {(suggested.get(topic.id) ?? 0) > 0 && (
                          <Badge tone="waiting">
                            {suggested.get(topic.id)} suggested{" "}
                            {suggested.get(topic.id) === 1 ? "update" : "updates"}
                          </Badge>
                        )}
                        <Badge tone={topic.status === "published" ? "good" : "waiting"}>
                          {topic.status === "published" ? "Published" : "Draft"}
                        </Badge>
                        <span className="text-muted-foreground text-xs">
                          {topic.personEdited ? "Edited by the team" : "Written by Claude"}
                        </span>
                      </div>
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </>
  );
}
