import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Download, FileText } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { FormMessage } from "@/components/ui/form-message";
import { PageHeader } from "@/components/ui/page-header";
import { googleMailConfigured } from "@/lib/connections/providers/google-mail";
import { formatMoney } from "@/lib/dashboard/format";
import { nameOf, type Person } from "@/lib/messages/format";
import { STOCK_MODULE } from "@/lib/stock/config";
import { trackingUrl } from "@/lib/shipping/carriers";
import { caseLabel, casePackOf, startingQty } from "@/lib/stock/engine";
import { ORDER_STATUS, explainSuggestion, isPlanned, itemName } from "@/lib/stock/plan";
import {
  PO_EMAIL_KEY,
  composeDefaults,
  fingerprint,
  firstName,
  parsePoEmail,
  poSnapshot,
  readSnapshot,
  sendLabel,
} from "@/lib/stock/po/email";
import { buildTimeline } from "@/lib/stock/po/timeline";
import { computePoTotals, parseAdjustments } from "@/lib/stock/po/totals";
import { CARRIER_WORDS, canAskCarrier, isCarrierStatus, parcelDates } from "@/lib/stock/tracking";
import { createClient } from "@/lib/supabase/server";
import { canManage } from "@/lib/tenants";
import { loadStock } from "../../data";
import {
  ArchiveButton,
  DeleteDraftButton,
  PrintButton,
  ReceiveForm,
  RenameOrderForm,
  RetryShopButton,
  StatusButton,
  type OrderLine,
} from "../../forms";
import { stockAccess } from "../../gate";
import { OrderForm, type AddableItem, type EditLine } from "./order-form";
import { OrderEmail, type EmailCompose } from "./email-card";
import { loadPoForSupplier, poFileName } from "./po-data";
import { AddShipmentForm, ShipmentList, type ShipmentRow } from "./shipments";

export const metadata: Metadata = { title: "Stock order" };

type Item = {
  id: string;
  title: string;
  variant_title: string | null;
  sku: string | null;
  case_pack: number | null;
};

const count = (value: string | undefined) => Math.max(0, Number.parseInt(value ?? "0", 10) || 0);

export default async function StockOrderPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string; number: string }>;
  searchParams: Promise<{ drafted?: string; nosupplier?: string; enough?: string; off?: string }>;
}) {
  const { slug, number } = await params;
  const access = await stockAccess(slug, `/w/${slug}/stock/orders/${number}`);
  if (!access.ok) return access.upsell;
  const { tenant, role, entitlements, user } = access;
  if (!/^\d{1,9}$/.test(number)) notFound();
  const flags = await searchParams;

  const supabase = await createClient();
  const { data: order } = await supabase
    .from("purchase_orders")
    .select(
      "id, number, reference, status, notes, expected_on, ordered_at, closed_at, created_at, created_by, archived_at, source, supplier_id, shipping_cost, tax_rate_pct, adjustments, suppliers(name, email, notes), purchase_order_lines(id, stock_item_id, qty_ordered, qty_received, unit_cost, supplier_sku, note, stock_items(id, title, variant_title, sku, case_pack))",
    )
    .eq("tenant_id", tenant.id)
    .eq("number", Number(number))
    .maybeSingle();
  if (!order) notFound();
  const supplier = order.suppliers as unknown as { name: string; email: string | null };
  const lines: OrderLine[] = (
    order.purchase_order_lines as unknown as {
      id: string;
      stock_item_id: string;
      qty_ordered: number;
      qty_received: number;
      unit_cost: number;
      supplier_sku: string | null;
      note: string | null;
      stock_items: Item;
    }[]
  )
    .filter((line) => line.qty_ordered > 0 || line.qty_received > 0)
    .map((line) => ({
      id: line.id,
      stock_item_id: line.stock_item_id,
      name: itemName(line.stock_items),
      sku: line.stock_items.sku,
      qty_ordered: line.qty_ordered,
      qty_received: line.qty_received,
      unit_cost: Number(line.unit_cost),
      supplier_sku: line.supplier_sku,
      note: line.note ?? "",
      case_pack: casePackOf(line.stock_items.case_pack),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const isDraft = order.status === "draft";
  const waiting = order.status === "ordered" || order.status === "partial";
  const manager = canManage(role) && entitlements.canWrite;
  const editable = manager && (isDraft || waiting);

  // Suggestions come from the same engine as everywhere else, worked out now.
  const stock = await loadStock(supabase, tenant);
  const [
    { data: receipts },
    { data: tracked },
    { data: ups },
    { data: events },
    { data: everAdded },
  ] = await Promise.all([
    supabase
      .from("stock_receipts")
      .select(
        "id, quantity, shop_status, shop_error, shop_attempts, shop_can_retry, source, created_at, received_by, shop_synced_at, stock_items(title, variant_title)",
      )
      .eq("tenant_id", tenant.id)
      .in(
        "po_line_id",
        lines.map((line) => line.id),
      )
      .order("created_at", { ascending: false })
      .limit(50),
    supabase
      .from("purchase_order_shipments")
      .select(
        "id, carrier, tracking, expected_on, arrived_on, note, carrier_status, carrier_detail, carrier_expected_on, carrier_delivered_on, carrier_scan_place, carrier_scan_at, carrier_checked_at, carrier_error, purchase_order_shipment_items(po_line_id, quantity)",
      )
      .eq("tenant_id", tenant.id)
      .eq("po_id", order.id)
      .is("removed_at", null)
      .order("created_at"),
    // Their own UPS account, connected for real: its numbers are followed for them.
    supabase
      .from("connections")
      .select("status, metadata")
      .eq("tenant_id", tenant.id)
      .eq("provider", "ups")
      .maybeSingle(),
    // Who sent, closed, renamed or put the order away, and when.
    supabase
      .from("purchase_order_events")
      .select("kind, detail, actor, created_at")
      .eq("tenant_id", tenant.id)
      .eq("po_id", order.id)
      .order("created_at")
      .limit(200),
    // Every tracking number the order has had, for the timeline (taken-off ones too).
    supabase
      .from("purchase_order_shipments")
      .select("carrier, tracking, created_by, created_at, removed_at")
      .eq("tenant_id", tenant.id)
      .eq("po_id", order.id)
      .order("created_at")
      .limit(200),
  ]);
  const upsFollows =
    ups?.status === "active" && (ups.metadata as { mode?: string } | null)?.mode !== "test";
  const { settings, link, rows, today } = stock;
  const rowById = new Map(rows.map((row) => [row.item.id, row]));
  const editLines: EditLine[] = lines.map((line) => {
    const row = rowById.get(line.stock_item_id);
    // Once an order has gone out its own units count as "on the way", so a
    // fresh suggestion would be for a further order: only drafts show one.
    return {
      ...line,
      suggested: row && isDraft ? row.suggestedQty : 0,
      why: row && isDraft ? explainSuggestion(row, today) : "",
    };
  });
  const onOrder = new Set(lines.map((line) => line.stock_item_id));
  // Anything planned for can go on the order. This supplier's own items come
  // first; the rest follow, each saying who it usually comes from.
  const toAddable = (row: (typeof rows)[number], theirs: boolean): AddableItem => ({
    id: row.item.id,
    name: row.name,
    sku: row.item.sku,
    cost: row.unitCost,
    start: startingQty(row.suggestedQty, row.casePack, row.minimum),
    case_pack: row.casePack,
    // The long explanation is only sent for this supplier's own items: the
    // rest of the catalogue can be thousands of rows.
    why: theirs ? explainSuggestion(row, today) : "",
    theirs,
    usualSupplier: theirs ? null : (row.supplier?.name ?? null),
  });
  const canAdd = editable
    ? rows
        .filter((row) => isPlanned(row) && !onOrder.has(row.item.id))
        .sort((a, b) => a.name.localeCompare(b.name))
    : [];
  const addable: AddableItem[] = [
    ...canAdd
      .filter((row) => row.item.supplier_id === order.supplier_id)
      .slice(0, 800)
      .map((row) => toAddable(row, true)),
    ...canAdd
      .filter((row) => row.item.supplier_id !== order.supplier_id)
      .slice(0, 2500)
      .map((row) => toAddable(row, false)),
  ];

  const adjustments = parseAdjustments(order.adjustments);
  const shipping = String(order.shipping_cost ?? "0");
  const taxRate = String(order.tax_rate_pct ?? "0");
  const totals = computePoTotals({
    lines: lines.map((line) => ({
      qtyOrdered: line.qty_ordered,
      unitCost: line.unit_cost.toFixed(2),
    })),
    shippingCost: shipping,
    taxRatePct: taxRate,
    adjustments,
  });
  const extras = !totals.total.equals(totals.subtotal);
  const units = lines.reduce((n, line) => n + line.qty_ordered, 0);
  const status = ORDER_STATUS[order.status] ?? ORDER_STATUS.draft;
  const base = `/w/${tenant.slug}/stock`;
  const money = (value: number) => formatMoney(value, tenant.currency);
  const when = new Intl.DateTimeFormat("en-US", {
    timeZone: tenant.timezone,
    dateStyle: "medium",
    timeStyle: "short",
  });
  const day = (value: string) =>
    new Intl.DateTimeFormat("en-US", { timeZone: "UTC", dateStyle: "medium" }).format(
      new Date(`${value}T12:00:00Z`),
    );
  const late = waiting && order.expected_on !== null && (order.expected_on as string) < today;
  const lineNames = new Map(lines.map((line) => [line.id, line.name]));
  const shipments: ShipmentRow[] = (tracked ?? []).map((s) => {
    const parcel = {
      tracking: s.tracking as string,
      expectedOn: s.expected_on as string | null,
      arrivedOn: s.arrived_on as string | null,
      carrierStatus: isCarrierStatus(s.carrier_status) ? s.carrier_status : null,
      carrierExpectedOn: s.carrier_expected_on as string | null,
      carrierDeliveredOn: s.carrier_delivered_on as string | null,
    };
    // A person's word first, then the carrier's (lib/stock/tracking.ts).
    const dates = parcelDates(parcel);
    const said = parcel.carrierStatus ? CARRIER_WORDS[parcel.carrierStatus] : null;
    const checked = s.carrier_checked_at as string | null;
    return {
      id: s.id as string,
      carrier: s.carrier as string,
      tracking: parcel.tracking,
      expected: s.expected_on as string | null,
      expectedText: dates.expectedOn ? day(dates.expectedOn) : null,
      arrivedText: dates.arrivedOn ? day(dates.arrivedOn) : null,
      late: !dates.arrivedOn && Boolean(dates.expectedOn) && (dates.expectedOn as string) < today,
      note: s.note as string,
      url: trackingUrl(s.carrier as string, parcel.tracking),
      carrier_said:
        said || s.carrier_error
          ? {
              label: said?.label ?? "On its way",
              tone: said?.tone ?? "open",
              detail:
                [
                  s.carrier_detail as string | null,
                  s.carrier_scan_place as string | null,
                  s.carrier_scan_at ? when.format(new Date(s.carrier_scan_at as string)) : null,
                ]
                  .filter(Boolean)
                  .join(" · ") || null,
              checked: checked ? `UPS was asked ${when.format(new Date(checked))}` : null,
              trouble: (s.carrier_error as string | null) ?? null,
            }
          : null,
      canCheck: upsFollows && waiting && canAskCarrier(parcel),
      items: ((s.purchase_order_shipment_items ?? []) as { po_line_id: string; quantity: number }[])
        .filter((item) => lineNames.has(item.po_line_id))
        .map((item) => ({
          lineId: item.po_line_id,
          name: lineNames.get(item.po_line_id) as string,
          quantity: item.quantity,
        })),
    };
  });
  const hasUpsNumber = shipments.some((s) => /^1Z[0-9A-Z]{16}$/.test(s.tracking));
  // Emailing the order from the workspace's own Gmail: only where this
  // deployment has a Google app, and only owners and admins send.
  const mailOffered = googleMailConfigured() && order.status !== "cancelled" && lines.length > 0;
  const [
    { data: mailbox },
    { data: emailConfig },
    { data: emailed },
    { data: people },
    forSupplier,
  ] = await Promise.all([
    supabase
      .from("connections")
      .select("status, metadata")
      .eq("tenant_id", tenant.id)
      .eq("provider", "google_mail")
      .maybeSingle(),
    supabase
      .from("configs")
      .select("body")
      .eq("tenant_id", tenant.id)
      .eq("module", STOCK_MODULE)
      .eq("key", PO_EMAIL_KEY)
      .maybeSingle(),
    supabase
      .from("purchase_order_emails")
      .select(
        "id, status, to_emails, cc_emails, subject, sender_email, sent_by, sent_at, created_at, snapshot, fingerprint, error",
      )
      .eq("tenant_id", tenant.id)
      .eq("po_id", order.id)
      .order("created_at", { ascending: false })
      .limit(20),
    supabase.rpc("chat_people", { p_tenant_id: tenant.id }),
    manager && mailOffered ? loadPoForSupplier(supabase, tenant, { id: order.id }) : null,
  ]);
  const team = new Map(((people ?? []) as Person[]).map((person) => [person.user_id, person]));
  const sends = (emailed ?? []) as {
    id: string;
    status: string;
    to_emails: string[];
    cc_emails: string[];
    subject: string;
    sender_email: string;
    sent_by: string | null;
    sent_at: string | null;
    created_at: string;
    snapshot: unknown;
    fingerprint: string;
    error: string | null;
  }[];
  // One line of time from the tables that already hold each fact.
  const timeline = buildTimeline({
    createdAt: order.created_at as string,
    createdBy: (order.created_by as string | null) ?? null,
    imported: order.source === "import",
    orderedAt: (order.ordered_at as string | null) ?? null,
    closedAt: (order.closed_at as string | null) ?? null,
    status: order.status as string,
    events: (events ?? []).map((event) => ({
      kind: event.kind as string,
      detail: (event.detail as string) ?? "",
      actor: (event.actor as string | null) ?? null,
      at: event.created_at as string,
    })),
    emails: sends.map((send) => ({
      status: send.status,
      to: send.to_emails,
      subject: send.subject,
      from: send.sender_email,
      by: send.sent_by,
      at: send.sent_at ?? send.created_at,
      error: send.error,
    })),
    receipts: (receipts ?? []).map((receipt) => ({
      quantity: receipt.quantity as number,
      name: itemName(receipt.stock_items as unknown as Pick<Item, "title" | "variant_title">),
      by: (receipt.received_by as string | null) ?? null,
      at: receipt.created_at as string,
      imported: receipt.source === "import",
      shopStatus: receipt.shop_status as string,
      shopAt: (receipt.shop_synced_at as string | null) ?? null,
      shopError: (receipt.shop_error as string | null) ?? null,
    })),
    shipments: (everAdded ?? []).map((shipment) => ({
      carrier: shipment.carrier as string,
      tracking: shipment.tracking as string,
      by: (shipment.created_by as string | null) ?? null,
      at: shipment.created_at as string,
      removedAt: (shipment.removed_at as string | null) ?? null,
    })),
  }).reverse();
  const archived = order.archived_at !== null;
  const finished = order.status === "closed" || order.status === "cancelled";
  const mailboxEmail = String((mailbox?.metadata as { email?: unknown } | null)?.email ?? "");
  const mailReady = mailOffered && mailbox?.status === "active" && mailboxEmail !== "";
  const lastSent = sends.find((send) => send.status === "sent" && send.sent_at) ?? null;
  let compose: EmailCompose | null = null;
  if (manager && mailReady && forSupplier) {
    const template = parsePoEmail(emailConfig?.body);
    const now = fingerprint(poSnapshot(forSupplier.forEmail));
    const changedSince = lastSent !== null && lastSent.fingerprint !== now;
    const defaults = composeDefaults({
      po: forSupplier.forEmail,
      contactEmails: forSupplier.supplierEmails,
      templates: template,
      // Signed with the first name of whoever is sending.
      senderName: firstName(nameOf(team.get(user.id)), user.email ?? mailboxEmail),
      last: lastSent
        ? {
            subject: lastSent.subject,
            sentAt: lastSent.sent_at as string,
            snapshot: readSnapshot(lastSent.snapshot),
          }
        : null,
      now: new Date(),
      timezone: tenant.timezone,
    });
    compose = {
      from: mailboxEmail,
      to: defaults.to,
      subject: defaults.subject,
      body: defaults.body,
      ccMe: template.cc_me,
      filename: poFileName(forSupplier.reference),
      sendLabel: sendLabel({ isDraft, isResend: defaults.isResend, changed: changedSince }),
      isDraft,
      changed:
        changedSince && lastSent
          ? {
              sentOn: new Intl.DateTimeFormat("en-US", {
                timeZone: tenant.timezone,
                month: "short",
                day: "numeric",
              }).format(new Date(lastSent.sent_at as string)),
              changes: defaults.changes,
            }
          : null,
      supplierName: supplier.name,
      hasSavedEmail: forSupplier.supplierEmails.length > 0,
    };
  }
  const SEND_NOTES: Record<string, { label: string; tone: "good" | "bad" | "waiting" }> = {
    sent: { label: "Sent", tone: "good" },
    failed: { label: "Didn't send", tone: "bad" },
    unsure: { label: "Can't tell if it went", tone: "waiting" },
    sending: { label: "Sending", tone: "waiting" },
  };
  const SHOP_NOTES: Record<string, string> = {
    pending: "waiting to be added to your shop",
    sending: "being added to your shop",
    sent: "added to your shop's count",
    skipped: "not added to your shop",
    failed: "couldn't be added to your shop",
  };
  const leftOut = [
    count(flags.nosupplier) > 0 &&
      `${count(flags.nosupplier)} had no supplier (see Everything → No supplier)`,
    count(flags.enough) > 0 && `${count(flags.enough)} had enough in stock for now`,
    count(flags.off) > 0 && `${count(flags.off)} are set not to be reordered`,
  ].filter(Boolean);

  return (
    <>
      <PageHeader
        back={{ href: `${base}/orders`, label: "Orders" }}
        title={`${order.reference} · ${supplier.name}`}
        description={
          <>
            {tenant.name} · {units} units · {money(totals.total.toNumber())}
            {order.expected_on && ` · expected ${day(order.expected_on as string)}`}
          </>
        }
      >
        <Badge tone={status.tone}>{status.label}</Badge>
        {late && <Badge tone="bad">Late</Badge>}
        {archived && <Badge>Archived</Badge>}
        {manager && !finished && !archived && (
          <RenameOrderForm
            slug={tenant.slug}
            orderId={order.id}
            reference={order.reference as string}
          />
        )}
        {lines.length > 0 && (
          <>
            <PrintButton />
            {canManage(role) && (
              <Button asChild variant="outline" size="sm" className="print:hidden">
                <a href={`${base}/orders/${order.number}/pdf`} target="_blank" rel="noopener">
                  <FileText /> PDF
                </a>
              </Button>
            )}
            <Button asChild variant="outline" size="sm" className="print:hidden">
              <a href={`${base}/orders/${order.number}/sheet`}>
                <Download /> Spreadsheet
              </a>
            </Button>
          </>
        )}
        {manager && isDraft && (
          <StatusButton
            slug={tenant.slug}
            orderId={order.id}
            to="ordered"
            label="I've sent this order"
            pending="Saving…"
            variant={compose ? "outline" : "default"}
          />
        )}
      </PageHeader>

      {flags.drafted && isDraft && (
        <div className="print:hidden">
          <FormMessage kind="success">
            Drafted from your sales: every quantity below is what we&apos;d order now. Change
            anything, then save.
            {leftOut.length > 0 && ` Left off: ${leftOut.join("; ")}.`}
          </FormMessage>
        </div>
      )}

      {waiting && entitlements.canWrite && (
        <Card className="print:hidden">
          <CardHeader>
            <CardTitle>Check in a delivery</CardTitle>
            <CardDescription>
              Type what arrived. If it&apos;s only part of the order, the rest stays open.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ReceiveForm
              slug={tenant.slug}
              orderId={order.id}
              lines={lines}
              pushOffered={link.canPush}
              pushDefault={settings.push_to_shop}
            />
          </CardContent>
        </Card>
      )}

      {!isDraft &&
        order.status !== "cancelled" &&
        (shipments.length > 0 || (manager && waiting)) && (
          <Card>
            <CardHeader>
              <CardTitle>On its way</CardTitle>
              <CardDescription>
                {manager && waiting
                  ? "Add the tracking number the supplier sends you. One order can come in several parcels."
                  : "The tracking numbers for this order."}
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <ShipmentList
                slug={tenant.slug}
                orderId={order.id}
                shipments={shipments}
                lines={lines
                  .filter((line) => line.qty_ordered > 0)
                  .map((line) => ({ id: line.id, name: line.name, ordered: line.qty_ordered }))}
                canEdit={manager && waiting}
              />
              {manager && waiting && !upsFollows && (
                <p className="text-muted-foreground text-xs print:hidden">
                  {hasUpsNumber ? "These UPS numbers" : "UPS numbers"} can update by themselves:
                  connect your own UPS account under{" "}
                  <Link href={`/w/${tenant.slug}/connections`} className="underline">
                    Connections
                  </Link>
                  {ups?.status === "active"
                    ? " for real labels (yours is set to practice labels)"
                    : ""}
                  . Until then, each number is as you record it.
                </p>
              )}
              {manager && waiting && <AddShipmentForm slug={tenant.slug} orderId={order.id} />}
            </CardContent>
          </Card>
        )}

      <Card>
        <CardHeader>
          <CardTitle>{isDraft ? "What's on it" : "The order"}</CardTitle>
          {isDraft && (
            <CardDescription>
              Change anything, save, then print or download it to send to {supplier.name}
              {supplier.email ? ` (${supplier.email})` : ""}.
            </CardDescription>
          )}
        </CardHeader>
        <CardContent>
          {editable ? (
            <OrderForm
              slug={tenant.slug}
              orderId={order.id}
              placed={!isDraft}
              lines={editLines}
              notes={order.notes}
              expected={order.expected_on}
              shipping={shipping}
              tax={taxRate}
              adjustments={adjustments}
              addable={addable}
              supplierName={supplier.name}
              currency={tenant.currency}
            />
          ) : lines.length === 0 ? (
            <p className="text-muted-foreground text-sm">Nothing on this order.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] text-left text-sm">
                <thead className="text-muted-foreground text-xs">
                  <tr>
                    <th className="py-2 pr-3 font-semibold">Item</th>
                    <th className="py-2 pr-3 font-semibold">Supplier&apos;s code</th>
                    <th className="py-2 pr-3 text-right font-semibold">Ordered</th>
                    <th className="py-2 pr-3 text-right font-semibold print:hidden">Arrived</th>
                    <th className="py-2 pr-3 text-right font-semibold">Cost each</th>
                    <th className="py-2 text-right font-semibold">Total</th>
                  </tr>
                </thead>
                <tbody className="divide-border divide-y">
                  {lines.map((line) => (
                    <tr key={line.id} className="align-top">
                      <td className="py-2 pr-3">
                        <span className="font-read">{line.name}</span>
                        {line.sku && (
                          <span className="text-muted-foreground block text-xs">{line.sku}</span>
                        )}
                        {line.note && <span className="font-read block text-xs">{line.note}</span>}
                      </td>
                      <td className="py-2 pr-3">{line.supplier_sku ?? "–"}</td>
                      <td className="py-2 pr-3 text-right tabular-nums">
                        {line.qty_ordered}
                        {caseLabel(line.qty_ordered, line.case_pack) && (
                          <span className="text-muted-foreground block text-xs">
                            {caseLabel(line.qty_ordered, line.case_pack)}
                          </span>
                        )}
                      </td>
                      <td className="py-2 pr-3 text-right tabular-nums print:hidden">
                        {line.qty_received}
                      </td>
                      <td className="py-2 pr-3 text-right tabular-nums">{money(line.unit_cost)}</td>
                      <td className="py-2 text-right tabular-nums">
                        {money(
                          computePoTotals({
                            lines: [
                              { qtyOrdered: line.qty_ordered, unitCost: line.unit_cost.toFixed(2) },
                            ],
                            shippingCost: 0,
                            taxRatePct: 0,
                            adjustments: [],
                          }).subtotal.toNumber(),
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot className="tabular-nums">
                  <tr className="border-border border-t font-semibold">
                    <td className="py-2 pr-3">{extras ? "Items" : "Total"}</td>
                    <td />
                    <td className="py-2 pr-3 text-right">{units}</td>
                    <td className="print:hidden" />
                    <td />
                    <td className="py-2 text-right">{money(totals.subtotal.toNumber())}</td>
                  </tr>
                  {!totals.shipping.isZero() && (
                    <tr>
                      <td className="py-1 pr-3" colSpan={5}>
                        Shipping
                      </td>
                      <td className="py-1 text-right">{money(totals.shipping.toNumber())}</td>
                    </tr>
                  )}
                  {!totals.tax.isZero() && (
                    <tr>
                      <td className="py-1 pr-3" colSpan={5}>
                        Tax ({Number(taxRate)}%)
                      </td>
                      <td className="py-1 text-right">{money(totals.tax.toNumber())}</td>
                    </tr>
                  )}
                  {adjustments.map((adjustment, index) => (
                    <tr key={index}>
                      <td className="font-read py-1 pr-3" colSpan={5}>
                        {adjustment.label}
                      </td>
                      <td className="py-1 text-right">{money(Number(adjustment.amount))}</td>
                    </tr>
                  ))}
                  {extras && (
                    <tr className="border-border border-t font-semibold">
                      <td className="py-2 pr-3" colSpan={5}>
                        Total
                      </td>
                      <td className="py-2 text-right">{money(totals.total.toNumber())}</td>
                    </tr>
                  )}
                </tfoot>
              </table>
              {order.notes && <p className="font-read mt-3 text-sm">{order.notes}</p>}
            </div>
          )}
        </CardContent>
      </Card>

      {(compose || sends.length > 0 || (manager && mailOffered)) && (
        <Card className="print:hidden">
          <CardHeader>
            <CardTitle>
              {compose?.changed
                ? "Send the changed order"
                : lastSent
                  ? "Email this order again"
                  : "Email this order"}
            </CardTitle>
            <CardDescription>
              {compose
                ? `Goes to ${supplier.name} from your own Gmail, with the order attached as a PDF. You'll see exactly what goes before it's sent.`
                : manager && mailOffered
                  ? "Send orders to suppliers from your own Gmail, with the PDF attached."
                  : "When this order was emailed to the supplier."}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            {compose ? (
              <OrderEmail
                // A different order, or a send that changed it, starts the form afresh.
                key={`${order.id}:${sends[0]?.id ?? "none"}:${sends[0]?.status ?? ""}`}
                slug={tenant.slug}
                orderId={order.id}
                compose={compose}
                primary={isDraft}
              />
            ) : (
              manager &&
              mailOffered && (
                <p className="text-muted-foreground text-sm">
                  {mailbox && mailbox.status === "needs_reconnect"
                    ? "Gmail needs reconnecting before orders can be emailed. "
                    : "Connect Gmail once and you can email orders from here. "}
                  <Link href={`/w/${tenant.slug}/connections`} className="underline">
                    Open Connections
                  </Link>
                  . Until then, download the PDF and send it yourself.
                </p>
              )
            )}
            {sends.length > 0 && (
              <ul className="divide-border border-border flex flex-col divide-y border-t text-sm">
                {sends.map((send) => {
                  const note = SEND_NOTES[send.status] ?? SEND_NOTES.sending;
                  return (
                    <li
                      key={send.id}
                      className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-2"
                    >
                      <Badge tone={note.tone}>{note.label}</Badge>
                      <span className="font-read min-w-0 flex-1 basis-64">
                        to {send.to_emails.join(", ")}
                        {send.cc_emails.length > 0 && `, copy to ${send.cc_emails.join(", ")}`}
                        <span className="text-muted-foreground block text-xs">
                          “{send.subject}” · from {send.sender_email} ·{" "}
                          {send.sent_by ? nameOf(team.get(send.sent_by)) : "Someone"} pressed send
                        </span>
                        {send.status !== "sent" && send.error && (
                          <span className="text-brick block text-xs">{send.error}</span>
                        )}
                      </span>
                      <span className="text-muted-foreground">
                        {when.format(new Date(send.sent_at ?? send.created_at))}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </CardContent>
        </Card>
      )}

      {(receipts ?? []).length > 0 && (
        <Card className="print:hidden">
          <CardHeader>
            <CardTitle>What&apos;s been checked in</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="flex flex-col gap-1.5 text-sm">
              {(receipts ?? []).map((receipt) => (
                <li key={receipt.id}>
                  <span className="tabular-nums">{receipt.quantity}</span> ×{" "}
                  <span className="font-read">
                    {itemName(
                      receipt.stock_items as unknown as Pick<Item, "title" | "variant_title">,
                    )}
                  </span>
                  <span className="text-muted-foreground">
                    {" "}
                    · {when.format(new Date(receipt.created_at as string))} ·{" "}
                    {receipt.source === "import"
                      ? "from a spreadsheet, kept as history"
                      : SHOP_NOTES[receipt.shop_status as string]}
                    {receipt.shop_status === "failed" && receipt.shop_error
                      ? ` (${receipt.shop_error})`
                      : ""}
                    {(receipt.shop_attempts as number) > 1
                      ? ` · asked ${receipt.shop_attempts} times`
                      : ""}
                  </span>
                  {receipt.shop_status === "failed" &&
                    (receipt.shop_can_retry && manager && link.canPush ? (
                      <RetryShopButton slug={tenant.slug} receiptId={receipt.id as string} />
                    ) : (
                      <span className="text-muted-foreground block text-xs">
                        {receipt.shop_can_retry
                          ? manager
                            ? "Your shop isn't letting us add to its count right now, so add these there by hand."
                            : "An owner or admin can ask the shop again from here."
                          : "We won't send this one again, in case it did reach your shop. Check the count there and fix it by hand if it's short."}
                      </span>
                    ))}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      <Card className="print:hidden">
        <CardHeader>
          <CardTitle>What&apos;s happened</CardTitle>
          <CardDescription>Everything on this order, the newest first.</CardDescription>
        </CardHeader>
        <CardContent>
          <ol className="flex flex-col gap-2.5 text-sm">
            {timeline.map((item, index) => (
              <li key={index} className="flex gap-3">
                <span
                  aria-hidden
                  className={`mt-1.5 size-2 flex-none rounded-full ${
                    item.tone === "good"
                      ? "bg-teal"
                      : item.tone === "bad"
                        ? "bg-brick"
                        : "bg-border"
                  }`}
                />
                <span className="min-w-0 flex-1">
                  <span
                    className={item.tone === "bad" ? "text-brick font-semibold" : "font-semibold"}
                  >
                    {item.title}
                  </span>
                  {item.detail && (
                    <span className="text-muted-foreground font-read block text-xs">
                      {item.detail}
                    </span>
                  )}
                  <span className="text-muted-foreground block text-xs">
                    {when.format(new Date(item.at))}
                    {item.by && ` · ${nameOf(team.get(item.by))}`}
                  </span>
                </span>
              </li>
            ))}
          </ol>
        </CardContent>
      </Card>

      {manager && (isDraft || finished) && (
        <div className="flex flex-wrap justify-end gap-2 print:hidden">
          {!waiting && <ArchiveButton slug={tenant.slug} orderId={order.id} archived={archived} />}
          {isDraft && <DeleteDraftButton slug={tenant.slug} orderId={order.id} />}
        </div>
      )}

      {manager && (isDraft || waiting) && (
        <div className="flex flex-wrap justify-end gap-2 print:hidden">
          {isDraft && (
            <Button asChild variant="ghost" size="sm">
              <Link href={`${base}/items`}>Pick more items</Link>
            </Button>
          )}
          {order.status === "ordered" && (
            <StatusButton
              slug={tenant.slug}
              orderId={order.id}
              to="draft"
              label="Back to draft"
              pending="Saving…"
              variant="ghost"
            />
          )}
          {waiting && (
            <StatusButton
              slug={tenant.slug}
              orderId={order.id}
              to="closed"
              label="Close it: the rest isn't coming"
              pending="Closing…"
              variant="ghost"
            />
          )}
          {(isDraft || order.status === "ordered") && (
            <StatusButton
              slug={tenant.slug}
              orderId={order.id}
              to="cancelled"
              label="Cancel this order"
              pending="Cancelling…"
              variant="danger"
            />
          )}
        </div>
      )}
    </>
  );
}
