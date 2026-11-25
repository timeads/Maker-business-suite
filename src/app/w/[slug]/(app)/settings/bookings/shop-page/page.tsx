import type { Metadata } from "next";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { SectionHeading } from "@/components/settings/section-heading";
import { BOOKINGS_MODULE } from "@/lib/bookings/config";
import {
  SHOP_PAGE_KEY,
  cartGuardSnippet,
  pageSnippet,
  parseShopPage,
} from "@/lib/bookings/shop-page";
import { getSiteUrl } from "@/lib/site-url";
import { createClient } from "@/lib/supabase/server";
import { canManage } from "@/lib/tenants";
import { bookingsAccess } from "../../../bookings/gate";
import { ShopPageForm, Snippet } from "../../../bookings/shop-page-form";

export const metadata: Metadata = { title: "Shop product page" };

/**
 * Settings → Bookings → Shop product page: the date picker a business puts
 * on its shop's product pages, and the two snippets that go into its theme.
 */
export default async function ShopPageSettings({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const access = await bookingsAccess(slug, `/w/${slug}/settings/bookings/shop-page`);
  if (!access.ok) return access.upsell;
  const { tenant, role, entitlements } = access;

  const supabase = await createClient();
  const [{ data }, site] = await Promise.all([
    supabase
      .from("configs")
      .select("body")
      .eq("tenant_id", tenant.id)
      .eq("module", BOOKINGS_MODULE)
      .eq("key", SHOP_PAGE_KEY)
      .maybeSingle(),
    getSiteUrl(),
  ]);
  const settings = parseShopPage(data?.body);
  const canEdit = canManage(role) && entitlements.canWrite;
  const tag = settings.product_tag;

  return (
    <>
      <SectionHeading
        back={{ href: `/w/${tenant.slug}/bookings`, label: "Bookings" }}
        title="Shop product page"
        description="For workshops you sell through your own shop: the date picker on the product page, and a check on the cart so nobody pays for a workshop with no date."
      />
      <Card>
        <CardHeader>
          <CardTitle>How the picker behaves</CardTitle>
          <CardDescription>
            Times are shown on your workspace&apos;s clock ({tenant.timezone}). The cut-off, your
            contact details and the message take effect as soon as you save. If you change the tag,
            the colour or what to hide, paste the snippets below into your theme again.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {canEdit ? (
            <ShopPageForm slug={tenant.slug} settings={settings} />
          ) : (
            <p className="text-muted-foreground text-sm">
              An owner or admin can change these settings.
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>1. The date picker, on the product page</CardTitle>
          <CardDescription>
            One paste covers every workshop. It only shows on products tagged “{tag}”.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <ol className="text-muted-foreground list-decimal pl-5 text-sm">
            <li>
              In your shop, give each workshop product the tag “{tag}”, and turn “Track quantity”
              off for it: the places here are the limit.
            </li>
            <li>In Shopify, open Online Store → Themes → Customize, and go to the product page.</li>
            <li>
              Inside the product information section, add a “Custom liquid” block where the buy
              button is, and paste this in. If you pasted an earlier version, replace it.
            </li>
            <li>
              Open a workshop&apos;s page in your shop. You should see “Choose your date” and no
              “Add to cart”. If the theme&apos;s button still shows for a moment, use “My
              theme&apos;s buy button isn&apos;t hidden” above.
            </li>
          </ol>
          <Snippet code={pageSnippet(settings, { slug: tenant.slug, site })} label="the picker" />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>2. The cart check, once for the whole shop</CardTitle>
          <CardDescription>
            Some roads into the cart skip the picker: “Buy again” in customer accounts, quick-add
            buttons, saved carts. This catches a workshop that arrives with no date, holds checkout
            back and sends the shopper to pick one. On every other page it adds nothing at all.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <ol className="text-muted-foreground list-decimal pl-5 text-sm">
            <li>In Shopify, open Online Store → Themes → ⋯ → Edit code.</li>
            <li>
              Open <code>layout/theme.liquid</code> and paste this just above the line that says{" "}
              <code>&lt;/body&gt;</code>. Save.
            </li>
            <li>
              To try it: use “Buy again” on a past workshop order, then open the cart. You should
              see “needs a date” and no checkout button.
            </li>
          </ol>
          <Snippet code={cartGuardSnippet(settings)} label="the cart check" />
          <p className="text-muted-foreground text-xs">
            If one slips through anyway, the order isn&apos;t lost: it shows up under Bookings →
            Needs a date and you&apos;re told in Messages.
          </p>
        </CardContent>
      </Card>
    </>
  );
}
