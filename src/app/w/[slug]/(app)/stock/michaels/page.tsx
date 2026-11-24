import type { Metadata } from "next";
import Link from "next/link";
import { Badge, type BadgeTone } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { FormMessage } from "@/components/ui/form-message";
import { PageHeader } from "@/components/ui/page-header";
import type { KeyExpiry } from "@/lib/michaels/mapping";
import type { SyncHealthLevel } from "@/lib/michaels/health";
import { createClient } from "@/lib/supabase/server";
import { canManage } from "@/lib/tenants";
import { loadMichaels, type RunRow } from "./data";
import { LookNowButton } from "./forms";
import { michaelsAccess } from "./gate";
import { MichaelsTabs, WatchingBanner } from "./tabs";

export const metadata: Metadata = { title: "Michaels" };

const HEALTH: Record<SyncHealthLevel, { label: string; tone: BadgeTone; note: string }> = {
  off: { label: "Switched off", tone: "closed", note: "Nothing is being read." },
  never: {
    label: "Waiting for its first look",
    tone: "waiting",
    note: "The first look happens within a few minutes of switching on.",
  },
  ok: { label: "Looking every hour", tone: "good", note: "The last look worked." },
  stale: {
    label: "Hasn't looked lately",
    tone: "bad",
    note: "No look has worked in the last three hours.",
  },
};

const RUN_WORDS: Record<RunRow["status"], { label: string; tone: BadgeTone }> = {
  queued: { label: "Waiting its turn", tone: "closed" },
  running: { label: "Looking now", tone: "waiting" },
  done: { label: "Done", tone: "good" },
  failed: { label: "Didn't finish", tone: "bad" },
};

function keyWords(key: KeyExpiry): { label: string; tone: BadgeTone; note: string } {
  const days = (n: number) => `${n} day${n === 1 ? "" : "s"}`;
  if (key.level === "unknown" || key.daysToReplace === null) {
    return {
      label: "Age not known",
      tone: "closed",
      note: "Connect again to give the key's date.",
    };
  }
  if (key.level === "expired") {
    return {
      label: "Run out",
      tone: "bad",
      note: `Michaels ended this key on ${key.expiresOn}. Connect again with a new one.`,
    };
  }
  if (key.daysToReplace <= 0) {
    return {
      label: "Replace now",
      tone: "bad",
      note: `Past 60 days, when Michaels keys start misbehaving. Michaels ends it on ${key.expiresOn}.`,
    };
  }
  return {
    label: `Replace in ${days(key.daysToReplace)}`,
    tone: key.level === "ok" ? "good" : key.level === "warn" ? "waiting" : "bad",
    note: `Replace by ${key.replaceOn}. Michaels ends it on ${key.expiresOn}.`,
  };
}

export default async function MichaelsPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const access = await michaelsAccess(slug, `/w/${slug}/stock/michaels`);
  if (!access.ok) return access.upsell;
  const { tenant, role, entitlements } = access;
  const manager = canManage(role);
  const base = `/w/${tenant.slug}/stock/michaels`;
  const michaels = await loadMichaels(await createClient(), tenant);
  const clock = new Intl.DateTimeFormat("en-US", {
    timeZone: tenant.timezone,
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
  const when = (value: string | null) => (value ? clock.format(new Date(value)) : "Not yet");

  if (!michaels.connected) {
    return (
      <>
        <PageHeader
          title="Michaels Marketplace"
          description="Match your Michaels listings to your stock and see what would be sent."
          back={{ href: `/w/${tenant.slug}/stock`, label: "Stock" }}
        />
        <Card>
          <CardHeader>
            <CardTitle>Connect your Michaels seller account</CardTitle>
            <CardDescription>
              You&apos;ll need an API key from the Michaels Developer Account Center. Once it&apos;s
              connected we match your listings to your stock and show what would be sent. For now it
              only watches: nothing on Michaels or in your shop is changed.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {manager ? (
              <Button asChild>
                <Link href={`/w/${tenant.slug}/connections`}>Open Connections</Link>
              </Button>
            ) : (
              <p className="text-muted-foreground text-sm">
                An owner or admin can connect it under Connections.
              </p>
            )}
          </CardContent>
        </Card>
      </>
    );
  }

  const { settings, lastFinished, openRun, health, key } = michaels;
  const counts = michaels.runs.find((run) => run.counts.listings)?.counts ?? {};
  const listings = counts.listings ?? null;
  const healthWords = HEALTH[health.level];
  const keyInfo = keyWords(key);
  const blocked = lastFinished?.send_blocked === "unmatched";
  const canLook =
    manager && entitlements.canWrite && settings.enabled && michaels.status === "active";
  const tiles: { label: string; value: string; note: string; bad?: boolean; href?: string }[] = [
    {
      label: "Listings matched",
      value: listings ? `${listings.matched} of ${listings.skus}` : "–",
      note: listings
        ? listings.unmatched === 0
          ? "Every listing has its item"
          : `${listings.unmatched} need a look`
        : "After the first look",
      bad: blocked,
      href: `${base}/listings`,
    },
    {
      label: "Would change",
      value: listings ? String(counts.changes ?? 0) + (counts.more_changes ? "+" : "") : "–",
      note: "Stock and prices that differ",
      href: `${base}/would-send`,
    },
    {
      label: "Orders seen",
      value: counts.orders ? String(counts.orders.seen) : "–",
      note: counts.orders
        ? counts.orders.need_pairing > 0
          ? `${counts.orders.need_pairing} with a SKU we don't know`
          : "All with known SKUs"
        : "Orders aren't being read",
      bad: (counts.orders?.need_pairing ?? 0) > 0,
      href: `${base}/orders`,
    },
    { label: "API key", value: keyInfo.label, note: keyInfo.note, bad: keyInfo.tone === "bad" },
  ];
  const errors = Object.entries(lastFinished?.counts.job_errors ?? {});

  return (
    <>
      <PageHeader
        title="Michaels Marketplace"
        description="What's on Michaels, how it matches your stock, and what would be sent."
        back={{ href: `/w/${tenant.slug}/stock`, label: "Stock" }}
      >
        {canLook && <LookNowButton slug={tenant.slug} busy={openRun !== null} />}
      </PageHeader>
      <MichaelsTabs slug={tenant.slug} />
      <WatchingBanner />

      {michaels.status === "needs_reconnect" && (
        <FormMessage>
          Michaels stopped accepting the saved API key. Make a new key and connect again under
          Connections.
        </FormMessage>
      )}
      {!settings.enabled && michaels.status === "active" && (
        <Card>
          <CardHeader>
            <CardTitle>Michaels is connected but switched off</CardTitle>
            <CardDescription>
              Nothing is read until it is switched on. Even then it only watches.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {manager ? (
              <Button asChild>
                <Link href={`${base}/settings`}>Open settings</Link>
              </Button>
            ) : (
              <p className="text-muted-foreground text-sm">An owner or admin can switch it on.</p>
            )}
          </CardContent>
        </Card>
      )}

      <dl className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        {tiles.map((tile) => (
          <div key={tile.label} className="bg-card border-border rounded-lg border px-4 py-3">
            <dt className="text-muted-foreground text-xs font-semibold">
              {tile.href ? (
                <Link href={tile.href} className="hover:underline">
                  {tile.label}
                </Link>
              ) : (
                tile.label
              )}
            </dt>
            <dd
              className={`mt-1 text-xl leading-tight font-bold tabular-nums ${tile.bad ? "text-brick" : ""}`}
            >
              {tile.value}
            </dd>
            <dd className="text-muted-foreground mt-1.5 text-xs">{tile.note}</dd>
          </div>
        ))}
      </dl>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <CardTitle>Connection</CardTitle>
              <Badge tone={michaels.status === "active" ? "good" : "bad"}>
                {michaels.status === "active" ? "Connected" : "Needs reconnecting"}
              </Badge>
            </div>
            <CardDescription>
              {michaels.environment === "sandbox"
                ? "Connected to Michaels' sandbox, for testing."
                : "Connected to the real marketplace."}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[auto_1fr]">
              <dt className="text-muted-foreground">Looking</dt>
              <dd className="flex flex-wrap items-center gap-2">
                <Badge tone={healthWords.tone}>{healthWords.label}</Badge>
                <span className="text-muted-foreground text-xs">{healthWords.note}</span>
              </dd>
              <dt className="text-muted-foreground">API key</dt>
              <dd className="flex flex-wrap items-center gap-2">
                <Badge tone={keyInfo.tone}>{keyInfo.label}</Badge>
                <span className="text-muted-foreground text-xs">{keyInfo.note}</span>
              </dd>
              <dt className="text-muted-foreground">Sending</dt>
              <dd className="flex flex-wrap items-center gap-2">
                <Badge tone="open">Watching only</Badge>
                <span className="text-muted-foreground text-xs">
                  Nothing is sent to Michaels or to your shop.
                </span>
              </dd>
            </dl>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <CardTitle>Last look</CardTitle>
              {lastFinished && (
                <Badge tone={RUN_WORDS[lastFinished.status].tone}>
                  {RUN_WORDS[lastFinished.status].label}
                </Badge>
              )}
            </div>
            <CardDescription>
              {lastFinished
                ? `${when(lastFinished.finished_at)}${lastFinished.source === "manual" ? ", asked for by hand" : ""}`
                : "No look has finished yet."}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3 text-sm">
            {lastFinished?.error && <FormMessage>{lastFinished.error}</FormMessage>}
            {errors.length > 1 && (
              <ul className="text-muted-foreground list-disc pl-5 text-xs">
                {errors.map(([name, text]) => (
                  <li key={name}>
                    {name}: {text}
                  </li>
                ))}
              </ul>
            )}
            {lastFinished && (
              <div className="flex flex-wrap items-center gap-2">
                <Badge
                  tone={
                    blocked ? "bad" : lastFinished.send_blocked === "no_scan" ? "closed" : "good"
                  }
                >
                  {blocked
                    ? "Safety stop: too many unmatched"
                    : lastFinished.send_blocked === "no_scan"
                      ? "No listings read yet"
                      : "Matches are good enough"}
                </Badge>
                <span className="text-muted-foreground text-xs">
                  {blocked
                    ? "More than one listing in ten has no item. Nothing could be sent until that is sorted out, on the Listings tab."
                    : "If more than one listing in ten had no item, nothing could ever be sent."}
                </span>
              </div>
            )}
            {listings && (
              <p className="text-muted-foreground text-xs">
                Read {listings.skus} listing{listings.skus === 1 ? "" : "s"} in {listings.pages}{" "}
                page{listings.pages === 1 ? "" : "s"}
                {listings.complete ? "" : " (the catalog was too long to finish in one look)"}.
              </p>
            )}
          </CardContent>
        </Card>
      </div>

      {michaels.runs.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Recent looks</CardTitle>
            <CardDescription>About one an hour while switched on.</CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="divide-border divide-y text-sm">
              {michaels.runs.slice(0, 8).map((run) => (
                <li key={run.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
                  <span className="w-36 tabular-nums">{when(run.created_at)}</span>
                  <Badge tone={RUN_WORDS[run.status].tone}>{RUN_WORDS[run.status].label}</Badge>
                  <span className="text-muted-foreground text-xs">
                    {run.status === "failed" && run.error
                      ? run.error
                      : run.counts.listings
                        ? `${run.counts.listings.matched} of ${run.counts.listings.skus} matched, ${run.counts.changes ?? 0} would change`
                        : ""}
                  </span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}
    </>
  );
}
