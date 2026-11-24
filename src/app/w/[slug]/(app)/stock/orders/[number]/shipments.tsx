"use client";

import { useActionState } from "react";
import { Badge } from "@/components/ui/badge";
import { Input, Label, Select } from "@/components/ui/input";
import { SubmitButton } from "@/components/ui/submit-button";
import { CARRIERS } from "@/lib/shipping/carriers";
import { checkShipmentNow, saveShipment, saveShipmentItems, updateShipment } from "../../actions";
import { Result } from "../../forms";

export type ShipmentRow = {
  id: string;
  carrier: string;
  tracking: string;
  expected: string | null;
  /** Dates as words, worked out on the server in the workspace's own calendar. */
  expectedText: string | null;
  arrivedText: string | null;
  late: boolean;
  note: string;
  /** The carrier's own tracking page, when we know the carrier. */
  url: string | null;
  /**
   * What the carrier told us, already in words (worked out on the server).
   * Null when the carrier hasn't been asked: the parcel is as a person recorded it.
   */
  carrier_said: {
    label: string;
    tone: "open" | "waiting" | "good" | "bad" | "closed";
    /** "Departed from Facility · Louisville, KY, US · Nov 23, 2026, 7:13 AM" */
    detail: string | null;
    /** "UPS was asked Nov 24, 2026, 9:02 AM" */
    checked: string | null;
    /** The last look-up went wrong: why, in plain words. */
    trouble: string | null;
  } | null;
  /** A manager can ask the carrier now. */
  canCheck: boolean;
  /** Which lines are in this parcel. */
  items: { lineId: string; name: string; quantity: number }[];
};

export type ShipmentLine = { id: string; name: string; ordered: number };

/** "Check now" for one UPS parcel. */
function CheckNow({ slug, shipmentId }: { slug: string; shipmentId: string }) {
  const [state, action] = useActionState(checkShipmentNow.bind(null, slug, shipmentId), {});
  return (
    <form action={action} className="flex flex-col items-end">
      <SubmitButton variant="ghost" size="sm" pendingText="Asking…">
        Check now
      </SubmitButton>
      {state.error && <span className="text-brick max-w-56 text-right text-xs">{state.error}</span>}
      {state.message && (
        <span className="text-muted-foreground max-w-56 text-right text-xs">{state.message}</span>
      )}
    </form>
  );
}

/** Which of the order's lines are in a parcel, and how many: shown, and changed by managers. */
function ParcelItems({
  slug,
  shipment,
  lines,
  canEdit,
}: {
  slug: string;
  shipment: ShipmentRow;
  lines: ShipmentLine[];
  canEdit: boolean;
}) {
  const [state, action] = useActionState(saveShipmentItems.bind(null, slug, shipment.id), {});
  const inIt = new Map(shipment.items.map((item) => [item.lineId, item.quantity]));
  const summary =
    shipment.items.length > 0
      ? shipment.items.map((item) => `${item.quantity} × ${item.name}`).join(", ")
      : null;
  if (!canEdit) {
    return summary ? (
      <span className="text-muted-foreground font-read block basis-full text-xs">
        In it: {summary}
      </span>
    ) : null;
  }
  return (
    <details className="basis-full text-xs print:hidden">
      <summary className="text-muted-foreground cursor-pointer">
        {summary ? `In it: ${summary}` : "Say what's in this parcel"}
      </summary>
      <form action={action} className="mt-2 flex flex-col gap-2">
        <ul className="flex flex-col gap-1.5">
          {lines.map((line) => (
            <li key={line.id} className="flex items-center gap-2">
              <Input
                name={`qty_${line.id}`}
                type="number"
                min={0}
                max={1000000}
                defaultValue={inIt.get(line.id) ?? ""}
                aria-label={`How many ${line.name} are in this parcel`}
                className="h-8 w-20"
              />
              <span className="font-read">
                {line.name} <span className="text-muted-foreground">(ordered {line.ordered})</span>
              </span>
            </li>
          ))}
        </ul>
        <Result state={state} />
        <SubmitButton variant="outline" size="sm" pendingText="Saving…" className="w-fit">
          Save what&apos;s in it
        </SubmitButton>
      </form>
    </details>
  );
}

function ShipmentAction({
  slug,
  orderId,
  shipmentId,
  what,
  label,
  pending,
  variant = "ghost",
}: {
  slug: string;
  orderId: string;
  shipmentId: string;
  what: "arrived" | "not_arrived" | "remove";
  label: string;
  pending: string;
  variant?: "ghost" | "outline" | "danger";
}) {
  const [state, action] = useActionState(
    updateShipment.bind(null, slug, orderId, shipmentId, what),
    {},
  );
  return (
    <form action={action} className="flex flex-col items-end">
      <SubmitButton variant={variant} size="sm" pendingText={pending}>
        {label}
      </SubmitButton>
      {state.error && <span className="text-brick text-xs">{state.error}</span>}
    </form>
  );
}

/** The tracking numbers on an order, each with a link to the carrier's page. */
export function ShipmentList({
  slug,
  orderId,
  shipments,
  lines,
  canEdit,
}: {
  slug: string;
  orderId: string;
  shipments: ShipmentRow[];
  /** The order's lines, for saying what's in each parcel. */
  lines: ShipmentLine[];
  canEdit: boolean;
}) {
  if (shipments.length === 0) return null;
  return (
    <ul className="divide-border flex flex-col divide-y">
      {shipments.map((s) => (
        <li key={s.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 py-2.5 text-sm">
          <span className="min-w-0 flex-1 basis-56">
            <span className="font-semibold">{s.carrier || "Carrier not set"}</span>{" "}
            {s.url ? (
              <a
                href={s.url}
                target="_blank"
                rel="noreferrer"
                className="text-ochre-text font-mono text-xs underline-offset-2 hover:underline"
              >
                {s.tracking}
              </a>
            ) : (
              <span className="font-mono text-xs">{s.tracking}</span>
            )}
            {s.note && (
              <span className="text-muted-foreground font-read block text-xs">{s.note}</span>
            )}
            {s.carrier_said?.detail && (
              <span className="text-muted-foreground font-read block text-xs">
                {s.carrier_said.detail}
              </span>
            )}
            {s.carrier_said?.trouble && (
              <span className="text-brick font-read block text-xs">{s.carrier_said.trouble}</span>
            )}
            {s.carrier_said?.checked && (
              <span className="text-muted-foreground block text-xs">{s.carrier_said.checked}</span>
            )}
          </span>
          {s.arrivedText ? (
            <Badge tone="good">Arrived {s.arrivedText}</Badge>
          ) : s.late ? (
            <Badge tone="bad">Late: was due {s.expectedText}</Badge>
          ) : s.carrier_said ? (
            <Badge tone={s.carrier_said.tone}>
              {s.carrier_said.label}
              {s.expectedText ? `, due ${s.expectedText}` : ""}
            </Badge>
          ) : (
            <Badge tone="open">
              {s.expectedText ? `On its way, due ${s.expectedText}` : "On its way"}
            </Badge>
          )}
          {canEdit && (
            <span className="flex items-center gap-1 print:hidden">
              {s.canCheck && <CheckNow slug={slug} shipmentId={s.id} />}
              {s.arrivedText ? (
                <ShipmentAction
                  slug={slug}
                  orderId={orderId}
                  shipmentId={s.id}
                  what="not_arrived"
                  label="Not here after all"
                  pending="Saving…"
                />
              ) : (
                <ShipmentAction
                  slug={slug}
                  orderId={orderId}
                  shipmentId={s.id}
                  what="arrived"
                  label="It's here"
                  pending="Saving…"
                  variant="outline"
                />
              )}
              <ShipmentAction
                slug={slug}
                orderId={orderId}
                shipmentId={s.id}
                what="remove"
                label="Take off"
                pending="Removing…"
                variant="danger"
              />
            </span>
          )}
          <ParcelItems slug={slug} shipment={s} lines={lines} canEdit={canEdit} />
        </li>
      ))}
    </ul>
  );
}

export function AddShipmentForm({ slug, orderId }: { slug: string; orderId: string }) {
  const [state, action] = useActionState(saveShipment.bind(null, slug, orderId, null), {});
  return (
    <form action={action} className="flex flex-col gap-3 print:hidden">
      <div className="grid gap-3 sm:grid-cols-[1.4fr_1fr_10rem]">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="ship-tracking">Tracking number</Label>
          <Input id="ship-tracking" name="tracking" maxLength={80} required />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="ship-carrier">Carrier</Label>
          <Select id="ship-carrier" name="carrier" defaultValue="">
            <option value="">Work it out from the number</option>
            {CARRIERS.map((carrier) => (
              <option key={carrier} value={carrier}>
                {carrier}
              </option>
            ))}
            <option value="Freight">Freight</option>
            <option value="Other">Other</option>
          </Select>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="ship-expected">Due to arrive</Label>
          <Input id="ship-expected" name="expected" type="date" />
        </div>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="ship-note">Note</Label>
        <Input
          id="ship-note"
          name="note"
          maxLength={300}
          placeholder="By sea, two pallets, the yarn only…"
        />
      </div>
      <Result state={state} />
      <SubmitButton variant="outline" pendingText="Adding…" className="sm:w-fit">
        Add tracking
      </SubmitButton>
    </form>
  );
}
