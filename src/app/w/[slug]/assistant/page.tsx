import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getAiUsage } from "@/lib/ai/usage";
import { findConfig } from "@/lib/assistant/registry";
import { requireUser } from "@/lib/auth";
import { getEntitlements } from "@/lib/entitlements";
import { createClient } from "@/lib/supabase/server";
import { canManage, getTenantContext } from "@/lib/tenants";
import { previewProposal, type ProposalPreview } from "./preview";
import { Chat, ProposalCard, RestoreButton } from "./chat";

export const metadata: Metadata = { title: "Assistant" };

const SOURCES: Record<string, string> = {
  manual: "Changed by hand",
  assistant: "Assistant suggestion applied",
  restore: "Put back",
};

export default async function AssistantPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const user = await requireUser(`/w/${slug}/assistant`);
  const ctx = await getTenantContext(slug, user.id);
  if (!ctx) notFound();
  const { tenant, role } = ctx;
  const entitlements = await getEntitlements(tenant.id);
  const supabase = await createClient();
  const manager = canManage(role) && entitlements.canWrite;

  const [usage, { data: pending }, { data: versions }] = await Promise.all([
    getAiUsage(supabase, tenant.id, entitlements.limit("ai_credits")),
    supabase
      .from("config_proposals")
      .select("id, module, key, body, summary")
      .eq("tenant_id", tenant.id)
      .eq("status", "pending")
      .order("created_at", { ascending: false })
      .limit(5),
    supabase
      .from("config_versions")
      .select("id, module, key, version, source, note, created_at")
      .eq("tenant_id", tenant.id)
      .order("created_at", { ascending: false })
      .limit(8),
  ]);
  const waiting = (
    await Promise.all((pending ?? []).map((p) => previewProposal(supabase, tenant.id, p)))
  ).filter((p): p is ProposalPreview => p !== null);
  // The newest version of each setting is what's live now; only older ones can be put back.
  const live = new Set<string>();
  const history = (versions ?? []).map((v) => {
    const id = `${v.module}/${v.key}`;
    const current = !live.has(id);
    live.add(id);
    return { ...v, current, name: findConfig(v.module, v.key)?.name ?? id };
  });
  const when = new Intl.DateTimeFormat("en-US", {
    timeZone: tenant.timezone,
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
  const percent = usage.limit > 0 ? Math.min(100, Math.round((usage.used / usage.limit) * 100)) : 0;

  return (
    <>
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Assistant</h1>
        <p className="text-muted-foreground text-sm">
          Ask about your business, or ask for a change to how things are set up.
        </p>
      </header>

      <Card>
        <CardContent className="pt-6">
          <Chat
            slug={tenant.slug}
            canApply={manager}
            ready={
              Boolean(process.env.ANTHROPIC_API_KEY && process.env.SUPABASE_SECRET_KEY) &&
              entitlements.canWrite
            }
            initialUsage={entitlements.plan ? usage.state : "exhausted"}
          />
        </CardContent>
      </Card>

      {waiting.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Waiting for a decision</CardTitle>
            <CardDescription>
              Suggestions that haven&apos;t been applied or dismissed.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {waiting.map((proposal) => (
              <ProposalCard
                key={proposal.id}
                slug={tenant.slug}
                proposal={proposal}
                canApply={manager}
              />
            ))}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Recent changes</CardTitle>
          <CardDescription>
            Every change to your settings is kept, so anything can be put back.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {history.length === 0 ? (
            <p className="text-muted-foreground text-sm">No changes yet.</p>
          ) : (
            <ul className="divide-border flex flex-col divide-y">
              {history.map((v) => (
                <li key={v.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 py-2 text-sm">
                  <span className="font-medium">{v.name}</span>
                  <span className="text-muted-foreground flex-1">
                    {v.note ?? SOURCES[v.source as string]} · {when.format(new Date(v.created_at))}
                  </span>
                  {v.current ? (
                    <span className="text-muted-foreground">In use now</span>
                  ) : (
                    manager && <RestoreButton slug={tenant.slug} versionId={v.id as string} />
                  )}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <p className="text-muted-foreground text-xs">
        AI allowance used this month: {percent}%
        {entitlements.plan ? "" : " (pick a plan to use the assistant)"}
      </p>
    </>
  );
}
