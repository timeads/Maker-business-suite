"use client";

import Link from "next/link";
import { useActionState } from "react";
import { Badge } from "@/components/ui/badge";
import { FormMessage } from "@/components/ui/form-message";
import { Input } from "@/components/ui/input";
import { SubmitButton } from "@/components/ui/submit-button";
import type { Brand } from "@/lib/brand/brands";
import { addBrand, changeBrand, renameBrand, type BrandListState } from "./actions";

/**
 * The workspace's brands: which is the main one, which are put away, and
 * the four things an owner or admin can do to each. Nothing is ever deleted
 * here: a brand's posts and accounts keep pointing at it.
 */
export function BrandList({
  slug,
  brands,
  current,
  canEdit,
  limit,
  accounts,
}: {
  slug: string;
  brands: Brand[];
  /** The brand whose kit is open below. */
  current: string | null;
  canEdit: boolean;
  limit: number;
  /** How many social accounts post as each brand. */
  accounts: Record<string, number>;
}) {
  const [added, add] = useActionState<BrandListState, FormData>(addBrand.bind(null, slug), {});
  const [changed, change] = useActionState<BrandListState, FormData>(
    changeBrand.bind(null, slug),
    {},
  );
  const many = brands.length > 1;
  return (
    <section aria-labelledby="brands-heading" className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <h3 id="brands-heading" className="text-base font-semibold">
          {many ? "Your brands" : "More than one brand?"}
        </h3>
        <p className="text-muted-foreground max-w-prose text-sm">
          {many
            ? "Each brand has its own colours, voice and social accounts. Posts, slides and emails are drawn in the brand you pick for them; the main brand is the one picked unless you choose another."
            : "If you run another shop or site, give it a brand of its own: its own colours and voice, and its own Instagram and Facebook accounts."}
        </p>
      </div>
      {many && (
        <ul className="bg-card divide-border divide-y rounded-lg border">
          {brands.map((brand) => (
            <BrandRow
              key={brand.id}
              slug={slug}
              brand={brand}
              open={brand.id === current}
              canEdit={canEdit}
              accounts={accounts[brand.id] ?? 0}
              change={change}
            />
          ))}
        </ul>
      )}
      <FormMessage>{changed.error}</FormMessage>
      <FormMessage kind="success">{changed.message}</FormMessage>
      {canEdit &&
        (brands.length < limit ? (
          <form action={add} className="flex flex-wrap items-end gap-2">
            <label className="flex min-w-56 flex-1 flex-col gap-1 text-sm font-medium">
              Add a brand
              <Input
                name="name"
                required
                maxLength={80}
                placeholder="Its name, as customers see it"
              />
            </label>
            <SubmitButton variant="outline" pendingText="Adding…">
              Add brand
            </SubmitButton>
          </form>
        ) : (
          <p className="text-muted-foreground text-sm">
            Your plan keeps up to {limit} brands, counting ones put away.
          </p>
        ))}
      <FormMessage>{added.error}</FormMessage>
    </section>
  );
}

function BrandRow({
  slug,
  brand,
  open,
  canEdit,
  accounts,
  change,
}: {
  slug: string;
  brand: Brand;
  open: boolean;
  canEdit: boolean;
  accounts: number;
  change: (formData: FormData) => void;
}) {
  const [renamed, rename] = useActionState<BrandListState, FormData>(
    renameBrand.bind(null, slug),
    {},
  );
  return (
    <li className="flex flex-col gap-2 px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-sm font-semibold">{brand.name}</span>
        {brand.is_default && <Badge tone="open">Main brand</Badge>}
        {brand.archived_at && <Badge tone="closed">Put away</Badge>}
        <span className="text-muted-foreground text-xs">
          {accounts === 0 ? "No accounts" : accounts === 1 ? "1 account" : `${accounts} accounts`}
        </span>
        {open ? (
          <span className="text-muted-foreground text-xs">Open below</span>
        ) : (
          <Link
            href={`/w/${slug}/settings/brand?brand=${brand.id}`}
            className="text-ochre-text text-sm hover:underline"
          >
            {canEdit ? "Edit kit" : "See kit"}
          </Link>
        )}
      </div>
      {canEdit && (
        <div className="flex flex-wrap items-end gap-2">
          <form action={rename} className="flex flex-wrap items-end gap-2">
            <input type="hidden" name="brand_id" value={brand.id} />
            <label className="sr-only" htmlFor={`rename-${brand.id}`}>
              New name for {brand.name}
            </label>
            <Input
              id={`rename-${brand.id}`}
              name="name"
              defaultValue={brand.name}
              maxLength={80}
              className="h-8 w-48"
            />
            <SubmitButton size="sm" variant="ghost" pendingText="Renaming…">
              Rename
            </SubmitButton>
          </form>
          {!brand.is_default && !brand.archived_at && (
            <form action={change}>
              <input type="hidden" name="brand_id" value={brand.id} />
              <input type="hidden" name="what" value="default" />
              <SubmitButton size="sm" variant="ghost">
                Make main brand
              </SubmitButton>
            </form>
          )}
          {!brand.is_default && (
            <form action={change}>
              <input type="hidden" name="brand_id" value={brand.id} />
              <input type="hidden" name="what" value={brand.archived_at ? "restore" : "archive"} />
              <SubmitButton size="sm" variant="ghost">
                {brand.archived_at ? "Bring back" : "Put away"}
              </SubmitButton>
            </form>
          )}
        </div>
      )}
      <FormMessage>{renamed.error}</FormMessage>
      <FormMessage kind="success">{renamed.message}</FormMessage>
    </li>
  );
}
