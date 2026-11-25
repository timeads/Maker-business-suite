import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { helpdeskAccess } from "@/app/w/[slug]/helpdesk/gate";
import {
  loadManualConfig,
  loadSuggestions,
  loadTopic,
  manualDay,
} from "@/lib/helpdesk/manual/data";
import { nameOf, type Person } from "@/lib/messages/format";
import { createClient } from "@/lib/supabase/server";
import { canManage } from "@/lib/tenants";
import {
  acceptSuggestion,
  deleteTopic,
  dismissSuggestion,
  publishTopic,
  restoreRevision,
  saveTopic,
  setTopicInDrafts,
} from "../actions";
import { DocView } from "../doc-view";
import { EntryForm } from "../editor";

export const metadata: Metadata = { title: "Topic" };

const CAUSES: Record<string, string> = {
  written: "Written",
  edited: "Edited",
  ai_written: "Written by Claude from a conversation",
  ai_added: "Added to by Claude from a conversation",
  suggestion: "Suggested update accepted",
  published: "Published",
  unpublished: "Moved back to drafts",
};

type SourceRow = {
  ticket_id: string;
  added_at: string;
  tickets: { number: number; subject: string } | { number: number; subject: string }[] | null;
};

export default async function TopicPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string; id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { slug, id } = await params;
  const editing = (await searchParams).edit === "1";
  const access = await helpdeskAccess(slug, `/w/${slug}/helpdesk/manual/${id}`);
  if (!access.ok) return access.upsell;
  const { tenant, role, entitlements } = access;
  const supabase = await createClient();
  const topic = await loadTopic(supabase, tenant.id, id);
  if (!topic) notFound();
  const base = `/w/${tenant.slug}/helpdesk/manual`;
  const here = `${base}/${topic.id}`;
  const manager = canManage(role);
  const canWrite = entitlements.canWrite;
  const config = await loadManualConfig(supabase, tenant.id);

  if (editing) {
    const facets: Record<string, string> = {};
    for (const facet of config.facets) {
      facets[facet.id] = topic.facets
        .filter((f) => f.facet === facet.id)
        .map((f) => f.value)
        .join(", ");
    }
    return (
      <>
        <PageHeader
          title="Edit topic"
          description={
            topic.personEdited
              ? undefined
              : "Once you save, this topic is yours: Claude will only ever suggest additions to it."
          }
          back={{ href: here, label: topic.title }}
        />
        <EntryForm
          action={saveTopic.bind(null, tenant.slug, topic.id)}
          kind="topic"
          initial={{ title: topic.title, summary: topic.summary, body: topic.body, facets }}
          facets={config.facets}
          headings={config.sections}
          cancelHref={here}
          canEdit={canWrite}
        />
      </>
    );
  }

  const [suggestions, { data: sourceRows }, { data: revisionRows }, { data: team }] =
    await Promise.all([
      loadSuggestions(supabase, tenant.id, topic.id),
      supabase
        .from("manual_topic_sources")
        .select("ticket_id, added_at, tickets(number, subject)")
        .eq("tenant_id", tenant.id)
        .eq("topic_id", topic.id)
        .order("added_at", { ascending: false })
        .limit(50),
      supabase
        .from("manual_topic_revisions")
        .select("id, cause, actor_id, created_at")
        .eq("tenant_id", tenant.id)
        .eq("topic_id", topic.id)
        .order("created_at", { ascending: false })
        .limit(30),
      supabase.rpc("chat_people", { p_tenant_id: tenant.id }),
    ]);
  const people = (team ?? []) as Person[];
  const who = (userId: string | null) =>
    userId ? nameOf(people.find((p) => p.user_id === userId)) || "A teammate" : "Claude";
  const sources = ((sourceRows ?? []) as unknown as SourceRow[]).flatMap((row) => {
    const ticket = Array.isArray(row.tickets) ? row.tickets[0] : row.tickets;
    return ticket ? [{ ...ticket, id: row.ticket_id, at: row.added_at }] : [];
  });
  const revisions = (revisionRows ?? []) as {
    id: string;
    cause: string;
    actor_id: string | null;
    created_at: string;
  }[];
  const facetLabel = (facetId: string) =>
    config.facets.find((f) => f.id === facetId)?.label ?? null;

  return (
    <>
      <PageHeader
        title={topic.title}
        description={topic.summary || undefined}
        back={{ href: base, label: config.name }}
      >
        {canWrite && (
          <Button asChild variant="outline">
            <Link href={`${here}?edit=1`}>Edit</Link>
          </Button>
        )}
        {manager && canWrite && (
          <form
            action={publishTopic.bind(null, tenant.slug, topic.id, topic.status !== "published")}
          >
            <Button type="submit" variant={topic.status === "published" ? "outline" : "default"}>
              {topic.status === "published" ? "Unpublish" : "Publish"}
            </Button>
          </form>
        )}
      </PageHeader>

      <div className="flex flex-wrap items-center gap-1.5 text-sm">
        <Badge tone={topic.status === "published" ? "good" : "waiting"}>
          {topic.status === "published" ? "Published" : "Draft"}
        </Badge>
        {topic.facets.map((f) => (
          <Badge key={`${f.facet}:${f.value}`} tone="open">
            {facetLabel(f.facet) ? `${facetLabel(f.facet)}: ` : ""}
            {f.value}
          </Badge>
        ))}
        <span className="text-muted-foreground">
          {topic.personEdited ? "Edited by the team" : "Written by Claude"} · updated{" "}
          {manualDay(topic.updatedAt, tenant.timezone)}
        </span>
      </div>

      {topic.status === "draft" && (
        <p className="border-border bg-muted font-read max-w-prose rounded-md border px-3 py-2 text-sm">
          A draft is only in this list. Once it is published it shows up beside matching
          conversations and in the reply box’s “Manual” picker
          {config.use_in_drafts ? ", and Claude may lean on it when drafting a reply" : ""}.
          {!manager && " An owner or admin publishes it."}
        </p>
      )}

      {suggestions.map((suggestion) => (
        <Card key={suggestion.id} className="border-ochre/40">
          <CardHeader>
            <CardTitle>Suggested update</CardTitle>
            <CardDescription>
              From {suggestion.ticketIds.length === 1 ? "a conversation" : "conversations"} read on{" "}
              {manualDay(suggestion.createdAt, tenant.timezone)}. Your words stay as they are:
              accepting adds these points under their headings.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <div className="font-read flex flex-col gap-2 text-sm">
              {suggestion.additions.map((addition) => (
                <div key={addition.section}>
                  <p className="font-sans text-xs font-bold">{addition.section}</p>
                  <ul className="list-disc pl-5">
                    {addition.points.map((point) => (
                      <li key={point}>{point}</li>
                    ))}
                  </ul>
                </div>
              ))}
              {suggestion.newFacets.length > 0 && (
                <p className="text-muted-foreground">
                  Also labels it: {suggestion.newFacets.map((f) => f.value).join(", ")}
                </p>
              )}
            </div>
            {canWrite && (
              <div className="flex flex-wrap gap-2">
                <form
                  action={acceptSuggestion.bind(null, tenant.slug, topic.id, suggestion.id, false)}
                >
                  <Button type="submit" variant="outline" size="sm">
                    Accept
                  </Button>
                </form>
                <form
                  action={acceptSuggestion.bind(null, tenant.slug, topic.id, suggestion.id, true)}
                >
                  <Button type="submit" variant="outline" size="sm">
                    Accept and edit
                  </Button>
                </form>
                <form action={dismissSuggestion.bind(null, tenant.slug, suggestion.id)}>
                  <Button type="submit" variant="ghost" size="sm">
                    Dismiss
                  </Button>
                </form>
              </div>
            )}
          </CardContent>
        </Card>
      ))}

      <Card>
        <CardContent>
          <DocView doc={topic.body} />
        </CardContent>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Conversations it drew on</CardTitle>
            <CardDescription>
              {sources.length === 0
                ? "None: this one was written by hand."
                : "Only the links are kept here, none of the customers' words."}
            </CardDescription>
          </CardHeader>
          {sources.length > 0 && (
            <CardContent>
              <ul className="flex flex-col gap-1 text-sm">
                {sources.map((source) => (
                  <li key={source.id}>
                    <Link
                      href={`/w/${tenant.slug}/helpdesk?view=all&t=${source.number}`}
                      className="hover:underline"
                    >
                      <span className="text-muted-foreground">#{source.number}</span>{" "}
                      <span className="font-read">{source.subject}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            </CardContent>
          )}
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>History</CardTitle>
            <CardDescription>Every change, and a way back to each.</CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="flex flex-col gap-2 text-sm">
              {revisions.map((revision, at) => (
                <li key={revision.id} className="flex flex-wrap items-center justify-between gap-2">
                  <span>
                    {CAUSES[revision.cause] ?? "Changed"}
                    <span className="text-muted-foreground">
                      {" "}
                      · {who(revision.actor_id)} · {manualDay(revision.created_at, tenant.timezone)}
                    </span>
                  </span>
                  {at > 0 && canWrite && (
                    <form action={restoreRevision.bind(null, tenant.slug, topic.id, revision.id)}>
                      <Button type="submit" variant="ghost" size="sm">
                        Bring this version back
                      </Button>
                    </form>
                  )}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      </div>

      {manager && canWrite && (
        <div className="border-border flex flex-wrap items-center justify-between gap-3 border-t pt-4">
          <form
            action={setTopicInDrafts.bind(null, tenant.slug, topic.id, !topic.useInDrafts)}
            className="flex items-center gap-2 text-sm"
          >
            <span className="text-muted-foreground">
              {topic.useInDrafts
                ? "Claude may use this topic as reference when drafting a reply, once it is published."
                : "Claude doesn't use this topic when drafting replies."}
            </span>
            <Button type="submit" variant="ghost" size="sm">
              {topic.useInDrafts ? "Don't use it" : "Use it"}
            </Button>
          </form>
          <details className="text-sm">
            <summary className="text-muted-foreground cursor-pointer">Delete this topic…</summary>
            <form
              action={deleteTopic.bind(null, tenant.slug, topic.id)}
              className="mt-2 flex flex-col items-start gap-2"
            >
              <p className="font-read max-w-prose">
                The topic and its history go for good. Its conversations aren&apos;t read again.
              </p>
              <Button type="submit" variant="outline" size="sm">
                Delete for good
              </Button>
            </form>
          </details>
        </div>
      )}
    </>
  );
}
