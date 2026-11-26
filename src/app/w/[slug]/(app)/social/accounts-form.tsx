"use client";

import { useActionState } from "react";
import { Badge } from "@/components/ui/badge";
import { FormMessage } from "@/components/ui/form-message";
import { SubmitButton } from "@/components/ui/submit-button";
import { NETWORK_LABELS, accountName, type AccountRow } from "@/lib/social/accounts";
import { saveSocialAccounts, type AccountsState } from "./accounts-actions";

/**
 * Each Page Facebook shared, with the Instagram account linked to it: tick
 * the ones to use and pick the brand each posts and answers as. Accounts left
 * as they were are left alone.
 */
export function AccountsForm({
  slug,
  pages,
  brands,
  canEdit,
}: {
  slug: string;
  pages: { pageId: string; accounts: AccountRow[] }[];
  brands: { id: string; name: string; archived: boolean }[];
  canEdit: boolean;
}) {
  const [state, action] = useActionState<AccountsState, FormData>(
    saveSocialAccounts.bind(null, slug),
    {},
  );
  const many = brands.filter((brand) => !brand.archived).length > 1;
  return (
    <form action={action} className="flex flex-col gap-4">
      <fieldset disabled={!canEdit} className="flex flex-col gap-3">
        {pages.map(({ pageId, accounts }) => (
          <section key={pageId} className="bg-card flex flex-col gap-1 rounded-lg border p-4">
            <h3 className="text-sm font-semibold">{accounts[0]?.name ?? "A Facebook Page"}</h3>
            <ul className="divide-border flex flex-col divide-y">
              {accounts.map((account) => (
                <li key={account.id} className="flex flex-wrap items-center gap-3 py-2">
                  <input type="hidden" name={`seen:${account.id}`} value="1" />
                  <label className="flex min-w-56 flex-1 items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      name={`active:${account.id}`}
                      value="1"
                      defaultChecked={account.active}
                      disabled={!account.offered}
                    />
                    <span>
                      {NETWORK_LABELS[account.network] ?? account.network}:{" "}
                      <span className="font-semibold">{accountName(account)}</span>
                    </span>
                  </label>
                  {!account.offered ? (
                    <Badge tone="closed">Not shared any more</Badge>
                  ) : account.active ? (
                    <Badge tone="good">In use</Badge>
                  ) : (
                    <Badge tone="waiting">Not used</Badge>
                  )}
                  {many && (
                    <label className="flex items-center gap-2 text-sm">
                      <span className="text-muted-foreground">Brand</span>
                      <select
                        name={`brand:${account.id}`}
                        defaultValue={account.brand_id}
                        className="border-input bg-card h-8 rounded-sm border px-2 text-sm"
                      >
                        {brands
                          .filter((brand) => !brand.archived || brand.id === account.brand_id)
                          .map((brand) => (
                            <option key={brand.id} value={brand.id}>
                              {brand.name}
                            </option>
                          ))}
                      </select>
                    </label>
                  )}
                </li>
              ))}
            </ul>
          </section>
        ))}
      </fieldset>
      <FormMessage>{state.error}</FormMessage>
      <FormMessage kind="success">{state.message}</FormMessage>
      {canEdit && (
        <SubmitButton className="w-fit" pendingText="Saving…">
          Save accounts
        </SubmitButton>
      )}
    </form>
  );
}
