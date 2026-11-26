import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { SectionHeading } from "@/components/settings/section-heading";
import { isBookingImportKind } from "@/lib/bookings/import/files";
import { BOOKING_IMPORT_GUIDE, BOOKING_IMPORT_ORDER } from "@/lib/bookings/import/guide";
import { bookingCountLines } from "@/lib/bookings/import/words";
import { createClient } from "@/lib/supabase/server";
import { canManage } from "@/lib/tenants";
import { bookingsAccess } from "../../../bookings/gate";
import { BookingImporter } from "./importer";
import { WordingImporter } from "./wording-importer";

export const metadata: Metadata = { title: "Bring your bookings across" };

/**
 * Settings → Bookings → Bring your bookings across: workshops, dates and
 * bookings from the booking app a business used before, from spreadsheets.
 * docs/bookings-import.md is the guide for people.
 */
export default async function BookingImportPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const access = await bookingsAccess(slug, `/w/${slug}/settings/bookings/import`);
  if (!access.ok) return access.upsell;
  const { tenant, role, entitlements } = access;
  if (!canManage(role)) notFound();

  const supabase = await createClient();
  const { data: past } = await supabase
    .from("booking_imports")
    .select("id, kind, file_name, counts, created_at")
    .eq("tenant_id", tenant.id)
    .order("created_at", { ascending: false })
    .limit(30);
  const when = new Intl.DateTimeFormat("en-US", {
    timeZone: tenant.timezone,
    dateStyle: "medium",
    timeStyle: "short",
  });

  return (
    <>
      <SectionHeading
        back={{ href: `/w/${tenant.slug}/bookings`, label: "Bookings" }}
        title="Bring your bookings across"
        description="Workshops, dates and who's booked, from the booking app you used before, as spreadsheets saved as CSV."
      />
      <Card>
        <CardHeader>
          <CardTitle>Bring in a file</CardTitle>
          <CardDescription>
            You&apos;ll see what a file would change before anything is saved. Nobody is emailed,
            bringing the same file in twice changes nothing, and the file itself isn&apos;t kept.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {entitlements.canWrite ? (
            <BookingImporter slug={tenant.slug} />
          ) : (
            <p className="text-muted-foreground text-sm">
              This workspace is read-only because its plan has ended. Pick a plan to bring bookings
              in.
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>4. Message wording</CardTitle>
          <CardDescription>
            The earlier app&apos;s own words for each email and text: a spreadsheet with the columns
            key, channel (email or text), subject and body. Its fill-ins are changed to ours,
            anything without a match is taken out and said so, and you see every message before
            it&apos;s saved. Words only: no text is switched on, and nothing is sent.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {entitlements.canWrite ? (
            <WordingImporter slug={tenant.slug} />
          ) : (
            <p className="text-muted-foreground text-sm">This workspace is read-only.</p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>What each file needs</CardTitle>
          <CardDescription>
            Bring them in this order: dates point at workshops, and bookings at dates. The first
            line of a file names its columns; their order doesn&apos;t matter, and ones we
            don&apos;t know are ignored. Times with no time zone are read on your workspace&apos;s
            clock ({tenant.timezone.replace(/_/g, " ")}).
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          {BOOKING_IMPORT_ORDER.map((kind, index) => {
            const guide = BOOKING_IMPORT_GUIDE[kind];
            return (
              <details key={kind} className="border-border rounded-lg border px-3 py-2">
                <summary className="cursor-pointer text-sm font-semibold">
                  {index + 1}. {guide.title}
                </summary>
                <p className="font-read text-muted-foreground mt-2 text-sm">
                  {guide.about} {guide.matchedBy}
                </p>
                <div className="overflow-x-auto">
                  <table className="mt-2 w-full min-w-[420px] text-left text-sm">
                    <thead className="text-muted-foreground text-xs">
                      <tr>
                        <th className="py-1 pr-3 font-semibold">Column</th>
                        <th className="py-1 font-semibold">What goes in it</th>
                      </tr>
                    </thead>
                    <tbody className="divide-border divide-y">
                      {guide.columns.map((column) => (
                        <tr key={column.name} className="align-top">
                          <td className="py-1 pr-3 font-mono text-xs whitespace-nowrap">
                            {column.name}
                            {column.needed && (
                              <span className="text-brick font-sans"> (needed)</span>
                            )}
                          </td>
                          <td className="font-read py-1">{column.about}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </details>
            );
          })}
        </CardContent>
      </Card>

      {(past ?? []).length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>What&apos;s been brought in</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="divide-border flex flex-col divide-y text-sm">
              {(past ?? []).map((row) => {
                const kind = String(row.kind);
                const counts = row.counts as Parameters<typeof bookingCountLines>[1];
                return (
                  <li key={row.id as string} className="flex flex-wrap gap-x-4 gap-y-1 py-2">
                    <span className="w-36 font-semibold">
                      {isBookingImportKind(kind) ? BOOKING_IMPORT_GUIDE[kind].title : kind}
                    </span>
                    <span className="font-read min-w-0 flex-1 basis-56">
                      {isBookingImportKind(kind)
                        ? bookingCountLines(
                            kind,
                            {
                              ...counts,
                              refused: Array.isArray(counts?.refused) ? counts.refused : [],
                            },
                            true,
                          ).join("; ")
                        : ""}
                      {row.file_name ? (
                        <span className="text-muted-foreground"> · {row.file_name as string}</span>
                      ) : null}
                    </span>
                    <span className="text-muted-foreground">
                      {when.format(new Date(row.created_at as string))}
                    </span>
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
