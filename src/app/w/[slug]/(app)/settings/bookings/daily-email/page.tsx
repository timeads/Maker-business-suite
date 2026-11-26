import type { Metadata } from "next";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { SectionHeading } from "@/components/settings/section-heading";
import { BOOKINGS_MODULE } from "@/lib/bookings/config";
import { DAILY_KEY, hourWords, parseDailyEmail } from "@/lib/bookings/daily-config";
import { createClient } from "@/lib/supabase/server";
import { canManage } from "@/lib/tenants";
import { DailyEmailForm } from "../../../bookings/daily-email-form";
import { bookingsAccess } from "../../../bookings/gate";

export const metadata: Metadata = { title: "Daily email" };

const STATUS: Record<string, { tone: "good" | "bad" | "waiting" | "closed"; words: string }> = {
  sent: { tone: "good", words: "Sent" },
  failed: { tone: "bad", words: "Didn't go" },
  unsure: { tone: "waiting", words: "Not sure it went" },
  sending: { tone: "waiting", words: "On its way" },
  skipped: { tone: "closed", words: "Not sent" },
};

/**
 * Settings → Bookings → Daily email: a short note each morning (or whenever
 * you like) of today's and tomorrow's classes, new bookings and anything that
 * needs you. Owners and admins choose who gets it.
 */
export default async function DailyEmailSettings({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const access = await bookingsAccess(slug, `/w/${slug}/settings/bookings/daily-email`);
  if (!access.ok) return access.upsell;
  const { tenant, role, entitlements } = access;
  const manager = canManage(role);
  const canEdit = manager && entitlements.canWrite;

  const supabase = await createClient();
  const [{ data: config }, { data: members }, { data: recent }] = await Promise.all([
    supabase
      .from("configs")
      .select("body")
      .eq("tenant_id", tenant.id)
      .eq("module", BOOKINGS_MODULE)
      .eq("key", DAILY_KEY)
      .maybeSingle(),
    supabase.rpc("list_members", { p_tenant_id: tenant.id }),
    supabase
      .from("booking_daily_emails")
      .select("id, user_id, day, status, detail, finished_at")
      .eq("tenant_id", tenant.id)
      .order("day", { ascending: false })
      .limit(14),
  ]);
  const settings = parseDailyEmail(config?.body);
  const people = ((members ?? []) as { user_id: string; email: string; role: string }[]).map(
    (m) => ({ id: m.user_id, email: m.email, role: m.role }),
  );
  const emailOf = new Map(people.map((p) => [p.id, p.email]));
  const hours = Array.from({ length: 24 }, (_, h) => [h, hourWords(h)] as [number, string]);

  return (
    <>
      <SectionHeading
        back={{ href: `/w/${tenant.slug}/bookings`, label: "Bookings" }}
        title="Daily email"
        description="Once a day, a short email of today's and tomorrow's classes, the bookings that came in, and anything that needs you."
      />
      <Card>
        <CardHeader>
          <CardTitle>The daily email</CardTitle>
          <CardDescription>
            It goes at the hour you pick on your workspace&apos;s clock ({tenant.timezone}), once a
            day, even on the days the clocks change.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {canEdit ? (
            <DailyEmailForm slug={tenant.slug} settings={settings} members={people} hours={hours} />
          ) : (
            <p className="text-muted-foreground text-sm">
              {settings.on ? `It's on, at ${hourWords(settings.hour)}.` : "It's off."} An owner or
              admin chooses who gets it.
            </p>
          )}
        </CardContent>
      </Card>
      {manager && (recent ?? []).length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Lately</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="divide-border flex flex-col divide-y text-sm">
              {(
                (recent ?? []) as {
                  id: string;
                  user_id: string;
                  day: string;
                  status: string;
                  detail: string;
                }[]
              ).map((row) => {
                const state = STATUS[row.status] ?? STATUS.skipped;
                return (
                  <li key={row.id} className="flex flex-wrap items-center gap-2 py-2">
                    <span className="tabular-nums">{row.day}</span>
                    <span className="font-read">
                      {emailOf.get(row.user_id) ?? "Someone who left"}
                    </span>
                    <Badge tone={state.tone}>{state.words}</Badge>
                    {row.status !== "sent" && row.detail && (
                      <span className="text-muted-foreground text-xs">{row.detail}</span>
                    )}
                  </li>
                );
              })}
            </ul>
          </CardContent>
        </Card>
      )}
    </>
  );
}
