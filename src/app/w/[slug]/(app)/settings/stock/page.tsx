import type { Metadata } from "next";
import { SectionHeading } from "@/components/settings/section-heading";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { createClient } from "@/lib/supabase/server";
import { canManage } from "@/lib/tenants";
import { loadStock } from "../../stock/data";
import { StockSettingsForm } from "../../stock/forms";
import { stockAccess } from "../../stock/gate";
import { SyncShopButton } from "../../stock/home-parts";

export const metadata: Metadata = { title: "Stock settings" };

/** Settings → Stock → Planning: the planning figures, and how the shop is kept in step. */
export default async function StockSettingsPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const access = await stockAccess(slug, `/w/${slug}/settings/stock`);
  if (!access.ok) return access.upsell;
  const { tenant, role, entitlements } = access;
  const supabase = await createClient();
  const [{ settings, link }, { data: books }, { data: syncs }] = await Promise.all([
    loadStock(supabase, tenant),
    supabase
      .from("connections")
      .select("status")
      .eq("tenant_id", tenant.id)
      .eq("provider", "quickbooks")
      .maybeSingle(),
    // The last ten reads of the shop (owners and admins can see the queue).
    canManage(role)
      ? supabase
          .from("sync_jobs")
          .select("id, type, status, attempts, error, started_at, finished_at, created_at")
          .eq("tenant_id", tenant.id)
          .eq("provider", "shopify")
          .in("type", ["full", "incremental"])
          .order("created_at", { ascending: false })
          .limit(10)
      : Promise.resolve({ data: [] }),
  ]);
  const runs = (syncs ?? []) as {
    id: number;
    type: string;
    status: "queued" | "running" | "succeeded" | "failed";
    attempts: number;
    error: string | null;
    started_at: string | null;
    finished_at: string | null;
    created_at: string;
  }[];
  const RUN_WORDS = {
    queued: { label: "Waiting its turn", tone: "closed" },
    running: { label: "Reading now", tone: "waiting" },
    succeeded: { label: "Done", tone: "good" },
    failed: { label: "Didn't finish", tone: "bad" },
  } as const;
  const clock = new Intl.DateTimeFormat("en-US", {
    timeZone: tenant.timezone,
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
  const took = (run: (typeof runs)[number]) => {
    if (!run.started_at || !run.finished_at) return null;
    const seconds = Math.max(
      0,
      Math.round((Date.parse(run.finished_at) - Date.parse(run.started_at)) / 1000),
    );
    return seconds < 90 ? `${seconds}s` : `${Math.round(seconds / 60)} min`;
  };
  const synced = link.lastSyncedAt
    ? new Intl.DateTimeFormat("en-US", {
        timeZone: tenant.timezone,
        dateStyle: "medium",
        timeStyle: "short",
      }).format(new Date(link.lastSyncedAt))
    : null;

  return (
    <>
      <SectionHeading
        back={{ href: `/w/${tenant.slug}/stock`, label: "Stock" }}
        title="Planning"
        description="How far ahead to plan, and how your shop is kept in step."
      />
      <Card>
        <CardHeader>
          <CardTitle>Planning</CardTitle>
          <CardDescription>
            {link.connected
              ? `Counts and sales come from your shop${synced ? `; last read ${synced}` : ""}.`
              : "Connect your shop under Connections to bring in your items and sales."}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {canManage(role) && entitlements.canWrite ? (
            <StockSettingsForm
              slug={tenant.slug}
              settings={settings}
              canPush={link.canPush}
              booksConnected={books?.status === "active"}
            />
          ) : (
            <p className="text-muted-foreground text-sm">
              An owner or admin can change these settings.
            </p>
          )}
        </CardContent>
      </Card>
      {canManage(role) && link.connected && (
        <Card>
          <CardHeader className="flex-row flex-wrap items-start justify-between gap-3">
            <div>
              <CardTitle>Reads of your shop</CardTitle>
              <CardDescription>
                The last ten times your items, counts and sales were read. It happens about once an
                hour by itself.
              </CardDescription>
            </div>
            {entitlements.canWrite && <SyncShopButton slug={tenant.slug} />}
          </CardHeader>
          <CardContent>
            {runs.length === 0 ? (
              <p className="text-muted-foreground text-sm">Nothing has been read yet.</p>
            ) : (
              <ul className="divide-border flex flex-col divide-y text-sm">
                {runs.map((run) => (
                  <li key={run.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-2">
                    <Badge tone={RUN_WORDS[run.status].tone}>{RUN_WORDS[run.status].label}</Badge>
                    <span className="min-w-0 flex-1 basis-56">
                      {run.type === "full" ? "Everything, from the start" : "What changed"}
                      {took(run) && (
                        <span className="text-muted-foreground"> · took {took(run)}</span>
                      )}
                      {run.attempts > 1 && (
                        <span className="text-muted-foreground"> · tried {run.attempts} times</span>
                      )}
                      {run.status === "failed" && run.error && (
                        <span className="text-brick font-read block text-xs">
                          {run.error.slice(0, 240)}
                        </span>
                      )}
                    </span>
                    <span className="text-muted-foreground tabular-nums">
                      {clock.format(new Date(run.started_at ?? run.created_at))}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      )}
    </>
  );
}
