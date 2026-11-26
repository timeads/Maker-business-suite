import type { Metadata } from "next";
import Link from "next/link";
import { Download, FileText, MessageSquare } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input, Label } from "@/components/ui/input";
import { PageHeader } from "@/components/ui/page-header";
import { buildRunsheet, runsheetRange } from "@/lib/bookings/runsheet";
import { loadRunsheet } from "@/lib/bookings/runsheet-data";
import { localDay } from "@/lib/bookings/slots";
import { createClient } from "@/lib/supabase/server";
import { bookingsAccess } from "../gate";
import { cn } from "@/lib/utils";
import { CheckInBox } from "./check-box";

export const metadata: Metadata = { title: "Runsheet" };

/**
 * Everyone coming over a stretch of days, one card per class, with check-in
 * as people arrive and a PDF or spreadsheet for the studio floor. The days
 * are in the address, so a sheet can be bookmarked or shared with the team.
 */
export default async function RunsheetPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ from?: string; to?: string }>;
}) {
  const { slug } = await params;
  const access = await bookingsAccess(slug, `/w/${slug}/bookings/runsheet`);
  if (!access.ok) return access.upsell;
  const { tenant, entitlements } = access;
  const { from, to } = runsheetRange(await searchParams, localDay(new Date(), tenant.timezone));
  const sessions = await loadRunsheet(await createClient(), tenant, { from, to });
  const doc = buildRunsheet({
    business: tenant.name,
    timezone: tenant.timezone,
    from,
    to,
    sessions: sessions ?? [],
  });
  const base = `/w/${tenant.slug}/bookings`;
  const file = `${base}/runsheet/file?from=${from}&to=${to}`;
  const hasPeople = doc.blocks.length > 0;
  const anyTexts = doc.blocks.some((block) => block.rows.some((row) => row.texts));

  return (
    <>
      <PageHeader
        title="Runsheet"
        description="Attendee lists by session for a date range — download a PDF for the floor."
      >
        {hasPeople && (
          <>
            <Button asChild variant="outline">
              <a href={`${file}&format=pdf`} target="_blank" rel="noopener">
                <FileText /> PDF
              </a>
            </Button>
            <Button asChild variant="outline">
              <a href={file}>
                <Download /> CSV
              </a>
            </Button>
          </>
        )}
      </PageHeader>
      <form className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1">
          <Label htmlFor="runsheet-from">From</Label>
          <Input id="runsheet-from" type="date" name="from" defaultValue={from} className="w-44" />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="runsheet-to">To</Label>
          <Input id="runsheet-to" type="date" name="to" defaultValue={to} className="w-44" />
        </div>
        <Button type="submit" variant="outline">
          Show these days
        </Button>
      </form>
      {(doc.footnote || anyTexts) && (
        <p className="text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
          {doc.footnote && (
            <span>
              <Badge tone="good">Returning</Badge> has booked with you before.
            </span>
          )}
          {anyTexts && (
            <span>
              <MessageSquare className="text-mint-ink inline size-3.5" aria-hidden /> agreed to text
              reminders.
            </span>
          )}
        </p>
      )}
      {sessions === null ? (
        <Card>
          <CardContent className="pt-5">
            <p className="text-muted-foreground text-sm">
              The runsheet couldn&apos;t be read just now. Try again in a minute.
            </p>
          </CardContent>
        </Card>
      ) : !hasPeople ? (
        <Card>
          <CardContent className="pt-5">
            <p className="text-muted-foreground text-sm">{doc.empty}</p>
          </CardContent>
        </Card>
      ) : (
        doc.blocks.map((block) => {
          const full = block.capacity > 0 ? Math.min(100, (block.taken / block.capacity) * 100) : 0;
          return (
            <Card key={block.id}>
              <CardContent className="flex flex-col gap-4 pt-5">
                <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
                  <h2 className="min-w-0 text-base font-bold">
                    <Link href={`${base}/sessions/${block.id}`} className="hover:underline">
                      {block.heading}
                    </Link>
                  </h2>
                  <div className="flex items-center gap-3">
                    <Badge tone={block.here === block.rows.length ? "good" : "closed"}>
                      {block.here}/{block.rows.length} checked in
                    </Badge>
                    <span
                      className="bg-sunken relative h-2 w-28 overflow-hidden rounded-full"
                      role="img"
                      aria-label={`${block.taken} of ${block.capacity} places booked`}
                    >
                      <span
                        className={cn(
                          "absolute inset-y-0 left-0 rounded-full",
                          block.taken > block.capacity ? "bg-brick" : "bg-teal",
                        )}
                        style={{ width: `${full}%` }}
                      />
                    </span>
                    <span className="text-sm font-bold tabular-nums">
                      {block.taken}/{block.capacity}
                    </span>
                  </div>
                </div>
                {block.line && <p className="text-muted-foreground -mt-2 text-xs">{block.line}</p>}
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[520px] text-left text-sm">
                    <thead className="text-muted-foreground border-border border-b text-xs">
                      <tr>
                        <th className="w-12 py-2 pr-3 font-semibold">In</th>
                        <th className="py-2 pr-4 font-semibold">Attendee</th>
                        <th className="py-2 pr-4 font-semibold">Contact</th>
                        <th className="py-2 text-right font-semibold">Seats</th>
                      </tr>
                    </thead>
                    <tbody className="divide-border divide-y">
                      {block.rows.map((row) => (
                        <tr key={row.id} className="align-top">
                          <td className="py-2.5 pr-3">
                            <CheckInBox
                              slug={tenant.slug}
                              bookingId={row.id}
                              name={row.name}
                              attendance={row.attendance}
                              disabled={!entitlements.canWrite}
                            />
                          </td>
                          <td className="py-2.5 pr-4">
                            <p className="flex flex-wrap items-center gap-x-2 gap-y-1 font-semibold">
                              <span className="font-read">{row.name}</span>
                              {row.returning && <Badge tone="good">Returning</Badge>}
                              {row.attendance === "no_show" && <Badge tone="bad">No-show</Badge>}
                            </p>
                            {row.extra.map((line) => (
                              <p key={line} className="font-read text-muted-foreground text-xs">
                                {line}
                              </p>
                            ))}
                          </td>
                          <td className="text-text-2 font-read py-2.5 pr-4 break-all">
                            {row.email}
                            {row.phone && (
                              <>
                                {row.email ? " · " : ""}
                                {row.phone}
                                {row.texts && (
                                  <MessageSquare
                                    className="text-mint-ink ml-1 inline size-3.5 align-[-2px]"
                                    aria-label="Agreed to text reminders"
                                  />
                                )}
                              </>
                            )}
                          </td>
                          <td className="py-2.5 text-right tabular-nums">{row.seats}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </CardContent>
            </Card>
          );
        })
      )}
    </>
  );
}
