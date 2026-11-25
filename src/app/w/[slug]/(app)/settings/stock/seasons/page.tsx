import type { Metadata } from "next";
import { SectionHeading } from "@/components/settings/section-heading";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { createClient } from "@/lib/supabase/server";
import { canManage } from "@/lib/tenants";
import { removeSeason } from "../../../stock/actions";
import { loadStock } from "../../../stock/data";
import { stockAccess } from "../../../stock/gate";
import { SeasonForm } from "../../../stock/season-forms";

export const metadata: Metadata = { title: "Seasons" };

/** Settings → Stock → Seasons: the busy times to have the shelves full for. */
export default async function StockSeasonsPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const access = await stockAccess(slug, `/w/${slug}/settings/stock/seasons`);
  if (!access.ok) return access.upsell;
  const { tenant, role, entitlements } = access;
  const supabase = await createClient();
  const { settings, seasons, today } = await loadStock(supabase, tenant);
  const seasonDay = (value: string) =>
    new Intl.DateTimeFormat("en-US", {
      timeZone: "UTC",
      month: "short",
      day: "numeric",
      year: "numeric",
    }).format(new Date(`${value}T12:00:00Z`));

  return (
    <>
      <SectionHeading
        back={{ href: `/w/${tenant.slug}/stock`, label: "Stock" }}
        title="Seasons"
        description="The busy times you want stock in for, and the last day to order for each."
      />
      <Card>
        <CardHeader>
          <CardTitle>Seasons to plan ahead for</CardTitle>
          <CardDescription>
            A busy time you want the shelves full for: a fair, the holidays, a sale. Say the day you
            want the stock in by and the &quot;To order&quot; tab shows the last day to order from
            each supplier. An extra lift raises that month&apos;s suggested orders on top of what
            your past sales show, for a push your history can&apos;t know about
            {settings.seasonality ? "." : " (it only counts while “plan for busy seasons” is on)."}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {seasons.length > 0 && (
            <ul className="divide-border flex flex-col divide-y text-sm">
              {[...seasons]
                .sort((a, b) => a.in_stock_by.localeCompare(b.in_stock_by))
                .map((season) => (
                  <li key={season.id} className="py-2 first:pt-0">
                    <details>
                      <summary className="flex cursor-pointer flex-wrap items-center gap-x-3 gap-y-1">
                        <span className="font-semibold">{season.name}</span>
                        <span className="text-muted-foreground">
                          in stock by {seasonDay(season.in_stock_by)}
                          {season.lift_pct > 0 && ` · +${season.lift_pct}%`}
                          {season.in_stock_by < today && " · passed"}
                        </span>
                        {season.note && (
                          <span className="text-muted-foreground font-read">{season.note}</span>
                        )}
                      </summary>
                      {canManage(role) && entitlements.canWrite && (
                        <div className="flex flex-col gap-2 pt-3">
                          <SeasonForm slug={tenant.slug} season={season} />
                          <form action={removeSeason.bind(null, tenant.slug, season.id)}>
                            <Button type="submit" variant="ghost" size="sm">
                              Take this season off
                            </Button>
                          </form>
                        </div>
                      )}
                    </details>
                  </li>
                ))}
            </ul>
          )}
          {canManage(role) && entitlements.canWrite ? (
            <SeasonForm key={seasons.length} slug={tenant.slug} />
          ) : (
            seasons.length === 0 && (
              <p className="text-muted-foreground text-sm">
                An owner or admin can add the first season.
              </p>
            )
          )}
        </CardContent>
      </Card>
    </>
  );
}
