import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/input";
import {
  ACTIVITY_TYPES,
  ACTIVITY_TYPE_LABELS,
  isFiltered,
  type BalanceFilters,
} from "@/lib/stock/balance/activity";

/**
 * The filters over the due dates and the activity. A plain form that sends
 * its boxes to the page's own address, so the whole state is in the URL and
 * it works without any script. Totals and cards are never narrowed.
 */
export function BalanceFilterBar({
  base,
  filters,
  suppliers,
}: {
  base: string;
  filters: BalanceFilters;
  suppliers: { id: string; name: string }[];
}) {
  return (
    <form
      action={base}
      method="get"
      role="search"
      aria-label="Narrow the bills and activity"
      className="grid grid-cols-2 items-end gap-3 md:flex md:flex-wrap print:hidden"
    >
      <div className="col-span-2 flex min-w-0 flex-col gap-1.5 md:w-64">
        <Label htmlFor="balance-q">Search</Label>
        <Input
          id="balance-q"
          name="q"
          type="search"
          maxLength={80}
          defaultValue={filters.q}
          placeholder="Invoice number or note"
        />
      </div>
      <div className="flex min-w-0 flex-col gap-1.5 md:w-48">
        <Label htmlFor="balance-supplier">Supplier</Label>
        <Select id="balance-supplier" name="supplier" defaultValue={filters.supplier ?? ""}>
          <option value="">All suppliers</option>
          {suppliers.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </Select>
      </div>
      <div className="flex min-w-0 flex-col gap-1.5 md:w-40">
        <Label htmlFor="balance-type">Activity type</Label>
        <Select id="balance-type" name="type" defaultValue={filters.type ?? ""}>
          <option value="">Everything</option>
          {ACTIVITY_TYPES.map((type) => (
            <option key={type} value={type}>
              {ACTIVITY_TYPE_LABELS[type]}
            </option>
          ))}
        </Select>
      </div>
      <div className="flex min-w-0 flex-col gap-1.5">
        <Label htmlFor="balance-from">Activity from</Label>
        <Input id="balance-from" name="from" type="date" defaultValue={filters.from ?? ""} />
      </div>
      <div className="flex min-w-0 flex-col gap-1.5">
        <Label htmlFor="balance-to">to</Label>
        <Input id="balance-to" name="to" type="date" defaultValue={filters.to ?? ""} />
      </div>
      <div className="col-span-2 flex items-center gap-3">
        <Button type="submit" variant="outline">
          Show
        </Button>
        {isFiltered(filters) && (
          <Link href={base} className="text-ochre-text text-sm font-semibold hover:underline">
            Clear
          </Link>
        )}
      </div>
    </form>
  );
}
