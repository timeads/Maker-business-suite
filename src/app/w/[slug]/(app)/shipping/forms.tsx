"use client";

import { useActionState, useEffect, useState } from "react";
import { ArrowDown, ArrowUp, Printer } from "lucide-react";
import { Button } from "@/components/ui/button";
import { FormMessage } from "@/components/ui/form-message";
import { Input, Label, Select } from "@/components/ui/input";
import { SubmitButton } from "@/components/ui/submit-button";
import { CARRIERS, guessCarrier } from "@/lib/shipping/carriers";
import {
  SLIP_SECTION_NAMES,
  SLIP_TEXT_SIZES,
  shipFromParts,
  type SlipLayout,
  type SlipSection,
} from "@/lib/shipping/config";
import { formatHoldDate } from "@/lib/shipping/queue";
import {
  markPickedUp,
  markPickupReady,
  recordParcel,
  saveShippingSettings,
  saveSlipLayout,
  seenBackFromHold,
  setHold,
  undoPickup,
  voidParcel,
  type ShippingState,
} from "./actions";
import { HoldPickerField, type HoldChoice } from "./hold-picker";

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
  quiet = false,
  backTo,
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
  /** Another button on the screen is the main one. */
  quiet?: boolean;
  /** Where to land once it's recorded. */
  backTo?: "scan";
}) {
  const [state, action] = useActionState(recordParcel.bind(null, slug, orderId), {});
  const [carrier, setCarrier] = useState(defaultCarrier);
  const [inShop, setInShop] = useState(shopOffered && shopDefault);
  return (
    <form action={action} className="flex flex-col gap-4">
      {backTo && <input type="hidden" name="back" value={backTo} />}
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
        variant={orderId && !quiet ? "default" : "outline"}
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
  hold,
  reason,
  until,
  today,
  choices,
}: {
  slug: string;
  orderId: string;
  /** "back": its day has come, so it is in the queue again. */
  hold: "none" | "held" | "back";
  reason: string;
  until: string | null;
  today: string;
  choices: HoldChoice[];
}) {
  const held = hold === "held";
  const [state, action] = useActionState(setHold.bind(null, slug, orderId, !held), {});
  return (
    <form action={action} className="flex flex-col gap-3">
      {held ? (
        <p className="text-sm">
          On hold{until ? ` until ${formatHoldDate(until)}` : ""}
          {reason ? <span className="font-read">: {reason}</span> : "."}
          {until && (
            <span className="text-muted-foreground block text-xs">
              It comes back to Ready to ship that day.
            </span>
          )}
        </p>
      ) : (
        <>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="hold-reason">Why it&apos;s waiting</Label>
            <Input
              id="hold-reason"
              name="reason"
              maxLength={300}
              placeholder="Waiting on yarn, checking the address…"
            />
          </div>
          <HoldPickerField id="hold-until" today={today} choices={choices} />
        </>
      )}
      <Result state={state} />
      <SubmitButton variant="outline" size="sm" pendingText="Saving…" className="w-fit">
        {held ? "Release it" : "Put on hold"}
      </SubmitButton>
    </form>
  );
}

/** Opening an order whose hold has run out is what stops it saying "Back from hold". */
export function SeenBackFromHold({ slug, orderId }: { slug: string; orderId: string }) {
  useEffect(() => {
    void seenBackFromHold(slug, orderId);
  }, [slug, orderId]);
  return null;
}

/** The two steps of an in-store pickup. Kept here; the shop isn't told. */
export function PickupForm({
  slug,
  orderId,
  ready,
  pickedUp,
  canUndo,
}: {
  slug: string;
  orderId: string;
  ready: boolean;
  pickedUp: boolean;
  canUndo: boolean;
}) {
  const [readyState, readyAction] = useActionState(
    async (): Promise<ShippingState> => markPickupReady(slug, [orderId]),
    {},
  );
  const [pickedState, pickedAction] = useActionState(markPickedUp.bind(null, slug, orderId), {});
  const [undoState, undoAction] = useActionState(undoPickup.bind(null, slug, orderId), {});
  return (
    <div className="flex flex-col gap-3">
      {!ready && !pickedUp && (
        <form action={readyAction} className="flex flex-col gap-2">
          <Result state={readyState} />
          <SubmitButton pendingText="Saving…" className="w-fit">
            Mark ready for pickup
          </SubmitButton>
        </form>
      )}
      {ready && !pickedUp && (
        <form action={pickedAction} className="flex flex-col gap-2">
          <Result state={pickedState} />
          <SubmitButton pendingText="Saving…" className="w-fit">
            Mark picked up
          </SubmitButton>
        </form>
      )}
      {canUndo && (ready || pickedUp) && (
        <form action={undoAction} className="flex flex-col items-start gap-1">
          <SubmitButton variant="ghost" size="sm" pendingText="Undoing…">
            {pickedUp ? "Not picked up after all" : "Not ready after all"}
          </SubmitButton>
          <FormMessage>{undoState.error}</FormMessage>
        </form>
      )}
    </div>
  );
}

export function VoidButton({
  slug,
  shipmentId,
  label = false,
  source = "easypost",
}: {
  slug: string;
  shipmentId: string;
  /** Its postage was bought here, so undoing it also asks for the money back. */
  label?: boolean;
  /** Where it was bought: "easypost", "ups" or "redo". */
  source?: string | null;
}) {
  const via = source === "ups" ? "UPS" : source === "redo" ? "Redo" : "EasyPost";
  const ask =
    source === "ups"
      ? "Void this label? We'll cancel it with UPS so it isn't billed, and put its items back on your to-send list. Don't use the label after this."
      : source === "redo"
        ? "Void this label? We'll ask Redo to cancel it and put the postage back on your labels balance, and put its items back on your to-send list. Don't use the label after this."
        : "Void this label? We'll ask EasyPost to refund the postage and put its items back on your to-send list. Don't use the label after this.";
  const [state, action] = useActionState(voidParcel.bind(null, slug, shipmentId), {});
  return (
    <form
      action={action}
      className="flex flex-col items-end gap-1"
      onSubmit={(event) => {
        if (label && !window.confirm(ask)) {
          event.preventDefault();
        }
      }}
    >
      <SubmitButton variant="ghost" size="sm" pendingText={label ? `Asking ${via}…` : "Undoing…"}>
        {label ? "Void label" : "Undo"}
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
      city: string;
      region: string;
      postal_code: string;
      phone: string;
      country: string;
    };
    ship_from_country: string;
    default_carrier: string;
    mark_sent_in_shop: boolean;
    notify_customer: boolean;
    signature_over: number | null;
  };
  canSend: boolean;
}) {
  const [state, action] = useActionState(saveShippingSettings.bind(null, slug), {});
  const from = settings.ship_from;
  const town = shipFromParts(from);
  return (
    <form action={action} className="flex flex-col gap-5">
      <fieldset className="flex flex-col gap-3">
        <legend className="mb-2 text-sm font-semibold">Where you ship from</legend>
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
            <Label htmlFor="from-city">Town or city</Label>
            <Input
              id="from-city"
              name="from_city"
              maxLength={120}
              defaultValue={town.city}
              placeholder="Hudson"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="from-region">State</Label>
              <Input
                id="from-region"
                name="from_region"
                maxLength={60}
                defaultValue={town.region}
                placeholder="NY"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="from-postal">ZIP or postcode</Label>
              <Input
                id="from-postal"
                name="from_postal_code"
                maxLength={20}
                defaultValue={town.postal_code}
                placeholder="12534"
              />
            </div>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="from-phone">Phone</Label>
            <Input
              id="from-phone"
              name="from_phone"
              type="tel"
              maxLength={30}
              defaultValue={from.phone}
              aria-describedby="from-phone-help"
            />
            <span id="from-phone-help" className="text-muted-foreground text-xs">
              Carriers ask for one on every label. It isn&apos;t printed on packing slips.
            </span>
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
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="from-country-code">Country code parcels leave from</Label>
            <Input
              id="from-country-code"
              name="ship_from_country"
              maxLength={2}
              minLength={2}
              pattern="[A-Za-z]{2}"
              defaultValue={settings.ship_from_country}
              className="w-20 uppercase"
              aria-describedby="from-country-code-help"
              required
            />
            <span id="from-country-code-help" className="text-muted-foreground text-xs">
              Two letters, like US, CA or GB. Orders going anywhere else show under International.
            </span>
          </div>
        </div>
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

      <fieldset className="flex flex-col gap-1.5 sm:max-w-xs">
        <legend className="mb-2 text-sm font-semibold">When you buy a label</legend>
        <Label htmlFor="signature-over">Ask for a signature on orders of at least</Label>
        <Input
          id="signature-over"
          name="signature_over"
          inputMode="decimal"
          placeholder="Never"
          defaultValue={settings.signature_over ?? ""}
        />
        <span className="text-muted-foreground text-xs">
          The order&apos;s total, in your currency. Leave empty to never ask by default. You can
          still change it on any one label.
        </span>
      </fieldset>
      <Result state={state} />
      <SubmitButton variant="outline" pendingText="Saving…" className="sm:w-fit">
        Save settings
      </SubmitButton>
    </form>
  );
}

/** What a packing slip shows and in what order. The preview beside it is drawn by the page. */
export function SlipLayoutForm({ slug, layout }: { slug: string; layout: SlipLayout }) {
  const [state, action] = useActionState(saveSlipLayout.bind(null, slug), {});
  const [order, setOrder] = useState<SlipSection[]>(layout.sections.map((section) => section.id));
  const on = new Map(layout.sections.map((section) => [section.id, section.on]));
  const move = (index: number, by: -1 | 1) =>
    setOrder((before) => {
      const next = [...before];
      const to = index + by;
      if (to < 0 || to >= next.length) return before;
      [next[index], next[to]] = [next[to], next[index]];
      return next;
    });
  return (
    <form action={action} className="flex flex-col gap-5">
      <input type="hidden" name="order" value={order.join(",")} />
      <fieldset className="flex flex-col gap-1">
        <legend className="mb-2 text-sm font-semibold">
          What&apos;s on the slip, top to bottom
        </legend>
        <ul className="divide-border border-border flex flex-col divide-y rounded-md border">
          {order.map((id, index) => (
            <li key={id} className="flex items-center gap-2 px-3 py-1.5">
              <label className="flex flex-1 items-center gap-2 text-sm">
                <input type="checkbox" name={`on:${id}`} defaultChecked={on.get(id) ?? true} />
                {SLIP_SECTION_NAMES[id]}
              </label>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={index === 0}
                aria-label={`Move ${SLIP_SECTION_NAMES[id]} up`}
                onClick={() => move(index, -1)}
              >
                <ArrowUp />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={index === order.length - 1}
                aria-label={`Move ${SLIP_SECTION_NAMES[id]} down`}
                onClick={() => move(index, 1)}
              >
                <ArrowDown />
              </Button>
            </li>
          ))}
        </ul>
        <p className="text-muted-foreground mt-1 text-xs">
          The barcode is what Scan &amp; pack reads to open an order.
        </p>
      </fieldset>

      <fieldset className="flex flex-col gap-2">
        <legend className="mb-2 text-sm font-semibold">Items</legend>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="show_sku" defaultChecked={layout.show_sku} />
          Show item codes (SKU), for whoever is picking
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="show_price" defaultChecked={layout.show_price} />
          Show prices
        </label>
      </fieldset>

      <div className="flex flex-col gap-1.5 sm:max-w-xs">
        <Label htmlFor="slip-text-size">Text size</Label>
        <Select id="slip-text-size" name="text_size" defaultValue={layout.text_size}>
          {SLIP_TEXT_SIZES.map((size) => (
            <option key={size} value={size}>
              {size[0].toUpperCase() + size.slice(1)}
            </option>
          ))}
        </Select>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="slip-message">Thank-you message</Label>
        <textarea
          id="slip-message"
          name="message"
          rows={3}
          maxLength={600}
          defaultValue={layout.message}
          placeholder="Thank you for supporting a small studio! Care: shake out, don't machine wash."
          className={`${textarea} font-read`}
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="slip-footer">Footer</Label>
        <Input
          id="slip-footer"
          name="footer"
          maxLength={120}
          defaultValue={layout.footer}
          placeholder="Questions? hello@yourstudio.com"
        />
      </div>
      <Result state={state} />
      <SubmitButton pendingText="Saving…" className="sm:w-fit">
        Save slip layout
      </SubmitButton>
    </form>
  );
}
