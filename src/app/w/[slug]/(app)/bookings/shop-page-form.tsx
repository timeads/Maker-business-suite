"use client";

import { useActionState, useState } from "react";
import { Button } from "@/components/ui/button";
import { FormMessage } from "@/components/ui/form-message";
import { Input, Label } from "@/components/ui/input";
import { SubmitButton } from "@/components/ui/submit-button";
import type { ShopPage } from "@/lib/bookings/shop-page";
import type { Upcoming } from "@/lib/bookings/upcoming";
import { saveShopPage, saveUpcoming } from "./actions";

/** What a business can change about the date picker on its shop's product pages. */
export function ShopPageForm({ slug, settings }: { slug: string; settings: ShopPage }) {
  const [state, action] = useActionState(saveShopPage.bind(null, slug), {});
  return (
    <form action={action} className="flex flex-col gap-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="shop-tag">Tag on your workshop products</Label>
          <Input
            id="shop-tag"
            name="product_tag"
            maxLength={40}
            defaultValue={settings.product_tag}
            required
          />
          <p className="text-muted-foreground text-xs">
            The picker and the cart check only act on products with this tag in your shop. Type it
            exactly as it is there.
          </p>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="shop-cutoff">Stop taking bookings this many hours before</Label>
          <Input
            id="shop-cutoff"
            name="cutoff_hours"
            type="number"
            min={0}
            max={336}
            defaultValue={settings.cutoff_hours}
            className="w-28"
            required
          />
          <p className="text-muted-foreground text-xs">
            Closer dates still show, marked “Closed”. 0 lets people book right up to the start.
          </p>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="shop-contact-url">Your contact page</Label>
          <Input
            id="shop-contact-url"
            name="contact_url"
            type="url"
            maxLength={300}
            defaultValue={settings.contact_url}
            placeholder="https://yourshop.com/pages/contact"
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="shop-contact-email">Or an email address</Label>
          <Input
            id="shop-contact-email"
            name="contact_email"
            type="email"
            maxLength={200}
            defaultValue={settings.contact_email}
            placeholder="hello@yourshop.com"
          />
        </div>
      </div>
      <p className="text-muted-foreground -mt-2 text-xs">
        If the dates can&apos;t be shown, shoppers see a short message with a “Get in touch” link
        that goes here. The buy button stays hidden, so nobody pays for a workshop with no date.
      </p>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="shop-fallback">What that message says (optional)</Label>
        <Input
          id="shop-fallback"
          name="fallback_message"
          maxLength={200}
          defaultValue={settings.fallback_message}
          placeholder="We couldn't show the dates for this workshop just now."
        />
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="shop-accent">Button colour</Label>
          <Input
            id="shop-accent"
            name="accent"
            maxLength={7}
            defaultValue={settings.accent}
            placeholder="#edc2ff"
            className="w-32"
            required
          />
        </div>
        <details>
          <summary className="text-text-2 cursor-pointer text-sm">
            My theme&apos;s buy button isn&apos;t hidden
          </summary>
          <div className="mt-2 flex flex-col gap-1.5">
            <Label htmlFor="shop-hide">What to hide on a workshop&apos;s page</Label>
            <Input
              id="shop-hide"
              name="hide_selector"
              maxLength={200}
              defaultValue={settings.hide_selector}
              placeholder=".product-form__buttons"
            />
            <p className="text-muted-foreground text-xs">
              A CSS selector for your theme&apos;s buy buttons. Leave empty for the usual rule,
              which suits most themes.
            </p>
          </div>
        </details>
      </div>
      <FormMessage>{state.error}</FormMessage>
      <FormMessage kind="success">{state.message}</FormMessage>
      <SubmitButton pendingText="Saving…" className="sm:w-fit">
        Save
      </SubmitButton>
    </form>
  );
}

/** What a business can change about the "Upcoming classes" list on its workshops page. */
export function UpcomingForm({ slug, settings }: { slug: string; settings: Upcoming }) {
  const [state, action] = useActionState(saveUpcoming.bind(null, slug), {});
  return (
    <form action={action} className="flex flex-col gap-4">
      <label className="flex items-center gap-2 text-sm font-semibold">
        <input type="checkbox" name="on" defaultChecked={settings.on} />
        Show the list on my shop
      </label>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="upcoming-title">Heading</Label>
          <Input
            id="upcoming-title"
            name="title"
            maxLength={80}
            defaultValue={settings.title}
            placeholder="Upcoming classes"
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="upcoming-button">Button words</Label>
          <Input
            id="upcoming-button"
            name="button_words"
            maxLength={40}
            defaultValue={settings.button_words}
            placeholder="Book a place"
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="upcoming-max">How many dates to show at most</Label>
          <Input
            id="upcoming-max"
            name="max_dates"
            type="number"
            min={1}
            max={50}
            defaultValue={settings.max_dates}
            className="w-28"
            required
          />
        </div>
        <label className="flex items-center gap-2 self-end text-sm">
          <input type="checkbox" name="show_seats_left" defaultChecked={settings.show_seats_left} />
          Say how many places are left
        </label>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="upcoming-empty">When nothing is open</Label>
        <Input
          id="upcoming-empty"
          name="empty_message"
          maxLength={200}
          defaultValue={settings.empty_message}
        />
      </div>
      <FormMessage>{state.error}</FormMessage>
      <FormMessage kind="success">{state.message}</FormMessage>
      <SubmitButton variant="dark" pendingText="Saving…" className="sm:w-fit">
        Save the list
      </SubmitButton>
    </form>
  );
}

/** A snippet to paste into the shop's theme, with a copy button. */
export function Snippet({ code, label }: { code: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex flex-col gap-2">
      <pre
        className="bg-sunken max-h-64 overflow-auto rounded-sm p-3 text-xs"
        tabIndex={0}
        aria-label={label}
      >
        {code}
      </pre>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="w-fit"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(code);
            setCopied(true);
          } catch {
            setCopied(false);
          }
        }}
      >
        {copied ? "Copied" : `Copy ${label}`}
      </Button>
    </div>
  );
}
