import type { Metadata } from "next";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { SectionHeading } from "@/components/settings/section-heading";
import {
  BOOKINGS_MODULE,
  EMAILS_KEY,
  FORM_KEY,
  parseBookingEmails,
  parseBookingForm,
  questionsToText,
} from "@/lib/bookings/config";
import { createClient } from "@/lib/supabase/server";
import { canManage } from "@/lib/tenants";
import { BookingEmailsForm, BookingQuestionsForm } from "../../bookings/forms";
import { bookingsAccess } from "../../bookings/gate";

export const metadata: Metadata = { title: "Booking page settings" };

export default async function BookingSettingsPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const access = await bookingsAccess(slug, `/w/${slug}/settings/bookings`);
  if (!access.ok) return access.upsell;
  const { tenant, role, entitlements } = access;

  const supabase = await createClient();
  const { data } = await supabase
    .from("configs")
    .select("key, body")
    .eq("tenant_id", tenant.id)
    .eq("module", BOOKINGS_MODULE)
    .in("key", [FORM_KEY, EMAILS_KEY]);
  const body = (key: string) => (data ?? []).find((row) => row.key === key)?.body;
  const form = parseBookingForm(body(FORM_KEY));
  const emails = parseBookingEmails(body(EMAILS_KEY));
  const canEdit = canManage(role) && entitlements.canWrite;

  return (
    <>
      <SectionHeading
        back={{ href: `/w/${tenant.slug}/bookings`, label: "Bookings" }}
        title="Bookings"
        description="What you ask people when they book, and the emails they get from you."
      />
      <Card>
        <CardHeader>
          <CardTitle>Emails to your customers</CardTitle>
          <CardDescription>
            Everyone gets a confirmation with a link to change or cancel, then a reminder. Add your
            own words to each.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {canEdit ? (
            <BookingEmailsForm slug={tenant.slug} settings={emails} />
          ) : (
            <p className="text-muted-foreground text-sm">
              An owner or admin can change these emails.
            </p>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Extra questions</CardTitle>
          <CardDescription>
            Anything you need to know from people when they book. Their answers show next to their
            name on the list of who&apos;s coming.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {canEdit ? (
            <BookingQuestionsForm slug={tenant.slug} questions={questionsToText(form)} />
          ) : (
            <p className="text-muted-foreground text-sm">
              An owner or admin can change these questions.
            </p>
          )}
        </CardContent>
      </Card>
    </>
  );
}
