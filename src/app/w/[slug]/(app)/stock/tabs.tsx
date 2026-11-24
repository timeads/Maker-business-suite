import { cache } from "react";
import { SectionTabs } from "@/components/ui/section-tabs";
import { createClient } from "@/lib/supabase/server";

/** Has this workspace connected a Michaels seller account? Read as the member, once a request. */
const hasMichaels = cache(async (tenantId: string): Promise<boolean> => {
  const supabase = await createClient();
  const { data } = await supabase
    .from("connections")
    .select("status")
    .eq("tenant_id", tenantId)
    .eq("provider", "michaels")
    .maybeSingle();
  return data?.status === "active" || data?.status === "needs_reconnect";
});

/**
 * `manager` adds the tabs only owners and admins can use. With `tenantId`, a
 * workspace that has connected Michaels Marketplace gets a tab for it; nobody
 * else sees one.
 */
export async function StockTabs({
  slug,
  manager = false,
  tenantId,
}: {
  slug: string;
  manager?: boolean;
  tenantId?: string;
}) {
  const base = `/w/${slug}/stock`;
  const michaels = tenantId ? await hasMichaels(tenantId) : false;
  return (
    <SectionTabs
      label="Stock"
      tabs={[
        { href: base, name: "To order", exact: true },
        { href: `${base}/items`, name: "Everything" },
        { href: `${base}/orders`, name: "Orders" },
        { href: `${base}/suppliers`, name: "Suppliers" },
        ...(manager
          ? [
              { href: `${base}/balances`, name: "Balances" },
              { href: `${base}/spend`, name: "Spend" },
            ]
          : []),
        ...(michaels ? [{ href: `${base}/michaels`, name: "Michaels" }] : []),
        { href: `${base}/settings`, name: "Settings" },
      ]}
    />
  );
}
