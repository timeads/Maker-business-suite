import type { Metadata } from "next";
import Link from "next/link";
import { Badge, type BadgeTone } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { PageHeader } from "@/components/ui/page-header";
import { PROBLEM_WORDS, listingIssues, worstLevel } from "@/lib/michaels/issues";
import { adoptionBlocked, michaelsPrice, michaelsQuantity } from "@/lib/michaels/mapping";
import { createClient } from "@/lib/supabase/server";
import { canManage } from "@/lib/tenants";
import { cn } from "@/lib/utils";
import { loadListings, loadMichaels, type ListingView } from "../data";
import { PairForm, UnpairButton } from "../forms";
import { michaelsAccess } from "../gate";
import { WatchingBanner } from "../watching";

export const metadata: Metadata = { title: "Michaels listings" };

const VIEWS = [
  { key: "issues", name: "Needs a look" },
  { key: "matched", name: "Matched" },
  { key: "all", name: "All" },
] as const;
type View = (typeof VIEWS)[number]["key"];

const RULE_WORDS = {
  hand: "Paired by hand",
  exact: "Same SKU",
  case: "Same SKU, capitals aside",
  barcode: "Same barcode",
} as const;

const STATUS_WORDS: Record<string, { label: string; tone: BadgeTone }> = {
  ACTIVE: { label: "On sale", tone: "good" },
  SOLD_OUT: { label: "Sold out", tone: "waiting" },
  DRAFT: { label: "Draft", tone: "closed" },
  PENDING_REVIEW: { label: "In review", tone: "waiting" },
  INACTIVE: { label: "Turned off", tone: "closed" },
  EXPIRED: { label: "Expired", tone: "closed" },
  ARCHIVED: { label: "Archived", tone: "closed" },
  SUSPENDED: { label: "Suspended", tone: "bad" },
  FORBIDDEN: { label: "Not allowed", tone: "bad" },
};

const SHOWN = 300;

export default async function MichaelsListingsPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ view?: string; q?: string }>;
}) {
  const { slug } = await params;
  const query = await searchParams;
  const access = await michaelsAccess(slug, `/w/${slug}/stock/michaels/listings`);
  if (!access.ok) return access.upsell;
  const { tenant, role, entitlements } = access;
  const manager = canManage(role) && entitlements.canWrite;
  const base = `/w/${tenant.slug}/stock/michaels/listings`;
  const supabase = await createClient();
  const [{ settings }, listings] = await Promise.all([
    loadMichaels(supabase, tenant),
    loadListings(supabase, tenant.id),
  ]);

  const now = new Date();
  const rows = listings.map((listing) => {
    const issues = listingIssues(
      {
        sellerSku: listing.seller_sku,
        michaelsSkuNumber: listing.michaels_sku_number,
        listingStatus: listing.listing_status,
        problem: listing.problem,
        problemDetail: listing.problem_detail,
        michaelsQty: listing.michaels_qty,
        michaelsPrice: listing.michaels_price,
        updatedAt: listing.michaels_updated_at ? new Date(listing.michaels_updated_at) : null,
        item: listing.item,
      },
      settings.units_held_back,
      now,
    );
    return { listing, issues, level: worstLevel(issues) };
  });
  const unmatched = rows.filter((row) => !row.listing.item).length;
  const needsLook = rows.filter((row) => row.level === "error" || row.level === "warn");
  const blocked = adoptionBlocked(rows.length, unmatched);
  const view: View = VIEWS.some((v) => v.key === query.view)
    ? (query.view as View)
    : needsLook.length > 0
      ? "issues"
      : "all";
  const q = (query.q ?? "").trim().toLowerCase().slice(0, 80);
  const inView =
    view === "issues" ? needsLook : view === "matched" ? rows.filter((r) => r.listing.item) : rows;
  const found = q
    ? inView.filter(({ listing }) =>
        [listing.seller_sku, listing.item_name, listing.item?.name, listing.item?.sku]
          .filter(Boolean)
          .some((text) => text!.toLowerCase().includes(q)),
      )
    : inView;
  const shown = found.slice(0, SHOWN);
  const counts: Record<View, number> = {
    issues: needsLook.length,
    matched: rows.length - unmatched,
    all: rows.length,
  };
  const href = (v: View) => `${base}?view=${v}${q ? `&q=${encodeURIComponent(q)}` : ""}`;

  return (
    <>
      <PageHeader
        title="Michaels listings"
        description="Each thing you sell on Michaels, and the item in your shop it is."
        back={{ href: `/w/${tenant.slug}/stock`, label: "Stock" }}
      />
      <WatchingBanner />

      {rows.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>No listings read yet</CardTitle>
            <CardDescription>
              Your Michaels listings appear here after the first look. Switch Michaels on in
              Settings, then give it a few minutes.
            </CardDescription>
          </CardHeader>
        </Card>
      ) : (
        <Card>
          <CardHeader>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <CardTitle>
                {rows.length - unmatched} of {rows.length} matched
              </CardTitle>
              <Badge tone={blocked ? "bad" : unmatched > 0 ? "waiting" : "good"}>
                {blocked
                  ? "Safety stop: more than one in ten unmatched"
                  : unmatched > 0
                    ? `${unmatched} unmatched`
                    : "All matched"}
              </Badge>
            </div>
            <CardDescription>
              {blocked
                ? "While more than one listing in ten has no item, nothing could ever be sent to Michaels. Pair them here, or fix the SKUs in your shop or in the Michaels seller center."
                : "A listing is matched by its seller SKU: the same SKU in your shop, then the same with capitals and outer spaces ignored. A pairing you type in here wins over both."}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <nav aria-label="Which listings" className="flex flex-wrap gap-2">
                {VIEWS.map((v) => (
                  <Button
                    key={v.key}
                    asChild
                    size="sm"
                    variant={v.key === view ? "dark" : "outline"}
                  >
                    <Link href={href(v.key)} aria-current={v.key === view ? "page" : undefined}>
                      {v.name} ({counts[v.key]})
                    </Link>
                  </Button>
                ))}
              </nav>
              <form action={base} className="flex items-center gap-2">
                <input type="hidden" name="view" value={view} />
                <Input
                  name="q"
                  defaultValue={q}
                  placeholder="Find a SKU or name"
                  aria-label="Find a SKU or name"
                  className="h-[30px] w-48 text-xs"
                />
                <Button type="submit" size="sm" variant="outline">
                  Find
                </Button>
              </form>
            </div>

            {shown.length === 0 ? (
              <p className="text-muted-foreground text-sm">
                {q ? "Nothing here matches that." : "Nothing here. That's good news."}
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[760px] text-left text-sm">
                  <thead className="text-muted-foreground text-xs">
                    <tr>
                      <th className="py-2 pr-3 font-semibold">On Michaels</th>
                      <th className="py-2 pr-3 font-semibold">In your shop</th>
                      <th className="py-2 pr-3 text-right font-semibold">Michaels has</th>
                      <th className="py-2 pr-3 text-right font-semibold">Would be</th>
                      <th className="py-2 font-semibold">Worth knowing</th>
                    </tr>
                  </thead>
                  <tbody className="divide-border divide-y align-top">
                    {shown.map(({ listing, issues }) => (
                      <ListingRow
                        key={listing.id}
                        listing={listing}
                        issues={issues.map((issue) => ({ level: issue.level, text: issue.text }))}
                        slug={tenant.slug}
                        manager={manager}
                        heldBack={settings.units_held_back}
                      />
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {found.length > shown.length && (
              <p className="text-muted-foreground text-xs">
                Showing the first {shown.length} of {found.length}. Use the box above to find one.
              </p>
            )}
          </CardContent>
        </Card>
      )}
    </>
  );
}

function ListingRow({
  listing,
  issues,
  slug,
  manager,
  heldBack,
}: {
  listing: ListingView;
  issues: { level: "error" | "warn" | "info"; text: string }[];
  slug: string;
  manager: boolean;
  heldBack: number;
}) {
  const status = STATUS_WORDS[(listing.listing_status ?? "").toUpperCase()] ?? {
    label: listing.listing_status ?? "Status unknown",
    tone: "closed" as BadgeTone,
  };
  const item = listing.item;
  const wouldQty = item?.tracked ? michaelsQuantity(item.on_hand, heldBack) : null;
  const wouldPrice = item ? michaelsPrice(item.price) : null;
  // Pairing by hand helps where the SKU simply isn't in the shop under that name.
  const canPair =
    manager &&
    !item &&
    listing.seller_sku !== null &&
    (listing.problem === "no_match" || listing.problem === "pairing_missing");
  return (
    <tr>
      <td className="py-2 pr-3">
        <div className="font-semibold">{listing.item_name ?? "Unnamed listing"}</div>
        <div className="text-muted-foreground font-mono text-xs break-all">
          {listing.seller_sku ?? `No seller SKU (Michaels no. ${listing.michaels_sku_number})`}
        </div>
        <Badge tone={status.tone} className="mt-1">
          {status.label}
        </Badge>
      </td>
      <td className="py-2 pr-3">
        {item ? (
          <>
            <div>{item.name}</div>
            <div className="text-muted-foreground font-mono text-xs break-all">{item.sku}</div>
            <div className="mt-1 flex flex-wrap items-center gap-2">
              <Badge tone={listing.matched_by === "hand" ? "open" : "good"}>
                {RULE_WORDS[listing.matched_by ?? "exact"]}
              </Badge>
            </div>
            {manager && listing.matched_by === "hand" && listing.seller_sku && (
              <div className="mt-1">
                <UnpairButton slug={slug} sellerSku={listing.seller_sku} />
              </div>
            )}
          </>
        ) : (
          <>
            <Badge tone="bad">{PROBLEM_WORDS[listing.problem ?? "no_match"]}</Badge>
            {canPair && (
              <div className="mt-2">
                <PairForm slug={slug} sellerSku={listing.seller_sku!} />
              </div>
            )}
          </>
        )}
      </td>
      <td className="py-2 pr-3 text-right tabular-nums">
        <div>{listing.michaels_qty ?? "–"}</div>
        <div className="text-muted-foreground">
          {listing.michaels_price ? `$${listing.michaels_price}` : "–"}
        </div>
      </td>
      <td className="py-2 pr-3 text-right tabular-nums">
        <div>{wouldQty ?? "–"}</div>
        <div className="text-muted-foreground">{wouldPrice ? `$${wouldPrice}` : "–"}</div>
      </td>
      <td className="py-2">
        {issues.length === 0 ? (
          <span className="text-muted-foreground text-xs">In step</span>
        ) : (
          <ul className="flex flex-col gap-1 text-xs">
            {issues.map((issue) => (
              <li
                key={issue.text}
                className={cn(
                  issue.level === "error" && "text-brick",
                  issue.level === "warn" && "text-ochre-text",
                  issue.level === "info" && "text-muted-foreground",
                )}
              >
                {issue.text}
              </li>
            ))}
          </ul>
        )}
      </td>
    </tr>
  );
}
