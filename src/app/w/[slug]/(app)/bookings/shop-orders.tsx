"use client";

import { useActionState, useState, useTransition } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { FormMessage } from "@/components/ui/form-message";
import { Input, Label, Select } from "@/components/ui/input";
import { SubmitButton } from "@/components/ui/submit-button";
import { formatMoney } from "@/lib/dashboard/format";
import type { BookingsState } from "./actions";
import {
  findShopOrder,
  placeShopLine,
  setUndatedAside,
  type FindOrderState,
  type FoundShopOrder,
} from "./roster-actions";

function Result({ state }: { state: BookingsState }) {
  return (
    <>
      <FormMessage>{state.error}</FormMessage>
      <FormMessage kind="success">{state.message}</FormMessage>
    </>
  );
}

export type DateChoice = { id: string; label: string; left: number };

/** Put a waiting shop order onto one of the workshop's coming dates. */
export function PlaceOnDateForm({
  slug,
  line,
  dates,
  seats,
  hasEmail,
}: {
  slug: string;
  line: { id: string; provider: string; orderId: string; lineId: string };
  dates: DateChoice[];
  seats: number;
  hasEmail: boolean;
}) {
  const [state, action] = useActionState(
    placeShopLine.bind(null, slug, {
      provider: line.provider,
      orderId: line.orderId,
      lineId: line.lineId,
    }),
    {},
  );
  const [picked, setPicked] = useState("");
  const [aside, setAside] = useState<BookingsState>({});
  const [pending, start] = useTransition();
  const chosen = dates.find((d) => d.id === picked);
  if (state.message) return <FormMessage kind="success">{state.message}</FormMessage>;
  return (
    <form action={action} className="flex flex-col gap-2">
      {dates.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          This workshop has no coming dates yet. Add one, then come back here.
        </p>
      ) : (
        <>
          <Label htmlFor={`date-${line.id}`}>Put them on</Label>
          <Select
            id={`date-${line.id}`}
            name="session"
            value={picked}
            onChange={(e) => setPicked(e.target.value)}
          >
            <option value="" disabled>
              Pick a date…
            </option>
            {dates.map((d) => (
              <option key={d.id} value={d.id}>
                {d.label} · {d.left > 0 ? `${d.left} left` : "full"}
              </option>
            ))}
          </Select>
          {chosen && chosen.left < seats && (
            <p className="text-brick text-xs">
              That date doesn&apos;t have room for {seats === 1 ? "1 more" : `${seats} more`}.
              They&apos;ve paid, so they&apos;ll be added anyway and the date will show as over its
              limit.
            </p>
          )}
          {hasEmail ? (
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" name="tell" defaultChecked />
              Email them the details
            </label>
          ) : (
            <p className="text-muted-foreground text-xs">
              The order has no email address, so let them know yourself.
            </p>
          )}
        </>
      )}
      <Result state={state} />
      <FormMessage>{aside.error}</FormMessage>
      <div className="flex flex-wrap gap-2">
        {dates.length > 0 && (
          <SubmitButton variant="outline" size="sm" pendingText="Booking…">
            Book them in
          </SubmitButton>
        )}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={pending}
          onClick={() => start(async () => setAside(await setUndatedAside(slug, line.id, true)))}
        >
          Set aside
        </Button>
      </div>
    </form>
  );
}

export function BringBackButton({ slug, lineId }: { slug: string; lineId: string }) {
  const [state, setState] = useState<BookingsState>({});
  const [pending, start] = useTransition();
  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        disabled={pending}
        onClick={() => start(async () => setState(await setUndatedAside(slug, lineId, false)))}
      >
        Bring back
      </Button>
      <FormMessage>{state.error}</FormMessage>
    </>
  );
}

const STATE_WORDS: Record<FoundShopOrder["lines"][number]["state"], string> = {
  open: "",
  placed: "Already on a date",
  booked: "Already booked from the date they picked",
  refunded: "Refunded",
};

function FoundLine({
  slug,
  sessionId,
  order,
  line,
  currency,
}: {
  slug: string;
  sessionId: string;
  order: FoundShopOrder;
  line: FoundShopOrder["lines"][number];
  currency: string;
}) {
  const [state, action] = useActionState(
    placeShopLine.bind(null, slug, {
      provider: order.provider,
      orderId: order.order_id,
      lineId: line.line_id,
      sessionId,
    }),
    {},
  );
  const open = line.state === "open" && !order.cancelled;
  return (
    <li className="flex flex-col gap-2 py-3 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="font-read font-semibold">{line.title}</span>
        <Badge tone="open">{line.seats === 1 ? "1 place" : `${line.seats} places`}</Badge>
        {line.amount_cents > 0 && (
          <span className="text-muted-foreground text-sm">
            {formatMoney(line.amount_cents / 100, currency)}
          </span>
        )}
        {!open && line.state !== "open" && <Badge>{STATE_WORDS[line.state]}</Badge>}
      </div>
      {line.state === "booked" && (
        <p className="text-muted-foreground text-xs">
          To change their date, open that date&apos;s list and use “Move to another date”.
        </p>
      )}
      {state.message ? (
        <FormMessage kind="success">{state.message}</FormMessage>
      ) : (
        open && (
          <form action={action} className="flex flex-wrap items-center gap-3">
            {order.customer_email && (
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" name="tell" defaultChecked />
                Email them the details
              </label>
            )}
            <SubmitButton variant="outline" size="sm" pendingText="Adding…">
              Add to this date
            </SubmitButton>
            <FormMessage>{state.error}</FormMessage>
          </form>
        )
      )}
    </li>
  );
}

/** "Add a shop order by its number": look it up among stored orders, then add a line. */
export function AddShopOrderForm({ slug, sessionId }: { slug: string; sessionId: string }) {
  const [state, action] = useActionState<FindOrderState, FormData>(
    findShopOrder.bind(null, slug, sessionId),
    {},
  );
  const found = state.found;
  return (
    <div className="flex flex-col gap-4">
      <form action={action} className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="shop-order-number">Order number</Label>
          <Input
            id="shop-order-number"
            name="number"
            maxLength={40}
            placeholder="#1042"
            className="w-40"
            required
          />
        </div>
        <SubmitButton variant="outline" pendingText="Looking…">
          Find the order
        </SubmitButton>
      </form>
      <FormMessage>{state.error}</FormMessage>
      {found && (
        <div className="bg-panel flex flex-col gap-3 rounded-md p-4">
          <p className="text-sm">
            <span className="font-semibold">Order {found.name}</span>
            {" · "}
            <span className="font-read">
              {found.customer_name}
              {found.customer_email && ` · ${found.customer_email}`}
            </span>
          </p>
          {found.cancelled && (
            <p className="text-brick text-sm">
              This order was cancelled in your shop, so there&apos;s nothing to add.
            </p>
          )}
          {found.lines.length === 0 ? (
            <p className="text-muted-foreground text-sm">This order has no items.</p>
          ) : (
            <ul className="divide-border flex flex-col divide-y">
              {found.lines.map((line) => (
                <FoundLine
                  key={`${found.order_id}-${line.line_id}`}
                  slug={slug}
                  sessionId={sessionId}
                  order={found}
                  line={line}
                  currency={state.currency ?? "USD"}
                />
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
