import type { Metadata } from "next";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { SectionHeading } from "@/components/settings/section-heading";
import { BOOKINGS_MODULE } from "@/lib/bookings/config";
import {
  SHOP_TAGS_KEY,
  TAG_REASONS,
  canTagInShopify,
  parseShopTags,
  tagFor,
  type TagReason,
} from "@/lib/bookings/shop-tags";
import { createClient } from "@/lib/supabase/server";
import { canManage } from "@/lib/tenants";
import { startConnection } from "../../../connections/actions";
import { bookingsAccess } from "../../../bookings/gate";
import { ConnectTagsForm, ShopTagsForm } from "../../../bookings/shop-tags-form";

export const metadata: Metadata = { title: "Order tags" };

const STATUS: Record<string, { tone: "good" | "bad" | "waiting" | "closed"; words: string }> = {
  done: { tone: "good", words: "Tagged" },
  pending: { tone: "waiting", words: "Waiting" },
  sending: { tone: "waiting", words: "On its way" },
  not_allowed: { tone: "bad", words: "Not allowed" },
  failed: { tone: "bad", words: "Didn't go" },
};

/**
 * Settings → Bookings → Order tags: shop orders that need a person (booked
 * over the limit, no date, a date we couldn't book) get a tag in the shop,
 * as the earlier booking app did. Only where the shop has said we may change
 * its orders.
 */
export default async function ShopTagsSettings({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const access = await bookingsAccess(slug, `/w/${slug}/settings/bookings/shop-tags`);
  if (!access.ok) return access.upsell;
  const { tenant, role, entitlements } = access;
  const canEdit = canManage(role) && entitlements.canWrite;

  const supabase = await createClient();
  const [{ data: config }, { data: shop }, { data: recent }] = await Promise.all([
    supabase
      .from("configs")
      .select("body")
      .eq("tenant_id", tenant.id)
      .eq("module", BOOKINGS_MODULE)
      .eq("key", SHOP_TAGS_KEY)
      .maybeSingle(),
    // Name the columns: members can't read the whole row.
    supabase
      .from("connections")
      .select("status, scopes, external_account_id, metadata")
      .eq("tenant_id", tenant.id)
      .eq("provider", "shopify")
      .maybeSingle(),
    supabase
      .from("shop_order_tags")
      .select("id, shop_order_name, reason, tag, status, error, created_at")
      .eq("tenant_id", tenant.id)
      .order("created_at", { ascending: false })
      .limit(20),
  ]);
  const settings = parseShopTags(config?.body);
  const connected = shop?.status === "active";
  const watchOnly = Boolean((shop?.metadata as { watch_only?: boolean } | null)?.watch_only);
  const allowed = connected && canTagInShopify(shop?.scopes);
  const rows = (recent ?? []) as {
    id: string;
    shop_order_name: string;
    reason: TagReason;
    tag: string;
    status: string;
    error: string | null;
  }[];

  return (
    <>
      <SectionHeading
        back={{ href: `/w/${tenant.slug}/bookings`, label: "Bookings" }}
        title="Order tags"
        description="When a shop order needs you, it gets a tag in your shop, so you can find it there too."
      />
      <Card>
        <CardHeader>
          <CardTitle>Your shop&apos;s permission</CardTitle>
          <CardDescription>
            Tags are only ever added. Nothing else on the order is changed, and a tag already there
            stays.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 text-sm">
          {!shop || shop.status === "disconnected" ? (
            <p>
              Your shop isn&apos;t connected.{" "}
              <Link href={`/w/${tenant.slug}/connections`} className="underline">
                Connect it under Connections
              </Link>
              .
            </p>
          ) : allowed ? (
            <p className="flex flex-wrap items-center gap-2">
              <Badge tone="good">Allowed</Badge>
              Your shop lets us add tags to its orders.
            </p>
          ) : (
            <>
              <p className="flex flex-wrap items-center gap-2">
                <Badge tone="waiting">Not allowed yet</Badge>
                {!connected
                  ? "Your shop needs connecting again."
                  : watchOnly
                    ? "Your shop is connected to watch only, so nothing in it is ever changed from here, tags included."
                    : "Your shop hasn't given permission to change orders, so no tags are added."}
              </p>
              <p className="text-muted-foreground">
                To allow it, connect your shop again with order tags. Your shop will ask you to
                approve changing orders.
                {watchOnly &&
                  " This ends watch only: you'll also be able to mark orders sent or add stock when you ask."}
              </p>
              {canEdit && shop.external_account_id && (
                <ConnectTagsForm
                  action={startConnection.bind(null, tenant.slug, "shopify")}
                  shop={shop.external_account_id}
                />
              )}
            </>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>The tags</CardTitle>
          <CardDescription>
            Each order gets each tag once, at the moment it comes in. Messages and Bookings → Needs
            a date still tell you either way.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {canEdit ? (
            <ShopTagsForm slug={tenant.slug} settings={settings} />
          ) : (
            <ul className="flex flex-col gap-1 text-sm">
              {TAG_REASONS.map((reason) => (
                <li key={reason}>
                  <span className="font-read">{tagFor(settings, reason)}</span>
                </li>
              ))}
              <li className="text-muted-foreground">An owner or admin can change these.</li>
            </ul>
          )}
        </CardContent>
      </Card>
      {rows.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Lately</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="divide-border flex flex-col divide-y text-sm">
              {rows.map((row) => {
                const state = STATUS[row.status] ?? STATUS.failed;
                return (
                  <li key={row.id} className="flex flex-wrap items-center gap-2 py-2">
                    <span className="font-read">{row.shop_order_name || "An order"}</span>
                    <span className="font-read text-text-2">{row.tag}</span>
                    <Badge tone={state.tone}>{state.words}</Badge>
                    {row.error && row.status !== "done" && (
                      <span className="text-muted-foreground text-xs">{row.error}</span>
                    )}
                  </li>
                );
              })}
            </ul>
          </CardContent>
        </Card>
      )}
    </>
  );
}
