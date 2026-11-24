import type { Metadata } from "next";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { FormMessage } from "@/components/ui/form-message";
import { PageHeader } from "@/components/ui/page-header";
import type { JobCounts } from "@/lib/michaels/would-send";
import { createClient } from "@/lib/supabase/server";
import { loadMichaels, loadWouldSend } from "../data";
import { michaelsAccess } from "../gate";
import { MichaelsTabs, WatchingBanner } from "../tabs";

export const metadata: Metadata = { title: "What Michaels would be sent" };

function Sums({ name, counts, skipped }: { name: string; counts: JobCounts; skipped: string }) {
  return (
    <div className="bg-card border-border rounded-lg border px-4 py-3">
      <dt className="text-muted-foreground text-xs font-semibold">{name}</dt>
      <dd className="mt-1 text-xl leading-tight font-bold tabular-nums">
        {counts.differ + counts.unknown} would change
      </dd>
      <dd className="text-muted-foreground mt-1.5 text-xs">
        {counts.checked} checked, {counts.same} already right
        {counts.unknown > 0 ? `, ${counts.unknown} where Michaels' figure wasn't read` : ""}
        {counts.skipped > 0 ? `, ${counts.skipped} ${skipped}` : ""}
      </dd>
    </div>
  );
}

export default async function MichaelsWouldSendPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const access = await michaelsAccess(slug, `/w/${slug}/stock/michaels/would-send`);
  if (!access.ok) return access.upsell;
  const { tenant } = access;
  const supabase = await createClient();
  const [{ settings }, latest] = await Promise.all([
    loadMichaels(supabase, tenant),
    loadWouldSend(supabase, tenant.id),
  ]);
  const when = (value: string | null) =>
    value
      ? new Intl.DateTimeFormat("en-US", {
          timeZone: tenant.timezone,
          dateStyle: "medium",
          timeStyle: "short",
        }).format(new Date(value))
      : "";
  const counts = latest?.run.counts ?? {};
  const blocked = latest?.run.send_blocked === "unmatched";

  return (
    <>
      <PageHeader
        title="Michaels Marketplace"
        description="The stock and prices the last look would have sent. None of it was."
        back={{ href: `/w/${tenant.slug}/stock`, label: "Stock" }}
      />
      <MichaelsTabs slug={tenant.slug} />
      <WatchingBanner />

      {!latest ? (
        <Card>
          <CardHeader>
            <CardTitle>Nothing worked out yet</CardTitle>
            <CardDescription>
              After the first look, this page lists every listing whose stock or price on Michaels
              differs from what your shop says it should be.
            </CardDescription>
          </CardHeader>
        </Card>
      ) : (
        <>
          {blocked && (
            <FormMessage>
              Safety stop: more than one listing in ten has no item in your shop. Even with sending
              switched on, none of this could go until they are paired on the Listings tab.
            </FormMessage>
          )}
          <dl className="grid gap-3 sm:grid-cols-2">
            {counts.stock && (
              <Sums name="Stock" counts={counts.stock} skipped="your shop keeps no count of" />
            )}
            {counts.prices && (
              <Sums name="Prices" counts={counts.prices} skipped="with no price in your shop" />
            )}
          </dl>
          <Card>
            <CardHeader>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <CardTitle>
                  {latest.changes.length === 0
                    ? "Michaels is in step with your shop"
                    : `${latest.changes.length}${counts.more_changes ? " or more" : ""} would change`}
                </CardTitle>
                <Badge tone="open">Not sent</Badge>
              </div>
              <CardDescription>
                As of {when(latest.run.finished_at)}. Stock is your shop&apos;s count less{" "}
                {settings.units_held_back} held back, never below zero. Prices are exactly your
                shop&apos;s.
              </CardDescription>
            </CardHeader>
            {latest.changes.length > 0 && (
              <CardContent>
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[560px] text-left text-sm">
                    <thead className="text-muted-foreground text-xs">
                      <tr>
                        <th className="py-2 pr-3 font-semibold">Item</th>
                        <th className="py-2 pr-3 font-semibold">What</th>
                        <th className="py-2 pr-3 text-right font-semibold">Michaels has</th>
                        <th className="py-2 text-right font-semibold">Would become</th>
                      </tr>
                    </thead>
                    <tbody className="divide-border divide-y">
                      {latest.changes.map((change) => {
                        const show = (value: string) =>
                          change.kind === "price" ? `$${value}` : value;
                        return (
                          <tr key={`${change.kind}:${change.michaels_sku_number}`}>
                            <td className="py-2 pr-3">
                              <div>{change.item_name || "Unnamed item"}</div>
                              <div className="text-muted-foreground font-mono text-xs break-all">
                                {change.seller_sku}
                              </div>
                            </td>
                            <td className="py-2 pr-3">
                              {change.kind === "stock" ? "Stock" : "Price"}
                            </td>
                            <td className="py-2 pr-3 text-right tabular-nums">
                              {change.from === null ? (
                                <span className="text-muted-foreground">Not read</span>
                              ) : (
                                show(change.from)
                              )}
                            </td>
                            <td className="py-2 text-right font-semibold tabular-nums">
                              {show(change.to)}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                {counts.more_changes && (
                  <p className="text-muted-foreground mt-3 text-xs">
                    There are more than this list keeps. The sums above count all of them.
                  </p>
                )}
              </CardContent>
            )}
          </Card>
        </>
      )}
    </>
  );
}
