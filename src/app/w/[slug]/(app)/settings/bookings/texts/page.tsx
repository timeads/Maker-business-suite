import type { Metadata } from "next";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { SectionHeading } from "@/components/settings/section-heading";
import { BOOKINGS_MODULE } from "@/lib/bookings/config";
import { getSiteUrl } from "@/lib/site-url";
import { createClient } from "@/lib/supabase/server";
import { canManage } from "@/lib/tenants";
import { TEXTS_KEY, parseTextSettings, textsAsked } from "@/lib/texts/config";
import { sampleBooking } from "@/lib/texts/words";
import { bookingsAccess } from "../../../bookings/gate";
import { TestTextForm, TextsForm } from "../../../bookings/texts-form";

export const metadata: Metadata = { title: "Text reminders" };

/**
 * Settings → Bookings → Text reminders: texts through the business's own
 * Twilio account to people who ticked the box when they booked. Which texts
 * go, when, and the words (fixed words only, filled in by code).
 */
export default async function TextSettings({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const access = await bookingsAccess(slug, `/w/${slug}/settings/bookings/texts`);
  if (!access.ok) return access.upsell;
  const { tenant, role, entitlements } = access;
  const heading = (
    <SectionHeading
      back={{ href: `/w/${tenant.slug}/bookings`, label: "Bookings" }}
      title="Text reminders"
      description="Texts about a booking, from your own Twilio number, to people who asked for them when they booked."
    />
  );
  if (!entitlements.can("texts")) {
    return (
      <>
        {heading}
        <p className="text-muted-foreground text-sm">
          Text reminders aren&apos;t part of this workspace&apos;s plan right now.
        </p>
      </>
    );
  }
  const canEdit = canManage(role) && entitlements.canWrite;

  const supabase = await createClient();
  const [{ data: config }, { data: twilio }, site] = await Promise.all([
    supabase
      .from("configs")
      .select("body")
      .eq("tenant_id", tenant.id)
      .eq("module", BOOKINGS_MODULE)
      .eq("key", TEXTS_KEY)
      .maybeSingle(),
    // Name the columns: members can't read the whole row.
    supabase
      .from("connections")
      .select("status, metadata")
      .eq("tenant_id", tenant.id)
      .eq("provider", "twilio")
      .maybeSingle(),
    getSiteUrl(),
  ]);
  const settings = parseTextSettings(config?.body);
  const meta = (twilio?.metadata ?? {}) as { sender?: string; trial?: boolean };
  const connected = twilio?.status === "active";

  return (
    <>
      {heading}
      <Card>
        <CardHeader>
          <CardTitle>Your Twilio account</CardTitle>
          <CardDescription>
            Texts go from your own Twilio number and Twilio bills you for them. The step-by-step is
            in our guide to text reminders.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 text-sm">
          {connected ? (
            <p className="flex flex-wrap items-center gap-2">
              <Badge tone="good">Connected</Badge>
              {meta.sender ? `Texts come from ${meta.sender}.` : "Connected."}
              {meta.trial &&
                " It's a trial account, so it can only text numbers you've checked in Twilio."}
            </p>
          ) : (
            <p className="flex flex-wrap items-center gap-2">
              <Badge tone="waiting">Not connected</Badge>
              <span>
                Connect Twilio under{" "}
                <Link href={`/w/${tenant.slug}/connections`} className="underline">
                  Connections
                </Link>{" "}
                with your Account SID, auth token and number. Until then, nothing is sent and nobody
                is asked for a number.
              </span>
            </p>
          )}
          <div className="flex flex-col gap-1">
            <p className="font-semibold">So that STOP works</p>
            <p className="text-muted-foreground">
              In Twilio, open your phone number (or Messaging Service) and set “A message comes in”
              to this address, as an HTTP POST:
            </p>
            <code className="bg-sunken w-fit rounded px-2 py-1 text-xs break-all">
              {site}/api/webhooks/twilio
            </code>
            <p className="text-muted-foreground">
              When someone replies STOP, they get no more booking texts from you. Replying START
              doesn&apos;t sign them up again here: they tick the box on their next booking.
            </p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>The texts</CardTitle>
          <CardDescription>
            {textsAsked(settings)
              ? "On. People booking are offered a box for their mobile number and a tick."
              : "Off. Nobody is asked for a number and nothing is sent."}{" "}
            Times are on your workspace&apos;s clock ({tenant.timezone}).
          </CardDescription>
        </CardHeader>
        <CardContent>
          {canEdit ? (
            <TextsForm
              slug={tenant.slug}
              settings={settings}
              sample={sampleBooking(tenant.name, tenant.timezone)}
            />
          ) : (
            <p className="text-muted-foreground text-sm">
              An owner or admin can change text reminders.
            </p>
          )}
        </CardContent>
      </Card>

      {canEdit && connected && (
        <Card>
          <CardHeader>
            <CardTitle>Send yourself a test</CardTitle>
            <CardDescription>
              A test goes only to your own number, with a made-up booking: three an hour.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <TestTextForm slug={tenant.slug} />
          </CardContent>
        </Card>
      )}
    </>
  );
}
