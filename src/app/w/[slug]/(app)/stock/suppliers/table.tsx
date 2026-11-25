"use client";

import Link from "next/link";
import { useEffect, useRef, useState, useTransition } from "react";
import { Check, ChevronRight } from "lucide-react";
import { Badge, type BadgeTone } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { FormMessage } from "@/components/ui/form-message";
import { Input, Select } from "@/components/ui/input";
import { offersUse, type SupplierTab } from "@/lib/stock/suppliers/table";
import { cn } from "@/lib/utils";
import {
  adoptLeadTime,
  saveSupplierField,
  setSupplierArchived,
  type StockState,
  type SupplierField,
} from "../actions";
import { SupplierForm } from "../forms";

export type SupplierLine = {
  id: string;
  name: string;
  /** Null follows the workspace's usual figure. */
  leadDays: number | null;
  observed: { days: number; sampleSize: number } | null;
  moq: number;
  moqAppliesTo: "order" | "sku";
  contact: string;
  /** Every address, the one orders go to first, with commas between. */
  emails: string;
  orders: number;
  /** Shut now, or shutting soon: the one thing worth a mark in the list. */
  status: { tone: BadgeTone; words: string } | null;
};

// A box reads as plain text until it is pointed at or typed in.
const quiet =
  "h-8 border-transparent bg-transparent px-1.5 hover:border-input focus-visible:bg-card";
const APPLIES = { order: "Per order", sku: "Each SKU" } as const;

/** A tick that shows for a moment once a box has saved. */
function useSavedTick() {
  const [saved, setSaved] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);
  return {
    saved,
    tick: (on: boolean) => {
      if (timer.current) clearTimeout(timer.current);
      setSaved(on);
      if (on) timer.current = setTimeout(() => setSaved(false), 2500);
    },
  };
}

function Outcome({ saved, error, right }: { saved: boolean; error: string | null; right: string }) {
  return (
    <>
      {saved && (
        <span
          role="status"
          className={cn("text-mint-ink pointer-events-none absolute top-2 flex", right)}
        >
          <Check className="size-4" aria-hidden />
          <span className="sr-only">Saved</span>
        </span>
      )}
      {error && (
        <span role="alert" className="text-brick block px-1.5 pt-0.5 text-xs whitespace-normal">
          {error}
        </span>
      )}
    </>
  );
}

/**
 * One box of one supplier. It saves when it is left (or Enter is pressed),
 * shows a tick when that worked and says why when it didn't; the page then
 * reads everything again without moving.
 */
function Box({
  slug,
  id,
  field,
  value,
  label,
  placeholder,
  numeric = false,
  className,
}: {
  slug: string;
  id: string;
  field: SupplierField;
  /** What's saved now, as it sits in the box. */
  value: string;
  label: string;
  placeholder?: string;
  numeric?: boolean;
  className?: string;
}) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const { saved, tick } = useSavedTick();
  const [note, setNote] = useState<string | null>(null);
  return (
    <span className="relative block">
      <Input
        // A fresh box whenever the saved value changes (after "Use", say).
        key={value}
        defaultValue={value}
        placeholder={placeholder}
        aria-label={label}
        aria-invalid={error ? true : undefined}
        // The column decides the width, not the box.
        size={1}
        title={field === "emails" && value ? value : undefined}
        inputMode={numeric ? "numeric" : field === "emails" ? "email" : "text"}
        autoComplete="off"
        maxLength={field === "emails" ? 1300 : numeric ? 7 : 120}
        className={cn(quiet, numeric && "tabular-nums", pending && "opacity-60", className)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            event.currentTarget.blur();
          } else if (event.key === "Escape") {
            event.currentTarget.value = value;
            event.currentTarget.blur();
          }
        }}
        onBlur={(event) => {
          const typed = event.currentTarget.value.trim();
          if (typed === value) {
            event.currentTarget.value = value;
            setError(null);
            return;
          }
          tick(false);
          const box = event.currentTarget;
          setNote(null);
          start(async () => {
            const result = await saveSupplierField(slug, id, field, typed);
            setError(result.error ?? null);
            tick(!result.error);
            // A typed 0 isn't kept as a lead time: the box goes back to empty, and says why.
            if (result.emptied) {
              box.value = "";
              setNote(result.message ?? null);
            }
          });
        }}
      />
      <Outcome saved={saved} error={error} right="right-1.5" />
      {note && (
        <span
          role="status"
          className="text-muted-foreground block w-40 px-1.5 pt-0.5 text-xs whitespace-normal"
        >
          {note}
        </span>
      )}
    </span>
  );
}

function AppliesPick({ slug, row }: { slug: string; row: SupplierLine }) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const { saved, tick } = useSavedTick();
  return (
    <span className="relative block">
      <Select
        key={row.moqAppliesTo}
        defaultValue={row.moqAppliesTo}
        aria-label={`How ${row.name}'s smallest order is counted`}
        disabled={pending}
        className={cn(quiet, "w-32 py-0", pending && "opacity-60")}
        onChange={(event) => {
          const picked = event.currentTarget.value;
          tick(false);
          start(async () => {
            const result = await saveSupplierField(slug, row.id, "moq_applies_to", picked);
            setError(result.error ?? null);
            tick(!result.error);
          });
        }}
      >
        <option value="order">{APPLIES.order}</option>
        <option value="sku">{APPLIES.sku}</option>
      </Select>
      <Outcome saved={saved} error={error} right="right-7" />
    </span>
  );
}

const th = "px-3 py-2.5 font-semibold whitespace-nowrap";
const td = "px-3 py-1.5 align-top";
const plain = "block px-1.5 py-1.5";
// The name stays put while the rest of a wide table slides under it.
const pinned = "sticky left-0 z-[1] border-r border-border sm:border-r-0";

export function SuppliersTable({
  slug,
  rows,
  tab,
  usualLeadDays,
  canEdit,
}: {
  slug: string;
  rows: SupplierLine[];
  tab: SupplierTab;
  usualLeadDays: number;
  canEdit: boolean;
}) {
  const [busy, start] = useTransition();
  const [note, setNote] = useState<StockState>({});
  const base = `/w/${slug}/stock`;
  const press = (work: () => Promise<StockState>) => start(async () => setNote(await work()));

  return (
    <div className="flex flex-col gap-2">
      <div aria-live="polite">
        <FormMessage>{note.error}</FormMessage>
        <FormMessage kind="success">{note.message}</FormMessage>
      </div>
      {/* `relative` keeps the screen-reader-only words inside the sliding box. */}
      <div className="border-border bg-card relative overflow-x-auto rounded-xl border">
        <table className="w-full min-w-[58rem] text-left text-sm">
          <thead className="text-muted-foreground bg-panel text-xs">
            <tr>
              <th className={cn(th, pinned, "bg-panel pl-4")}>Name</th>
              <th className={th} title="Days from placing an order to having it on the shelf">
                Lead time (d)
              </th>
              <th
                className={th}
                title="How long their orders have really taken to arrive, with how many orders that's worked out from"
              >
                Observed (d)
              </th>
              <th className={th} title="The smallest order they'll take">
                MOQ
              </th>
              <th
                className={th}
                title="Whether the smallest order is counted across the whole order or for each item"
              >
                MOQ applies
              </th>
              <th className={th}>Contact</th>
              <th
                className={th}
                title="The supplier's email. Purchase orders are sent here. Add more than one with commas"
              >
                Email
              </th>
              <th className={th} title="Orders sent to them (drafts and cancelled ones aside)">
                POs
              </th>
              {canEdit && (
                <th className={cn(th, "pr-4")}>
                  <span className="sr-only">Archive</span>
                </th>
              )}
            </tr>
          </thead>
          <tbody className="divide-border divide-y">
            {rows.map((row) => (
              <tr key={row.id} className="group">
                <td className={cn(td, pinned, "bg-card w-[22%] min-w-48 pl-2.5")}>
                  <span className="flex items-start gap-1">
                    {canEdit ? (
                      <span className="min-w-0 flex-1">
                        <Box
                          slug={slug}
                          id={row.id}
                          field="name"
                          value={row.name}
                          label="Supplier's name"
                          className="font-semibold"
                        />
                      </span>
                    ) : (
                      <Link
                        href={`${base}/suppliers/${row.id}`}
                        className={cn(plain, "font-semibold underline-offset-2 hover:underline")}
                      >
                        {row.name}
                      </Link>
                    )}
                    {canEdit && (
                      <Link
                        href={`${base}/suppliers/${row.id}`}
                        title={`More about ${row.name}: closures, cover, days to pay, notes`}
                        className="text-muted-foreground hover:bg-hover hover:text-foreground mt-1 flex size-6 shrink-0 items-center justify-center rounded-sm"
                      >
                        <ChevronRight className="size-4" aria-hidden />
                        <span className="sr-only">More about {row.name}</span>
                      </Link>
                    )}
                  </span>
                  {row.status && (
                    // Never wider than the column: the words shorten, and the whole of them is a hover away.
                    <span
                      className="hidden w-0 min-w-full pb-1 pl-1.5 sm:block"
                      title={row.status.words}
                    >
                      <Badge tone={row.status.tone} className="max-w-full">
                        <span className="min-w-0 truncate">{row.status.words}</span>
                      </Badge>
                    </span>
                  )}
                </td>
                <td className={cn(td, "w-28")}>
                  {canEdit ? (
                    <Box
                      slug={slug}
                      id={row.id}
                      field="lead"
                      numeric
                      value={row.leadDays === null ? "" : String(row.leadDays)}
                      placeholder={`${usualLeadDays} usual`}
                      label={`Days for ${row.name}'s orders to arrive. Empty uses your usual ${usualLeadDays}`}
                      className="w-24"
                    />
                  ) : row.leadDays === null ? (
                    <span className={cn(plain, "text-muted-foreground tabular-nums")}>
                      {usualLeadDays} usual
                    </span>
                  ) : (
                    <span className={cn(plain, "tabular-nums")}>{row.leadDays}</span>
                  )}
                </td>
                <td className={cn(td, "w-32")}>
                  {row.observed ? (
                    <span className={cn(plain, "flex items-center gap-1.5 whitespace-nowrap")}>
                      <span className="tabular-nums">{row.observed.days}</span>
                      <span
                        className="text-muted-foreground text-xs tabular-nums"
                        title={`Worked out from ${row.observed.sampleSize} order${row.observed.sampleSize === 1 ? "" : "s"} that arrived`}
                      >
                        ({row.observed.sampleSize})
                      </span>
                      {canEdit && offersUse(row.observed.days, row.leadDays) && (
                        <button
                          type="button"
                          disabled={busy}
                          title={`Set the lead time to the ${row.observed.days} days their orders really took`}
                          aria-label={`Use ${row.observed.days} days as ${row.name}'s lead time`}
                          onClick={() => press(() => adoptLeadTime(slug, row.id))}
                          className="bg-teal-soft text-teal-soft-ink rounded-sm px-1.5 py-0.5 text-[11px] font-semibold hover:opacity-80 disabled:opacity-50"
                        >
                          Use
                        </button>
                      )}
                    </span>
                  ) : (
                    <span className={cn(plain, "text-muted-foreground")}>
                      <span aria-hidden>–</span>
                      <span className="sr-only">No arrived orders to go by yet</span>
                    </span>
                  )}
                </td>
                <td className={cn(td, "w-24")}>
                  {canEdit ? (
                    <Box
                      slug={slug}
                      id={row.id}
                      field="moq"
                      numeric
                      value={String(row.moq)}
                      placeholder="1"
                      label={`${row.name}'s smallest order`}
                      className="w-20"
                    />
                  ) : (
                    <span className={cn(plain, "tabular-nums")}>{row.moq}</span>
                  )}
                </td>
                <td className={cn(td, "w-36")}>
                  {canEdit ? (
                    <AppliesPick slug={slug} row={row} />
                  ) : (
                    <span className={plain}>{APPLIES[row.moqAppliesTo]}</span>
                  )}
                </td>
                <td className={cn(td, "w-[13%] min-w-32")}>
                  {canEdit ? (
                    <Box
                      slug={slug}
                      id={row.id}
                      field="contact"
                      value={row.contact}
                      label={`Contact: the person you deal with at ${row.name}`}
                    />
                  ) : (
                    <span className={cn(plain, "font-read")}>{row.contact}</span>
                  )}
                </td>
                <td className={cn(td, "min-w-52")}>
                  {canEdit ? (
                    <Box
                      slug={slug}
                      id={row.id}
                      field="emails"
                      value={row.emails}
                      label={`${row.name}'s email addresses, with commas between`}
                    />
                  ) : (
                    <span className={cn(plain, "font-read break-words")}>{row.emails}</span>
                  )}
                </td>
                <td className={cn(td, "w-14")}>
                  {row.orders > 0 ? (
                    <Link
                      href={`${base}/orders?show=all&supplier=${row.id}`}
                      title={`See ${row.name}'s orders`}
                      className={cn(
                        plain,
                        "text-ochre-text font-semibold tabular-nums underline-offset-2 hover:underline",
                      )}
                    >
                      {row.orders}
                    </Link>
                  ) : (
                    <span className={cn(plain, "text-muted-foreground tabular-nums")}>0</span>
                  )}
                </td>
                {canEdit && (
                  <td className={cn(td, "w-24 pr-3 text-right whitespace-nowrap")}>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={busy}
                      title={
                        tab === "archived"
                          ? "Back with your suppliers; we'll plan for their items again"
                          : "For a supplier you don't order from any more. We stop suggesting orders for their items; nothing is deleted"
                      }
                      onClick={() =>
                        press(() => setSupplierArchived(slug, row.id, tab !== "archived"))
                      }
                    >
                      {tab === "archived" ? "Bring back" : "Archive"}
                      <span className="sr-only"> {row.name}</span>
                    </Button>
                  </td>
                )}
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={canEdit ? 9 : 8} className="text-muted-foreground px-4 py-8 text-sm">
                  {tab === "archived"
                    ? "Nobody here. A supplier you archive is kept on this tab, with their orders and account."
                    : canEdit
                      ? "No suppliers yet. Press “Add supplier” to add your first, or bring them in from a spreadsheet below."
                      : "No suppliers yet. An owner or admin can add the first."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/**
 * The one filled button. It opens a short form in the browser's own dialog
 * (so Escape and where the cursor goes are the browser's doing); the new
 * supplier then lands in the table, where everything can still be changed.
 */
export function AddSupplier({ slug, usualLeadDays }: { slug: string; usualLeadDays: number }) {
  const [open, setOpen] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const el = dialog.current;
    if (open && el && !el.open) el.showModal();
  }, [open]);
  return (
    <>
      <Button type="button" onClick={() => setOpen(true)}>
        Add supplier
      </Button>
      {open && (
        <dialog
          ref={dialog}
          aria-labelledby="add-supplier-title"
          className="fixed inset-0 m-0 grid h-full max-h-none w-full max-w-none place-items-center overflow-y-auto bg-transparent p-4 backdrop:bg-black/50"
          onClose={() => setOpen(false)}
          onPointerDown={(event) => {
            // A press on the dialog itself, not on the box in it, is a press on the backdrop.
            if (event.target === event.currentTarget) setOpen(false);
          }}
        >
          <div className="bg-card text-foreground border-border flex w-full max-w-lg flex-col gap-3 rounded-lg border p-5 shadow-lg">
            <div>
              <h2 id="add-supplier-title" className="text-base font-semibold">
                Add a supplier
              </h2>
              <p className="text-muted-foreground font-read text-sm">
                Only the name is needed now. The rest can be filled in later, right in the table.
              </p>
            </div>
            <SupplierForm
              slug={slug}
              usualLeadDays={usualLeadDays}
              onCancel={() => setOpen(false)}
            />
          </div>
        </dialog>
      )}
    </>
  );
}
