import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input, Label, Select } from "@/components/ui/input";
import { PageHeader } from "@/components/ui/page-header";
import { localDay } from "@/lib/bookings/slots";
import { loadSupplies } from "@/lib/bookings/studio-data";
import { createClient } from "@/lib/supabase/server";
import { canManage } from "@/lib/tenants";
import { bookingsAccess } from "../../gate";
import {
  addSupplyEntry,
  cancelSupplyOrder,
  placeSupplyOrder,
  receiveSupplyOrder,
  saveSupply,
} from "../../studio-actions";
import { StudioForm } from "../../studio-form";

export const metadata: Metadata = { title: "Supply" };

const textarea =
  "border-input bg-card placeholder:text-muted-foreground focus-visible:ring-ring w-full rounded-md border px-3 py-2 text-sm outline-none focus-visible:ring-2";
const KIND: Record<string, string> = {
  count: "Counted",
  received: "Came in",
  adjustment: "Corrected",
};

function Field({
  id,
  label,
  hint,
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {hint && <p className="text-muted-foreground text-xs">{hint}</p>}
    </div>
  );
}

/** One supply: its details and classes, a count or delivery, its orders and what happened. */
export default async function SupplyPage({
  params,
}: {
  params: Promise<{ slug: string; id: string }>;
}) {
  const { slug, id } = await params;
  const access = await bookingsAccess(slug, `/w/${slug}/bookings/supplies/${id}`);
  if (!access.ok) return access.upsell;
  const { tenant, role, entitlements } = access;
  const manager = canManage(role) && entitlements.canWrite;
  const fresh = id === "new";
  if (fresh && !manager) notFound();
  if (!fresh && !/^[0-9a-f-]{36}$/i.test(id)) notFound();

  const supabase = await createClient();
  const [loaded, { data: services }] = await Promise.all([
    loadSupplies(supabase, tenant.id, tenant.timezone),
    supabase
      .from("services")
      .select("id, name, active")
      .eq("tenant_id", tenant.id)
      .eq("kind", "workshop")
      .order("name"),
  ]);
  const figures = fresh ? null : loaded.figures.find((f) => f.supply.id === id);
  if (!fresh && !figures) notFound();
  const supply = figures?.supply;
  const workshops = (services ?? []) as { id: string; name: string; active: boolean }[];
  const orders = loaded.orders.filter((o) => o.supply_id === id);
  const history = loaded.entries
    .filter((e) => e.supply_id === id)
    .reverse()
    .slice(0, 30);
  const at = (instant: string) =>
    new Intl.DateTimeFormat("en-US", {
      timeZone: tenant.timezone,
      month: "short",
      day: "numeric",
      year: "numeric",
    }).format(new Date(instant));
  const today = localDay(new Date(), tenant.timezone);
  const back = { href: `/w/${tenant.slug}/bookings/supplies`, label: "Classroom supplies" };

  const details = (
    <>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field id="name" label="Name">
          <Input id="name" name="name" defaultValue={supply?.name} maxLength={120} required />
        </Field>
        <Field id="vendor" label="Vendor">
          <Select id="vendor" name="vendor_id" defaultValue={supply?.vendor_id ?? ""}>
            <option value="">None</option>
            {loaded.vendors.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field id="unit" label="Counted in" hint="Rolls, yards, bottles… Shown beside the numbers.">
          <Input id="unit" name="unit" defaultValue={supply?.unit} maxLength={30} />
        </Field>
        <Field id="per" label="One person uses" hint="A fraction is fine: 0.5.">
          <Input
            id="per"
            name="per_student"
            inputMode="decimal"
            defaultValue={supply?.per_student ?? 1}
            required
          />
        </Field>
        <Field id="lead" label="Lead time, days" hint="From ordering to it arriving.">
          <Input
            id="lead"
            name="lead_time_days"
            type="number"
            min={0}
            max={365}
            defaultValue={supply?.lead_time_days ?? 7}
          />
        </Field>
        <Field id="safety" label="Keep at least" hint="The buffer the order-by date protects.">
          <Input
            id="safety"
            name="safety_stock"
            inputMode="decimal"
            defaultValue={supply?.safety_stock ?? 0}
          />
        </Field>
        <Field id="coverage" label="An order should last, days" hint="After it arrives.">
          <Input
            id="coverage"
            name="coverage_days"
            type="number"
            min={1}
            max={730}
            defaultValue={supply?.coverage_days ?? 60}
          />
        </Field>
        <Field
          id="cost"
          label="Cost of one, $"
          hint="For the budget's materials. Leave at 0 for anything priced by the square foot there."
        >
          <Input
            id="cost"
            name="unit_cost"
            inputMode="decimal"
            defaultValue={supply ? (supply.unit_cost_cents / 100).toFixed(2) : "0.00"}
          />
        </Field>
        {fresh && (
          <Field id="count" label="How many you have now">
            <Input id="count" name="count" inputMode="decimal" defaultValue="0" />
          </Field>
        )}
      </div>
      <fieldset className="flex flex-col gap-1.5">
        <legend className="mb-1 text-xs font-semibold">Used in these classes</legend>
        {workshops.length === 0 && (
          <p className="text-muted-foreground text-xs">Add a workshop first.</p>
        )}
        {workshops.map((w) => (
          <label key={w.id} className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              name="service"
              value={w.id}
              defaultChecked={fresh ? w.active : figures?.linked.has(w.id)}
            />
            {w.name}
            {!w.active && <span className="text-muted-foreground text-xs">switched off</span>}
          </label>
        ))}
      </fieldset>
      <Field id="notes" label="Notes">
        <textarea
          id="notes"
          name="notes"
          rows={2}
          maxLength={2000}
          defaultValue={supply?.notes}
          className={textarea}
        />
      </Field>
      {!fresh && (
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="active" defaultChecked={supply?.active} />
          Still in use (untick to keep it on the list without planning for it)
        </label>
      )}
    </>
  );

  if (fresh) {
    return (
      <>
        <PageHeader title="Add a supply" back={back} />
        <Card>
          <CardContent className="pt-5">
            <StudioForm action={saveSupply.bind(null, tenant.slug, null)} submit="Add the supply">
              {details}
            </StudioForm>
          </CardContent>
        </Card>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title={supply!.name}
        back={back}
        description={`About ${figures!.stock.qty}${supply!.unit ? ` ${supply!.unit}` : ""} on hand${figures!.incoming > 0 ? `, ${figures!.incoming} on its way` : ""}.`}
      />
      {manager && (
        <Card>
          <CardHeader>
            <CardTitle>Count, delivery or correction</CardTitle>
            <CardDescription>
              A count is what&apos;s on the shelf right now: classes from then on are taken off it.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <StudioForm
              action={addSupplyEntry.bind(null, tenant.slug, supply!.id)}
              submit="Write it down"
              variant="outline"
            >
              <div className="grid gap-4 sm:grid-cols-3">
                <Field id="kind" label="What happened">
                  <Select id="kind" name="kind" defaultValue="count">
                    <option value="count">I counted it</option>
                    <option value="received">Some came in</option>
                    <option value="adjustment">A correction (+ or −)</option>
                  </Select>
                </Field>
                <Field id="qty" label="How many">
                  <Input id="qty" name="qty" inputMode="decimal" required />
                </Field>
                <Field id="entry-note" label="Note">
                  <Input id="entry-note" name="note" maxLength={500} />
                </Field>
              </div>
            </StudioForm>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Orders</CardTitle>
          <CardDescription>
            An open order counts as on its way from the end of the day you expect it.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {orders.length === 0 ? (
            <p className="text-muted-foreground text-sm">No orders written down.</p>
          ) : (
            <ul className="divide-border flex flex-col divide-y text-sm">
              {orders.map((o) => (
                <li key={o.id} className="flex flex-wrap items-center gap-3 py-2">
                  <span className="tabular-nums">{o.qty}</span>
                  <span className="text-muted-foreground">
                    ordered {o.placed_on}, expected {o.expected_on}
                  </span>
                  {o.status === "open" ? (
                    <Badge tone={o.expected_on < today ? "bad" : "open"}>
                      {o.expected_on < today ? "Late" : "On its way"}
                    </Badge>
                  ) : (
                    <Badge tone={o.status === "received" ? "good" : "closed"}>
                      {o.status === "received" ? "Received" : "Cancelled"}
                    </Badge>
                  )}
                  {o.note && <span className="text-muted-foreground text-xs">{o.note}</span>}
                  {manager && o.status === "open" && (
                    <>
                      <StudioForm
                        action={receiveSupplyOrder.bind(null, tenant.slug, o.id)}
                        submit="It came"
                        variant="outline"
                        className="flex items-center gap-2"
                      >
                        <Input
                          name="qty"
                          inputMode="decimal"
                          defaultValue={o.qty}
                          aria-label="How many came"
                          className="w-20"
                        />
                      </StudioForm>
                      <StudioForm
                        action={cancelSupplyOrder.bind(null, tenant.slug, o.id)}
                        submit="Cancel it"
                        variant="ghost"
                        className="flex items-center gap-2"
                      />
                    </>
                  )}
                </li>
              ))}
            </ul>
          )}
          {manager && (
            <StudioForm
              action={placeSupplyOrder.bind(null, tenant.slug, supply!.id)}
              submit="Write down an order"
              variant="outline"
            >
              <div className="grid gap-4 sm:grid-cols-3">
                <Field id="order-qty" label="How many">
                  <Input
                    id="order-qty"
                    name="qty"
                    inputMode="decimal"
                    defaultValue={figures!.suggested || ""}
                    required
                  />
                </Field>
                <Field id="order-day" label="Expected">
                  <Input id="order-day" name="expected_on" type="date" min={today} required />
                </Field>
                <Field id="order-note" label="Note">
                  <Input id="order-note" name="note" maxLength={500} />
                </Field>
              </div>
            </StudioForm>
          )}
        </CardContent>
      </Card>

      {manager && (
        <Card>
          <CardHeader>
            <CardTitle>Details</CardTitle>
          </CardHeader>
          <CardContent>
            <StudioForm action={saveSupply.bind(null, tenant.slug, supply!.id)} submit="Save">
              {details}
            </StudioForm>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>What was written down</CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="divide-border flex flex-col divide-y text-sm">
            {history.map((e) => (
              <li key={e.id} className="flex flex-wrap gap-3 py-2">
                <span className="tabular-nums">{at(e.at)}</span>
                <span>{KIND[e.kind]}</span>
                <span className="tabular-nums">
                  {e.kind === "adjustment" && e.qty > 0 ? "+" : ""}
                  {e.qty}
                </span>
                {e.note && <span className="text-muted-foreground">{e.note}</span>}
              </li>
            ))}
          </ul>
          <p className="text-muted-foreground mt-3 text-xs">
            What classes use isn&apos;t written down: it is worked out from the places booked each
            time you look, so a refund before a class is never taken off the shelf.
          </p>
        </CardContent>
      </Card>
    </>
  );
}
