"use client";

import { useActionState } from "react";
import { Badge } from "@/components/ui/badge";
import { Input, Label, Select } from "@/components/ui/input";
import { SubmitButton } from "@/components/ui/submit-button";
import { CARRIERS } from "@/lib/shipping/carriers";
import { saveShipment, updateShipment } from "../../actions";
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
};

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
  canEdit,
}: {
  slug: string;
  orderId: string;
  shipments: ShipmentRow[];
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
          </span>
          {s.arrivedText ? (
            <Badge tone="good">Arrived {s.arrivedText}</Badge>
          ) : s.late ? (
            <Badge tone="bad">Late: was due {s.expectedText}</Badge>
          ) : (
            <Badge tone="open">
              {s.expectedText ? `On its way, due ${s.expectedText}` : "On its way"}
            </Badge>
          )}
          {canEdit && (
            <span className="flex items-center gap-1 print:hidden">
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
