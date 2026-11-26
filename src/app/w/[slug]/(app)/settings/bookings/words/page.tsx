import type { Metadata } from "next";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { SectionHeading } from "@/components/settings/section-heading";
import { readEmailSettings } from "@/lib/bookings/email-settings";
import {
  FILL_INS,
  MESSAGE_INFO,
  MESSAGE_KEYS,
  fillInsFor,
  noteFor,
  sampleBooking,
  sampleExtras,
  sampleStartsAt,
  wordsFor,
} from "@/lib/bookings/words";
import { getSiteUrl } from "@/lib/site-url";
import { createClient } from "@/lib/supabase/server";
import { canManage } from "@/lib/tenants";
import { bookingsAccess } from "../../../bookings/gate";
import { MessageEditor, ReplyToForm } from "../../../bookings/words-form";

export const metadata: Metadata = { title: "Email words" };

export default async function BookingWordsPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const access = await bookingsAccess(slug, `/w/${slug}/settings/bookings/words`);
  if (!access.ok) return access.upsell;
  const { tenant, role, entitlements } = access;
  const canEdit = canManage(role) && entitlements.canWrite;

  const supabase = await createClient();
  const [{ timing, words }, { data: service }] = await Promise.all([
    readEmailSettings(supabase, tenant.id),
    supabase
      .from("services")
      .select("name, location")
      .eq("tenant_id", tenant.id)
      .eq("kind", "workshop")
      .eq("active", true)
      .order("created_at")
      .limit(1)
      .maybeSingle(),
  ]);
  const site = await getSiteUrl();
  const sample = sampleBooking({
    workspaceName: tenant.name,
    timezone: tenant.timezone,
    serviceName: (service?.name as string | undefined) ?? undefined,
    location: (service?.location as string | undefined) ?? "",
    startsAt: sampleStartsAt(new Date(), tenant.timezone),
  });

  return (
    <>
      <SectionHeading
        back={{ href: `/w/${tenant.slug}/bookings`, label: "Bookings" }}
        title="Email words"
        description="What each booking email says, in your own words. We fill in the name, the workshop, the time and the rest for each person."
      />
      <Card>
        <CardHeader>
          <CardTitle>Replies</CardTitle>
          <CardDescription>
            Booking emails come from our address. When someone hits reply, it can land with you.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {canEdit ? (
            <ReplyToForm slug={tenant.slug} replyTo={words.reply_to} />
          ) : (
            <p className="text-muted-foreground text-sm">
              {words.reply_to
                ? `Replies go to ${words.reply_to}.`
                : "Replies go to the address the emails come from."}{" "}
              An owner or admin can change this.
            </p>
          )}
        </CardContent>
      </Card>
      <section aria-label="Booking emails" className="flex flex-col gap-2">
        <p className="text-muted-foreground text-sm">
          Open one to change it. “Send me a test” sends what&apos;s in the box to you, with a
          made-up booking, without saving it. The notes you add under{" "}
          <a className="underline" href={`/w/${tenant.slug}/settings/bookings`}>
            Emails &amp; questions
          </a>{" "}
          are where <code className="font-mono text-xs">{"{{note}}"}</code> sits.
        </p>
        {MESSAGE_KEYS.map((key) => {
          const chosen = wordsFor(key, words);
          const allowed = new Set(fillInsFor(key));
          return (
            <MessageEditor
              key={key}
              slug={tenant.slug}
              messageKey={key}
              name={MESSAGE_INFO[key].name}
              when={MESSAGE_INFO[key].when}
              subject={chosen.subject}
              body={chosen.body}
              changed={Boolean(words.messages[key])}
              fillIns={FILL_INS.filter((f) => allowed.has(f.name)).map(({ name, says }) => ({
                name,
                says,
              }))}
              sample={sample}
              extras={sampleExtras(key, sample, site, noteFor(key, timing))}
              canEdit={canEdit}
            />
          );
        })}
      </section>
    </>
  );
}
