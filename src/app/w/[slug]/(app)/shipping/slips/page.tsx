import type { Metadata } from "next";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { createClient } from "@/lib/supabase/server";
import { markPrinted } from "../actions";
import { shippingAccess } from "../gate";
import { BrowserPrintingHint, SlipsPagePrint } from "../print-ui";
import { PackingSlip } from "../slip";
import { loadSlipRun, slipsToPrint, type SlipSelection } from "../slips-data";

export const metadata: Metadata = { title: "Packing slips" };

export default async function PackingSlipsPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<SlipSelection>;
}) {
  const { slug } = await params;
  const access = await shippingAccess(slug, `/w/${slug}/shipping/slips`);
  if (!access.ok) return access.upsell;
  const { tenant, entitlements } = access;
  const query = await searchParams;
  const supabase = await createClient();
  const run = await loadSlipRun(supabase, tenant, query);
  const { setup, entries, shown, ready } = run;
  const base = `/w/${tenant.slug}/shipping`;
  // The same slips as plain words, for a computer that sends them to its Zebra.
  const toPrint = slipsToPrint(run, tenant);

  return (
    <>
      <div className="print:hidden">
        <PageHeader
          back={{ href: base, label: "To ship" }}
          title={`${entries.length} packing slip${entries.length === 1 ? "" : "s"}`}
          description={
            run.together
              ? `One slip for ${run.together}, going out together. Each line says which order it's from.`
              : run.one
                ? "One slip, ready to print."
                : run.ticked > 0
                  ? "The orders you ticked, oldest first. One to a page."
                  : shown.length === ready.length
                    ? "Every order that's ready to send, oldest first. One to a page."
                    : `Only the ones you haven't printed yet. ${ready.length - shown.length} already printed are left out.`
          }
        >
          {!run.chosen && shown.length !== ready.length && (
            <Button asChild variant="ghost" size="sm">
              <a href={`${base}/slips?all=1`}>Include printed ones</a>
            </Button>
          )}
          {shown.length > 0 && entitlements.canWrite && (
            <form
              action={markPrinted.bind(
                null,
                tenant.slug,
                shown.map((order) => order.id),
              )}
            >
              <Button type="submit" variant="outline" size="sm">
                I&apos;ve printed them
              </Button>
            </form>
          )}
          <SlipsPagePrint slug={tenant.slug} slips={toPrint.slips} printed={toPrint.printed} />
        </PageHeader>
        {entries.length > 0 && (
          <p className="mt-2 text-right empty:hidden">
            <BrowserPrintingHint slug={tenant.slug} />
          </p>
        )}
      </div>
      {entries.length === 0 ? (
        <p className="text-muted-foreground text-sm">Nothing is waiting for a slip.</p>
      ) : (
        <div className="mx-auto flex w-full max-w-2xl flex-col gap-6 print:max-w-none print:gap-0">
          {entries.map((entry) => (
            <PackingSlip
              key={entry.key}
              order={entry.order}
              code={entry.code}
              from={entry.from}
              settings={setup.settings}
              layout={setup.slip}
              workspaceName={tenant.name}
              timeZone={tenant.timezone}
              currency={tenant.currency}
            />
          ))}
        </div>
      )}
    </>
  );
}
