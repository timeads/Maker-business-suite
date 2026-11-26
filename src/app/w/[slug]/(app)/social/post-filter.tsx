import { Button } from "@/components/ui/button";
import { loadBrands } from "@/lib/brand/brands";
import { accountLabel } from "@/lib/social/accounts";
import type { createClient } from "@/lib/supabase/server";

type Supabase = Awaited<ReturnType<typeof createClient>>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Which brand and account a list of posts is narrowed to, from the address. */
export function postFilterOf(query: { brand?: string; account?: string }) {
  return {
    brand: UUID.test(query.brand ?? "") ? (query.brand as string) : null,
    account: UUID.test(query.account ?? "") ? (query.account as string) : null,
  };
}
export type PostFilter = ReturnType<typeof postFilterOf>;

/** The filter's part of an address ("&brand=…&account=…"), to keep it across links. */
export const filterQuery = (filter: PostFilter) =>
  `${filter.brand ? `&brand=${filter.brand}` : ""}${filter.account ? `&account=${filter.account}` : ""}`;

/** Narrows a posts query to the filter's brand and account. */
export function narrow<T>(query: T, filter: PostFilter): T {
  type Narrowable = {
    eq(column: string, value: string): Narrowable;
    contains(column: string, value: string[]): Narrowable;
  };
  let out = query as unknown as Narrowable;
  if (filter.brand) out = out.eq("brand_id", filter.brand);
  if (filter.account) out = out.contains("account_ids", [filter.account]);
  return out as unknown as T;
}

/**
 * A plain form (no script) that narrows a page of posts to one brand and/or
 * one account. Shown only where a workspace has more than one of either.
 */
export async function PostFilterBar({
  supabase,
  tenantId,
  action,
  filter,
  keep = {},
}: {
  supabase: Supabase;
  tenantId: string;
  action: string;
  filter: PostFilter;
  /** Other parts of the address to keep (the month). */
  keep?: Record<string, string>;
}) {
  const [brands, { data: rows }] = await Promise.all([
    loadBrands(supabase, tenantId),
    supabase
      .from("social_accounts")
      .select("id, network, name, handle, active")
      .eq("tenant_id", tenantId)
      .order("created_at"),
  ]);
  const accounts = (
    (rows ?? []) as {
      id: string;
      network: string;
      name: string | null;
      handle: string | null;
      active: boolean;
    }[]
  ).filter((a) => a.active || a.id === filter.account);
  if (brands.length < 2 && accounts.length < 3 && !filter.brand && !filter.account) return null;
  const select = "border-input bg-card h-8 rounded-sm border px-2 text-sm";
  return (
    <form method="get" action={action} className="flex flex-wrap items-end gap-2 text-sm">
      {Object.entries(keep).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      {brands.length > 1 && (
        <label className="flex flex-col gap-1">
          <span className="text-muted-foreground text-xs">Brand</span>
          <select name="brand" defaultValue={filter.brand ?? ""} className={select}>
            <option value="">Every brand</option>
            {brands.map((brand) => (
              <option key={brand.id} value={brand.id}>
                {brand.name}
              </option>
            ))}
          </select>
        </label>
      )}
      <label className="flex flex-col gap-1">
        <span className="text-muted-foreground text-xs">Account</span>
        <select name="account" defaultValue={filter.account ?? ""} className={select}>
          <option value="">Every account</option>
          {accounts.map((account) => (
            <option key={account.id} value={account.id}>
              {accountLabel(account)}
            </option>
          ))}
        </select>
      </label>
      <Button type="submit" variant="outline" size="sm">
        Show
      </Button>
    </form>
  );
}
