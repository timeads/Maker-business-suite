import type { Metadata } from "next";
import Link from "next/link";
import { PageHeader } from "@/components/ui/page-header";
import { type Closure } from "@/lib/stock/engine/closures";
import { IMPORT_GUIDE } from "@/lib/stock/import/guide";
import { orderCountsBySupplier } from "@/lib/stock/po/list";
import { joinEmails, supplierTab, suppliersFor } from "@/lib/stock/suppliers/table";
import { createClient } from "@/lib/supabase/server";
import { canManage } from "@/lib/tenants";
import { cn } from "@/lib/utils";
import { loadIncoming, loadStock } from "../data";
import { stockAccess } from "../gate";
import { Importer } from "../settings/import/importer";
import { StockTabs } from "../tabs";
import { closureWords } from "./closure-words";
import { AddSupplier, SuppliersTable, type SupplierLine } from "./table";

export const metadata: Metadata = { title: "Suppliers" };

const chip = "rounded-full px-2.5 py-1 text-xs whitespace-nowrap transition-colors duration-150";
const chipOn = "bg-teal font-semibold text-white";
const chipOff = "bg-sunken text-text-2 hover:bg-hover";

export default async function SuppliersPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ show?: string }>;
}) {
  const { slug } = await params;
  const tab = supplierTab((await searchParams).show);
  const access = await stockAccess(slug, `/w/${slug}/stock/suppliers`);
  if (!access.ok) return access.upsell;
  const { tenant, role, entitlements } = access;
  const canEdit = canManage(role) && entitlements.canWrite;
  const supabase = await createClient();
  const [{ suppliers, closures, today, settings }, { leadTimes }, { data: orderRows }] =
    await Promise.all([
      loadStock(supabase, tenant),
      loadIncoming(supabase, tenant),
      supabase
        .from("purchase_orders")
        .select("supplier_id, status")
        .eq("tenant_id", tenant.id)
        .limit(5000),
    ]);
  // How many orders each supplier has had (drafts and cancelled ones aside).
  const orderCounts = orderCountsBySupplier(
    (orderRows ?? []).map((order) => ({
      supplierId: order.supplier_id as string,
      status: order.status as string,
    })),
  );
  const closuresOf = (id: string): Closure[] =>
    closures
      .filter((c) => c.supplier_id === id)
      .map((c) => ({ id: c.id, name: c.name, startsOn: c.starts_on, endsOn: c.ends_on }));
  const counts = {
    active: suppliersFor(suppliers, "active").length,
    archived: suppliersFor(suppliers, "archived").length,
  };
  const rows: SupplierLine[] = suppliersFor(suppliers, tab).map((s) => {
    // An empty "days to arrive" follows the workspace's own default.
    const words = closureWords(
      closuresOf(s.id),
      s.lead_time_days ?? settings.default_lead_time_days,
      today,
    );
    return {
      id: s.id,
      name: s.name,
      leadDays: s.lead_time_days,
      observed: leadTimes.get(s.id) ?? null,
      moq: s.moq,
      moqAppliesTo: s.moq_applies_to,
      contact: s.contact_name ?? "",
      emails: joinEmails(s.email, s.more_emails),
      orders: orderCounts.get(s.id) ?? 0,
      status: words.now
        ? { tone: "bad", words: words.now }
        : words.aheadShort
          ? { tone: words.missed ? "bad" : "waiting", words: words.aheadShort }
          : null,
    };
  });
  const base = `/w/${tenant.slug}/stock`;
  const guide = IMPORT_GUIDE.suppliers;

  return (
    <>
      <PageHeader
        title="Stock"
        description="Who you buy from, how long they take, and the smallest order they'll accept."
      >
        {canEdit && (
          <AddSupplier slug={tenant.slug} usualLeadDays={settings.default_lead_time_days} />
        )}
      </PageHeader>
      <StockTabs slug={tenant.slug} tenantId={tenant.id} manager={canManage(role)} />

      <nav aria-label="Which suppliers" className="flex flex-wrap items-center gap-1.5">
        {(
          [
            ["active", "Active"],
            ["archived", "Archived"],
          ] as const
        ).map(([key, label]) => (
          <Link
            key={key}
            href={key === "active" ? `${base}/suppliers` : `${base}/suppliers?show=archived`}
            aria-current={tab === key ? "page" : undefined}
            className={cn(chip, tab === key ? chipOn : chipOff)}
          >
            {label} <span className="tabular-nums opacity-80">{counts[key]}</span>
          </Link>
        ))}
      </nav>

      <SuppliersTable
        slug={tenant.slug}
        rows={rows}
        tab={tab}
        usualLeadDays={settings.default_lead_time_days}
        canEdit={canEdit}
      />
      {canEdit && rows.length > 0 && (
        <p className="text-muted-foreground font-read -mt-2 text-sm">
          Type in a box and move on: it saves by itself. An empty lead time follows your usual{" "}
          {settings.default_lead_time_days} days from Settings. The arrow beside a name opens
          everything else about that supplier: when they&apos;re shut, how long an order should
          last, days to pay and notes.
        </p>
      )}

      {canEdit && (
        <section className="flex flex-col gap-2 pt-2">
          <h2 className="text-sm font-semibold">Import suppliers (CSV)</h2>
          <p className="text-muted-foreground font-read text-sm">
            Columns: {guide.columns.map((column) => column.name).join(", ")}. {guide.matchedBy}{" "}
            You&apos;ll see what the file would change before anything is saved.{" "}
            <Link
              href={`${base}/settings/import`}
              className="text-ochre-text underline-offset-2 hover:underline"
            >
              What each column means, and the other files you can bring in
            </Link>
            .
          </p>
          <Importer slug={tenant.slug} only="suppliers" />
        </section>
      )}
    </>
  );
}
