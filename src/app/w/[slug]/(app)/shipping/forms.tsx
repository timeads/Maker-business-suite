"use client";

import { useActionState, useState } from "react";
import { Printer } from "lucide-react";
import { Button } from "@/components/ui/button";
import { FormMessage } from "@/components/ui/form-message";
import { Input, Label } from "@/components/ui/input";
import { SubmitButton } from "@/components/ui/submit-button";
import { CARRIERS, guessCarrier } from "@/lib/shipping/carriers";
import {
  recordParcel,
  saveShippingSettings,
  setHold,
  voidParcel,
  type ShippingState,
} from "./actions";

const textarea =
  "border-input bg-card placeholder:text-muted-foreground focus-visible:border-ochre focus-visible:ring-ochre/25 w-full rounded-sm border px-[11px] py-2 text-sm outline-none focus-visible:ring-2";

function Result({ state }: { state: ShippingState }) {
  return (
    <>
      <FormMessage>{state.error}</FormMessage>
      <FormMessage kind="success">{state.message}</FormMessage>
    </>
  );
}

export function PrintButton({ label = "Print" }: { label?: string }) {
  return (
    <Button variant="outline" size="sm" className="print:hidden" onClick={() => window.print()}>
      <Printer /> {label}
    </Button>
  );
}

type Line = { line_id: string; title: string; variant: string | null; left: number };

/**
 * Recording a parcel. With an order it lists what's left, filled in as
 * "everything"; lower a number to send part now and the rest later.
 */
export function ParcelForm({
  slug,
  orderId,
  lines,
  defaultCarrier,
  shopOffered,
  shopDefault,
  notifyDefault,
  currency,
}: {
  slug: string;
  orderId: string | null;
  lines: Line[];
  defaultCarrier: string;
  /** The shop will take "this has been sent" from us. */
  shopOffered: boolean;
  shopDefault: boolean;
  notifyDefault: boolean;
  currency: string;
}) {
  const [state, action] = useActionState(recordParcel.bind(null, slug, orderId), {});
  const [carrier, setCarrier] = useState(defaultCarrier);
  const [inShop, setInShop] = useState(shopOffered && shopDefault);
  return (
    <form action={action} className="flex flex-col gap-4">
      {!orderId && (
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="parcel-recipient">Who it&apos;s for</Label>
            <Input id="parcel-recipient" name="recipient" maxLength={120} required />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="parcel-destination">Going to</Label>
            <Input
              id="parcel-destination"
              name="destination"
              maxLength={120}
              placeholder="Portland, OR"
            />
          </div>
        </div>
      )}
      {lines.length > 0 && (
        <fieldset className="flex flex-col gap-2">
          <legend className="text-xs leading-tight font-semibold">In this parcel</legend>
          <ul className="divide-border flex flex-col divide-y">
            {lines.map((line) => (
              <li key={line.line_id} className="flex items-center gap-3 py-2">
                <Input
                  name={`qty:${line.line_id}`}
                  type="number"
                  min={0}
                  max={line.left}
                  defaultValue={line.left}
                  aria-label={`How many ${line.title}`}
                  className="w-20"
                />
                <span className="text-sm">
                  <span className="text-muted-foreground tabular-nums">of {line.left} · </span>
                  <span className="font-read">
                    {line.title}
                    {line.variant ? ` (${line.variant})` : ""}
                  </span>
                </span>
              </li>
            ))}
          </ul>
          {lines.length > 0 && (
            <p className="text-muted-foreground text-xs">
              Lower a number to send part now. The rest stays on your to-send list.
            </p>
          )}
        </fieldset>
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="parcel-tracking">Tracking number</Label>
          <Input
            id="parcel-tracking"
            name="tracking"
            maxLength={120}
            autoComplete="off"
            placeholder="Scan or paste it"
            onChange={(event) => {
              const guess = guessCarrier(event.target.value);
              if (guess) setCarrier(guess);
            }}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="parcel-carrier">Carrier</Label>
          <Input
            id="parcel-carrier"
            name="carrier"
            list="carriers"
            maxLength={60}
            value={carrier}
            onChange={(event) => setCarrier(event.target.value)}
            required
          />
          <datalist id="carriers">
            {CARRIERS.map((name) => (
              <option key={name} value={name} />
            ))}
          </datalist>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="parcel-service">Service</Label>
          <Input id="parcel-service" name="service" maxLength={80} placeholder="Ground Advantage" />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="parcel-cost">Postage paid ({currency})</Label>
          <Input id="parcel-cost" name="cost" type="number" min={0} step="0.01" />
        </div>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="parcel-note">Note for your team</Label>
        <Input id="parcel-note" name="note" maxLength={500} />
      </div>
      {shopOffered && orderId && (
        <div className="flex flex-col gap-2">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              name="push"
              checked={inShop}
              onChange={(event) => setInShop(event.target.checked)}
            />
            Mark it as sent in my shop
          </label>
          {inShop && (
            <label className="flex items-center gap-2 pl-6 text-sm">
              <input type="checkbox" name="notify" defaultChecked={notifyDefault} />
              Have my shop email the customer their tracking number
            </label>
          )}
        </div>
      )}
      <Result state={state} />
      <SubmitButton
        variant={orderId ? "default" : "outline"}
        pendingText="Recording…"
        className="sm:w-fit"
      >
        {orderId ? "Record this parcel" : "Record parcel"}
      </SubmitButton>
    </form>
  );
}

export function HoldForm({
  slug,
  orderId,
  onHold,
  reason,
}: {
  slug: string;
  orderId: string;
  onHold: boolean;
  reason: string;
}) {
  const [state, action] = useActionState(setHold.bind(null, slug, orderId, !onHold), {});
  return (
    <form action={action} className="flex flex-col gap-2">
      {onHold ? (
        <p className="text-sm">
          On hold{reason ? <span className="font-read">: {reason}</span> : "."}
        </p>
      ) : (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="hold-reason">Why it&apos;s waiting</Label>
          <Input
            id="hold-reason"
            name="reason"
            maxLength={300}
            placeholder="Waiting on yarn, checking the address…"
          />
        </div>
      )}
      <Result state={state} />
      <SubmitButton variant="outline" size="sm" pendingText="Saving…" className="w-fit">
        {onHold ? "Take it off hold" : "Put on hold"}
      </SubmitButton>
    </form>
  );
}

export function VoidButton({ slug, shipmentId }: { slug: string; shipmentId: string }) {
  const [state, action] = useActionState(voidParcel.bind(null, slug, shipmentId), {});
  return (
    <form action={action} className="flex flex-col items-end gap-1">
      <SubmitButton variant="ghost" size="sm" pendingText="Undoing…">
        Undo
      </SubmitButton>
      {(state.error || state.message) && (
        <span className="text-muted-foreground max-w-56 text-right text-xs">
          {state.error ?? state.message}
        </span>
      )}
    </form>
  );
}

export function ShippingSettingsForm({
  slug,
  settings,
  canSend,
}: {
  slug: string;
  settings: {
    ship_from: {
      name: string;
      address1: string;
      address2: string;
      city_line: string;
      country: string;
    };
    slip_note: string;
    slip_show_sku: boolean;
    default_carrier: string;
    mark_sent_in_shop: boolean;
    notify_customer: boolean;
  };
  canSend: boolean;
}) {
  const [state, action] = useActionState(saveShippingSettings.bind(null, slug), {});
  const from = settings.ship_from;
  return (
    <form action={action} className="flex flex-col gap-5">
      <fieldset className="flex flex-col gap-3">
        <legend className="mb-2 text-sm font-semibold">On your packing slips</legend>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="from-name">Your name or business</Label>
            <Input id="from-name" name="from_name" maxLength={120} defaultValue={from.name} />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="from-address1">Address</Label>
            <Input
              id="from-address1"
              name="from_address1"
              maxLength={120}
              defaultValue={from.address1}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="from-address2">Address, second line</Label>
            <Input
              id="from-address2"
              name="from_address2"
              maxLength={120}
              defaultValue={from.address2}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="from-city">Town, state and postcode</Label>
            <Input
              id="from-city"
              name="from_city_line"
              maxLength={120}
              defaultValue={from.city_line}
              placeholder="Hudson, NY 12534"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="from-country">Country</Label>
            <Input
              id="from-country"
              name="from_country"
              maxLength={120}
              defaultValue={from.country}
            />
          </div>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="slip-note">A note at the bottom</Label>
          <textarea
            id="slip-note"
            name="slip_note"
            rows={3}
            maxLength={600}
            defaultValue={settings.slip_note}
            placeholder="Thank you for supporting a small studio! Care: shake out, don't machine wash."
            className={`${textarea} font-read`}
          />
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="slip_show_sku" defaultChecked={settings.slip_show_sku} />
          Show item codes, for whoever is picking
        </label>
      </fieldset>

      <fieldset className="flex flex-col gap-3">
        <legend className="mb-2 text-sm font-semibold">When you record a parcel</legend>
        <div className="flex flex-col gap-1.5 sm:max-w-xs">
          <Label htmlFor="default-carrier">Your usual carrier</Label>
          <Input
            id="default-carrier"
            name="default_carrier"
            list="carriers-setting"
            maxLength={60}
            defaultValue={settings.default_carrier}
          />
          <datalist id="carriers-setting">
            {CARRIERS.map((name) => (
              <option key={name} value={name} />
            ))}
          </datalist>
        </div>
        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            name="mark_sent_in_shop"
            defaultChecked={settings.mark_sent_in_shop && canSend}
            disabled={!canSend}
            className="mt-1"
          />
          <span>
            Mark the order as sent in my shop
            <span className="text-muted-foreground block text-xs">
              {canSend
                ? "The tracking number goes with it. You can untick it for any one parcel."
                : "Your shop hasn't given permission for this yet. Until it does, mark orders as sent in your shop yourself."}
            </span>
          </span>
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            name="notify_customer"
            defaultChecked={settings.notify_customer}
            disabled={!canSend}
          />
          …and have my shop email the customer their tracking number
        </label>
      </fieldset>
      <Result state={state} />
      <SubmitButton pendingText="Saving…" className="sm:w-fit">
        Save settings
      </SubmitButton>
    </form>
  );
}
