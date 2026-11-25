import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { SectionHeading } from "@/components/settings/section-heading";
import { isImportKind } from "@/lib/stock/import/files";
import { IMPORT_GUIDE, IMPORT_ORDER } from "@/lib/stock/import/guide";
import { countLines } from "@/lib/stock/import/words";
import { createClient } from "@/lib/supabase/server";
import { canManage } from "@/lib/tenants";
import { stockAccess } from "../../../stock/gate";
import { Importer } from "./importer";

export const metadata: Metadata = { title: "Bring stock records in" };

export default async function StockImportPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const access = await stockAccess(slug, `/w/${slug}/settings/stock/import`);
  if (!access.ok) return access.upsell;
  const { tenant, role, entitlements } = access;
  // Like suppliers and orders themselves, this is for the people who run the business.
  if (!canManage(role)) notFound();

  const supabase = await createClient();
  const { data: past } = await supabase
    .from("stock_imports")
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
        back={{ href: `/w/${tenant.slug}/stock`, label: "Stock" }}
        title="Bring your records across"
        description="Suppliers, planning figures, orders and history, from spreadsheets saved as CSV."
      />
      <Card>
        <CardHeader>
          <CardTitle>Bring in a file</CardTitle>
          <CardDescription>
            You&apos;ll see what a file would change before anything is saved. Bringing the same
            file in twice changes nothing, and the file itself isn&apos;t kept.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {entitlements.canWrite ? (
            <Importer slug={tenant.slug} />
          ) : (
            <p className="text-muted-foreground text-sm">
              This workspace is read-only because its plan has ended. Pick a plan to bring records
              in.
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>What each file needs</CardTitle>
          <CardDescription>
            Bring them in this order: later files lean on earlier ones. The first line of a file
            names its columns; the order of the columns doesn&apos;t matter, and ones we don&apos;t
            know are ignored.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          {IMPORT_ORDER.map((kind, index) => {
            const guide = IMPORT_GUIDE[kind];
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
                return (
                  <li key={row.id as string} className="flex flex-wrap gap-x-4 gap-y-1 py-2">
                    <span className="w-36 font-semibold">
                      {isImportKind(kind) ? IMPORT_GUIDE[kind].title : kind}
                    </span>
                    <span className="font-read min-w-0 flex-1 basis-56">
                      {isImportKind(kind)
                        ? countLines(kind, row.counts as never, true).join("; ")
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
