import type { Metadata } from "next";
import Link from "next/link";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  BOOKINGS_MODULE,
  FORM_KEY,
  parseBookingForm,
  questionsToText,
} from "@/lib/bookings/config";
import { createClient } from "@/lib/supabase/server";
import { canManage } from "@/lib/tenants";
import { BookingQuestionsForm } from "../forms";
import { bookingsAccess } from "../gate";

export const metadata: Metadata = { title: "Booking page settings" };

export default async function BookingSettingsPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const access = await bookingsAccess(slug, `/w/${slug}/bookings/settings`);
  if (!access.ok) return access.upsell;
  const { tenant, role, entitlements } = access;

  const supabase = await createClient();
  const { data } = await supabase
    .from("configs")
    .select("body")
    .eq("tenant_id", tenant.id)
    .eq("module", BOOKINGS_MODULE)
    .eq("key", FORM_KEY)
    .maybeSingle();
  const form = parseBookingForm(data?.body);

  return (
    <>
      <header className="flex flex-col gap-2">
        <Link
          href={`/w/${tenant.slug}/bookings`}
          className="text-muted-foreground text-sm hover:underline"
        >
          ← Bookings
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">Booking page settings</h1>
      </header>
      <Card>
        <CardHeader>
          <CardTitle>Extra questions</CardTitle>
          <CardDescription>
            Anything you need to know from people when they book. Their answers show next to their
            name on the list of who&apos;s coming.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {canManage(role) && entitlements.canWrite ? (
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
