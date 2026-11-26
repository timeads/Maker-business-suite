"use client";

import { useActionState } from "react";
import { FormMessage } from "@/components/ui/form-message";
import { Input, Label } from "@/components/ui/input";
import { SubmitButton } from "@/components/ui/submit-button";
import { REASON_WORDS, STANDARD_TAGS, TAG_REASONS, type ShopTags } from "@/lib/bookings/shop-tags";
import { saveShopTags } from "./actions";

type State = { error?: string; message?: string };

/** Whether orders that need a person are tagged in the shop, and with which words. */
export function ShopTagsForm({ slug, settings }: { slug: string; settings: ShopTags }) {
  const [state, action] = useActionState(saveShopTags.bind(null, slug), {});
  return (
    <form action={action} className="flex flex-col gap-4">
      <label className="flex items-center gap-2 text-sm font-semibold">
        <input type="checkbox" name="on" defaultChecked={settings.on} />
        Tag orders in my shop when they need me
      </label>
      {TAG_REASONS.map((reason) => (
        <div key={reason} className="flex flex-col gap-1.5">
          <Label htmlFor={`tag-${reason}`}>{REASON_WORDS[reason]}</Label>
          <Input
            id={`tag-${reason}`}
            name={reason}
            defaultValue={settings.tags[reason]}
            placeholder={STANDARD_TAGS[reason]}
            maxLength={40}
            className="sm:w-72"
          />
        </div>
      ))}
      <p className="text-muted-foreground text-xs">
        Leave a box empty to use the word shown in it. A changed word is used for orders from now
        on; tags already on orders stay as they are.
      </p>
      <FormMessage>{state.error}</FormMessage>
      <FormMessage kind="success">{state.message}</FormMessage>
      <SubmitButton pendingText="Saving…" className="sm:w-fit">
        Save
      </SubmitButton>
    </form>
  );
}

/** Sends the person to their shop to connect again, allowing order tags. */
export function ConnectTagsForm({
  action,
  shop,
}: {
  action: (prev: State, formData: FormData) => Promise<State>;
  /** The store already connected, e.g. my-store.myshopify.com. */
  shop: string;
}) {
  const [state, formAction] = useActionState(action, {});
  return (
    <form action={formAction} className="flex flex-col gap-2">
      <input type="hidden" name="shop" value={shop} />
      <input type="hidden" name="access" value="full" />
      <input type="hidden" name="order_tags" value="yes" />
      <input type="hidden" name="return_to" value="bookings-tags" />
      <SubmitButton variant="outline" pendingText="Opening your shop…" className="w-fit">
        Connect my shop again, allowing order tags
      </SubmitButton>
      <FormMessage>{state.error}</FormMessage>
    </form>
  );
}
