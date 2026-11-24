"use client";

import { useActionState } from "react";
import { Badge } from "@/components/ui/badge";
import { FormMessage } from "@/components/ui/form-message";
import { Input, Label } from "@/components/ui/input";
import { SubmitButton } from "@/components/ui/submit-button";
import {
  lookNow,
  pairListing,
  saveMichaelsSettings,
  unpairListing,
  type MichaelsState,
} from "./actions";

/** "Look now": the one filled button on the Overview. */
export function LookNowButton({ slug, busy }: { slug: string; busy: boolean }) {
  const [state, action] = useActionState<MichaelsState, FormData>(lookNow.bind(null, slug), {});
  return (
    <form action={action} className="flex flex-col items-end gap-2">
      <SubmitButton pendingText="Asking…" disabled={busy}>
        {busy ? "Looking…" : "Look now"}
      </SubmitButton>
      <FormMessage>{state.error}</FormMessage>
      <FormMessage kind="success">{state.message}</FormMessage>
    </form>
  );
}

/** Pair one Michaels listing with an item, by typing the item's SKU. */
export function PairForm({ slug, sellerSku }: { slug: string; sellerSku: string }) {
  const [state, action] = useActionState<MichaelsState, FormData>(
    pairListing.bind(null, slug, sellerSku),
    {},
  );
  const id = `pair-${sellerSku.replace(/[^A-Za-z0-9_-]/g, "_")}`;
  return (
    <form action={action} className="flex flex-col gap-1.5">
      <div className="flex items-end gap-2">
        <div className="flex min-w-0 flex-col gap-1">
          <Label htmlFor={id} className="text-xs">
            Its SKU in your shop
          </Label>
          <Input
            id={id}
            name="shop_sku"
            placeholder="Type the SKU"
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            className="h-[30px] w-40 text-xs"
            required
          />
        </div>
        <SubmitButton variant="outline" size="sm" pendingText="Pairing…">
          Pair
        </SubmitButton>
      </div>
      <FormMessage>{state.error}</FormMessage>
      <FormMessage kind="success">{state.message}</FormMessage>
    </form>
  );
}

export function UnpairButton({ slug, sellerSku }: { slug: string; sellerSku: string }) {
  const [state, action] = useActionState<MichaelsState, FormData>(
    unpairListing.bind(null, slug, sellerSku),
    {},
  );
  return (
    <form action={action} className="flex flex-col gap-1.5">
      <SubmitButton variant="ghost" size="sm" pendingText="Taking off…" className="w-fit">
        Take pairing off
      </SubmitButton>
      <FormMessage>{state.error}</FormMessage>
    </form>
  );
}

export function MichaelsSettingsForm({
  slug,
  settings,
}: {
  slug: string;
  settings: {
    enabled: boolean;
    units_held_back: number;
    jobs: { stock: boolean; prices: boolean; orders: boolean };
  };
}) {
  const [state, action] = useActionState<MichaelsState, FormData>(
    saveMichaelsSettings.bind(null, slug),
    {},
  );
  const check = (name: string, on: boolean, title: string, help: string) => (
    <label className="flex items-start gap-2 text-sm">
      <input type="checkbox" name={name} defaultChecked={on} className="mt-1" />
      <span>
        {title}
        <span className="text-muted-foreground block text-xs">{help}</span>
      </span>
    </label>
  );
  return (
    <form action={action} className="flex flex-col gap-5">
      {check(
        "enabled",
        settings.enabled,
        "Look at Michaels",
        "On, we read your Michaels account about once an hour. Off, nothing is read at all.",
      )}

      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-sm font-semibold">How it runs</legend>
        <label className="flex items-start gap-2 text-sm">
          <input type="radio" defaultChecked className="mt-1" />
          <span>
            Watch only
            <span className="text-muted-foreground block text-xs">
              Work out what would be sent and show it. Nothing is sent to Michaels or to your shop.
            </span>
          </span>
        </label>
        <label className="text-muted-foreground flex items-start gap-2 text-sm">
          <input type="radio" disabled className="mt-1" aria-describedby="live-later" />
          <span>
            Go live <Badge tone="closed">Coming later</Badge>
            <span id="live-later" className="block text-xs">
              Send stock and prices to Michaels and bring orders into your shop, from a cut-over
              time you choose. This isn&apos;t built yet, so it can&apos;t be picked.
            </span>
          </span>
        </label>
      </fieldset>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="michaels-held">Units held back</Label>
        <Input
          id="michaels-held"
          name="units_held_back"
          type="number"
          min={0}
          max={1000}
          defaultValue={settings.units_held_back}
          className="w-28"
          required
        />
        <p className="text-muted-foreground text-xs">
          Kept back from Michaels for every item, so your shop and Michaels can&apos;t both sell the
          last one. With 1 held back, an item with 5 in your shop would show 4 on Michaels.
        </p>
      </div>

      <fieldset className="flex flex-col gap-3">
        <legend className="mb-1 text-sm font-semibold">What each look works out</legend>
        {check(
          "job_stock",
          settings.jobs.stock,
          "Stock",
          "The count each listing would be given: your shop's count, less the units held back.",
        )}
        {check(
          "job_prices",
          settings.jobs.prices,
          "Prices",
          "The price each listing would be given: exactly your shop's price.",
        )}
        {check(
          "job_orders",
          settings.jobs.orders,
          "Orders",
          "Recent Michaels orders, and what bringing each into your shop would make.",
        )}
      </fieldset>

      <FormMessage>{state.error}</FormMessage>
      <FormMessage kind="success">{state.message}</FormMessage>
      <SubmitButton pendingText="Saving…" className="sm:w-fit">
        Save
      </SubmitButton>
    </form>
  );
}
