import type { Metadata } from "next";
import Link from "next/link";
import { Download, FileText } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input, Label } from "@/components/ui/input";
import { PageHeader } from "@/components/ui/page-header";
import { buildRunsheet, runsheetRange } from "@/lib/bookings/runsheet";
import { loadRunsheet } from "@/lib/bookings/runsheet-data";
import { localDay } from "@/lib/bookings/slots";
import { createClient } from "@/lib/supabase/server";
import { bookingsAccess } from "../gate";
import { CheckIn } from "../roster";

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

  return (
    <>
      <PageHeader
        title="Runsheet"
        description={`Everyone coming, class by class: ${doc.subtitle}.`}
      >
        {hasPeople && (
          <>
            <Button asChild variant="outline" size="sm">
              <a href={`${file}&format=pdf`} target="_blank" rel="noopener">
                <FileText /> PDF
              </a>
            </Button>
            <Button asChild variant="outline" size="sm">
              <a href={file}>
                <Download /> Spreadsheet
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
      {doc.footnote && (
        <p className="text-muted-foreground text-sm">
          <Badge tone="good">Returning</Badge> has booked with you before.
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
          const here = block.rows.filter((r) => r.here).length;
          return (
            <Card key={block.id}>
              <CardHeader>
                <CardTitle className="flex flex-wrap items-center gap-2">
                  <Link href={`${base}/sessions/${block.id}`} className="hover:underline">
                    {block.title}
                  </Link>
                  <Badge tone={here === block.rows.length ? "good" : "closed"}>
                    {here} of {block.rows.length} checked in
                  </Badge>
                </CardTitle>
                <CardDescription>
                  {block.when} · {block.line}
                </CardDescription>
              </CardHeader>
              <CardContent>
                <ul className="divide-border flex flex-col divide-y">
                  {block.rows.map((row) => {
                    return (
                      <li
                        key={row.id}
                        className="flex flex-wrap items-start gap-x-4 gap-y-2 py-2.5 first:pt-0 last:pb-0"
                      >
                        <div className="min-w-0 flex-1 basis-56">
                          <p className="flex flex-wrap items-center gap-x-2 gap-y-1 font-semibold">
                            <span className="font-read">{row.name}</span>
                            {row.returning && <Badge tone="good">Returning</Badge>}
                            {Number(row.seats) > 1 && <Badge tone="open">{row.seats} places</Badge>}
                          </p>
                          <p className="text-muted-foreground font-read text-sm">{row.contact}</p>
                          {row.extra.map((line) => (
                            <p key={line} className="font-read text-sm">
                              {line}
                            </p>
                          ))}
                        </div>
                        {entitlements.canWrite && (
                          <CheckIn
                            slug={tenant.slug}
                            person={{ id: row.id, attendance: row.attendance }}
                          />
                        )}
                      </li>
                    );
                  })}
                </ul>
              </CardContent>
            </Card>
          );
        })
      )}
    </>
  );
}
