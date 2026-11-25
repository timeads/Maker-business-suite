"use client";

import Link from "next/link";
import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { FormMessage } from "@/components/ui/form-message";
import { Input, Label, Select } from "@/components/ui/input";
import { SubmitButton } from "@/components/ui/submit-button";
import { setShopProduct } from "./actions";

/**
 * Sell a workshop through the business's own Shopify shop: pick the product,
 * then set up the product page (Settings → Bookings → Shop product page). The shop takes the payment and the
 * order arrives here as a booking.
 */
export function ShopProductCard({
  slug,
  serviceId,
  productId,
  variantId,
  products,
}: {
  slug: string;
  serviceId: string;
  productId: string | null;
  variantId: string | null;
  /** The shop's products, as "product:variant" values. */
  products: { value: string; label: string }[];
}) {
  const [state, action] = useActionState(setShopProduct.bind(null, slug, serviceId), {});
  const current = productId ? `${productId}:${variantId ?? ""}` : "";
  const known = products.some((p) => p.value === current);
  return (
    <Card>
      <CardHeader>
        <CardTitle>Sell this in your Shopify shop</CardTitle>
        <CardDescription>
          Shoppers pick a date on the product page and pay at your shop&rsquo;s checkout. The order
          comes back here as a booking, with the confirmation and reminder emails as usual. Your
          shop sets the price, so no payment setup is needed here.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        <form action={action} className="flex flex-col gap-3">
          {products.length > 0 ? (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="shop-pick">The product that sells it</Label>
              <Select id="shop-pick" name="pick" defaultValue={known ? current : ""}>
                <option value="">Choose a product…</option>
                {products.map((p) => (
                  <option key={p.value} value={p.value}>
                    {p.label}
                  </option>
                ))}
              </Select>
            </div>
          ) : (
            <p className="text-muted-foreground text-sm">
              Connect your shop on the Connections page and its products will be listed here. Until
              then you can type the numbers in.
            </p>
          )}
          <details open={products.length === 0 || (Boolean(productId) && !known)}>
            <summary className="text-text-2 cursor-pointer text-sm">Or type the numbers in</summary>
            <div className="mt-2 grid gap-3 sm:grid-cols-2">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="shop-product">Product number</Label>
                <Input
                  id="shop-product"
                  name="product_id"
                  inputMode="numeric"
                  defaultValue={known ? "" : (productId ?? "")}
                  placeholder="8123456789012"
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="shop-variant">Variant number (optional)</Label>
                <Input
                  id="shop-variant"
                  name="variant_id"
                  inputMode="numeric"
                  defaultValue={known ? "" : (variantId ?? "")}
                  placeholder="45123456789012"
                />
              </div>
            </div>
            <p className="text-muted-foreground mt-1 text-xs">
              Both are in the address bar when you open the product, then its variant, in your
              Shopify admin.
            </p>
          </details>
          <FormMessage>{state.error}</FormMessage>
          {state.message && <FormMessage kind="success">{state.message}</FormMessage>}
          <div className="flex gap-2">
            <SubmitButton variant="outline" size="sm" pendingText="Saving…">
              Save
            </SubmitButton>
            {productId && (
              <Button type="submit" name="intent" value="remove" variant="ghost" size="sm">
                Stop selling it in the shop
              </Button>
            )}
          </div>
        </form>

        {productId && (
          <div className="flex flex-col gap-2">
            <p className="text-sm font-semibold">Add the date picker to your product page</p>
            <p className="text-muted-foreground text-sm">
              Tag the product in your shop, then paste two short snippets into your theme: the
              picker for the product page, and a check on the cart so nobody pays for a workshop
              with no date. One paste covers every workshop.
            </p>
            <Button asChild variant="outline" size="sm" className="w-fit">
              <Link href={`/w/${slug}/settings/bookings/shop-page`}>
                Get the snippets and set it up
              </Link>
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
