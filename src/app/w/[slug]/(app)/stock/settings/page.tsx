import type { Metadata } from "next";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { googleMailConfigured } from "@/lib/connections/providers/google-mail";
import { STOCK_MODULE } from "@/lib/stock/config";
import { PO_EMAIL_KEY, parsePoEmail } from "@/lib/stock/po/email";
import { createClient } from "@/lib/supabase/server";
import { canManage } from "@/lib/tenants";
import { removeSeason } from "../actions";
import { loadStock } from "../data";
import { StockSettingsForm } from "../forms";
import { SeasonForm } from "../season-forms";
import { stockAccess } from "../gate";
import { StockTabs } from "../tabs";
import { OrderEmailTemplateForm } from "./email-template-form";

export const metadata: Metadata = { title: "Stock settings" };

export default async function StockSettingsPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const access = await stockAccess(slug, `/w/${slug}/stock/settings`);
  if (!access.ok) return access.upsell;
  const { tenant, role, entitlements } = access;
  const supabase = await createClient();
  const [{ settings, link, seasons, today }, { data: emailConfig }] = await Promise.all([
    loadStock(supabase, tenant),
    supabase
      .from("configs")
      .select("body")
      .eq("tenant_id", tenant.id)
      .eq("module", STOCK_MODULE)
      .eq("key", PO_EMAIL_KEY)
      .maybeSingle(),
  ]);
  const emailTemplate = parsePoEmail(emailConfig?.body);
  const seasonDay = (value: string) =>
    new Intl.DateTimeFormat("en-US", {
      timeZone: "UTC",
      month: "short",
      day: "numeric",
      year: "numeric",
    }).format(new Date(`${value}T12:00:00Z`));
  const synced = link.lastSyncedAt
    ? new Intl.DateTimeFormat("en-US", {
        timeZone: tenant.timezone,
        dateStyle: "medium",
        timeStyle: "short",
      }).format(new Date(link.lastSyncedAt))
    : null;

  return (
    <>
      <PageHeader
        title="Stock"
        description="How far ahead to plan, and how your shop is kept in step."
      />
      <StockTabs slug={tenant.slug} manager={canManage(role)} />
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
            <StockSettingsForm slug={tenant.slug} settings={settings} canPush={link.canPush} />
          ) : (
            <p className="text-muted-foreground text-sm">
              An owner or admin can change these settings.
            </p>
          )}
        </CardContent>
      </Card>
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
      {canManage(role) && entitlements.canWrite && googleMailConfigured() && (
        <Card>
          <CardHeader>
            <CardTitle>Emailing orders</CardTitle>
            <CardDescription>
              What an order&apos;s email starts out saying when you send it from your own Gmail. You
              can change any one of them before it goes. Connect Gmail under{" "}
              <Link href={`/w/${tenant.slug}/connections`} className="underline">
                Connections
              </Link>
              .
            </CardDescription>
          </CardHeader>
          <CardContent>
            <OrderEmailTemplateForm
              slug={tenant.slug}
              template={emailTemplate}
              workspaceName={tenant.name}
            />
          </CardContent>
        </Card>
      )}
      {canManage(role) && (
        <Card>
          <CardHeader>
            <CardTitle>Bring your records across</CardTitle>
            <CardDescription>
              Coming from another stock tool or a spreadsheet? Bring in your suppliers, planning
              figures, past and open orders, supplier accounts and history as CSV files.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button asChild variant="outline">
              <Link href={`/w/${tenant.slug}/stock/settings/import`}>Bring in a file</Link>
            </Button>
          </CardContent>
        </Card>
      )}
    </>
  );
}
