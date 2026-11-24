"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input, Label, Select } from "@/components/ui/input";
import { formatPrice } from "@/lib/shipping/easypost";
import { SOURCE_NAMES } from "@/lib/shipping/sources/types";
import { CarrierMark } from "../carrier-mark";
import { getCalcRates, type CalcState } from "../rates-actions";

type Box = { id: string; name: string; length: string; width: string; height: string };

/**
 * The rate calculator: a ZIP, a box and a weight, priced on every connected
 * postage account. Only for looking: there is no button here that buys.
 */
export function RateCalculator({
  slug,
  homeZip,
  boxes,
  connected,
}: {
  slug: string;
  /** The workspace's own ship-from ZIP, used when none is typed. */
  homeZip: string;
  boxes: Box[];
  connected: boolean;
}) {
  const [first] = boxes;
  const [form, setForm] = useState({
    fromZip: "",
    toZip: "",
    weightLb: "",
    weightOz: "",
    boxId: first?.id ?? "",
    length: first?.length ?? "",
    width: first?.width ?? "",
    height: first?.height ?? "",
    residential: true,
    signature: "none",
  });
  const [state, setState] = useState<CalcState>({});
  const [asking, startAsk] = useTransition();
  const set = (next: Partial<typeof form>) => setForm((before) => ({ ...before, ...next }));
  const size = (name: "length" | "width" | "height", label: string) => (
    <Input
      type="number"
      min="1"
      step="0.5"
      inputMode="decimal"
      aria-label={label}
      placeholder={label}
      className="w-20"
      value={form[name]}
      // A size typed in is no longer the saved box.
      onChange={(event) => set({ [name]: event.target.value, boxId: "" })}
    />
  );

  return (
    <Card className="max-w-[900px]">
      <CardHeader>
        <CardTitle>Rate calculator</CardTitle>
        <CardDescription>
          Price a parcel from one ZIP to another. These are what you&apos;d pay on each of your
          postage accounts. Nothing is bought, and nothing here is saved.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {!connected && (
          <p className="bg-note rounded-md px-3.5 py-2.5 text-sm">
            Connect EasyPost, your own UPS account or Redo to see prices here.{" "}
            <Link
              href={`/w/${slug}/connections`}
              className="font-semibold underline underline-offset-2"
            >
              Open Connections
            </Link>
          </p>
        )}
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            startAsk(async () => {
              setState(
                await getCalcRates(slug, form).catch(() => ({
                  error: "We couldn't reach the carriers just now. Try again.",
                })),
              );
            });
          }}
        >
          <div className="flex flex-wrap items-end gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="calc-from">From ZIP</Label>
              <Input
                id="calc-from"
                inputMode="numeric"
                maxLength={5}
                className="w-36"
                placeholder={homeZip || "Ship-from ZIP"}
                value={form.fromZip}
                onChange={(event) => set({ fromZip: event.target.value })}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="calc-to">To ZIP</Label>
              <Input
                id="calc-to"
                inputMode="numeric"
                maxLength={5}
                className="w-36"
                placeholder="e.g. 90210"
                autoFocus
                value={form.toZip}
                onChange={(event) => set({ toZip: event.target.value })}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="calc-lb">Weight</Label>
              <div className="flex gap-1.5">
                <Input
                  id="calc-lb"
                  type="number"
                  min="0"
                  step="1"
                  inputMode="decimal"
                  placeholder="lb"
                  aria-label="Pounds"
                  className="w-[90px]"
                  value={form.weightLb}
                  onChange={(event) => set({ weightLb: event.target.value })}
                />
                <Input
                  type="number"
                  min="0"
                  max="15.9"
                  step="0.1"
                  inputMode="decimal"
                  placeholder="oz"
                  aria-label="Ounces"
                  className="w-20"
                  value={form.weightOz}
                  onChange={(event) => set({ weightOz: event.target.value })}
                />
              </div>
            </div>
          </div>
          <div className="flex flex-wrap items-end gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="calc-box">Box</Label>
              <Select
                id="calc-box"
                value={form.boxId}
                onChange={(event) => {
                  const picked = boxes.find((box) => box.id === event.target.value);
                  set(
                    picked
                      ? {
                          boxId: picked.id,
                          length: picked.length,
                          width: picked.width,
                          height: picked.height,
                        }
                      : { boxId: "" },
                  );
                }}
              >
                <option value="">Custom size</option>
                {boxes.map((box) => (
                  <option key={box.id} value={box.id}>
                    {box.name} · {box.length}×{box.width}×{box.height}
                  </option>
                ))}
              </Select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label>Size (in)</Label>
              <div className="flex gap-1.5">
                {size("length", "L")}
                {size("width", "W")}
                {size("height", "H")}
              </div>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="calc-signature">Signature</Label>
              <Select
                id="calc-signature"
                value={form.signature}
                onChange={(event) => set({ signature: event.target.value })}
              >
                <option value="none">No signature</option>
                <option value="signature">Signature required</option>
                <option value="adult">Adult signature</option>
              </Select>
            </div>
            <label className="mb-2 flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={form.residential}
                onChange={(event) => set({ residential: event.target.checked })}
              />
              Residential
            </label>
          </div>
          <div>
            <Button type="submit" disabled={asking || !connected}>
              {asking ? "Getting rates…" : "Get rates"}
            </Button>
          </div>
        </form>

        <div aria-live="polite" className="flex flex-col gap-2 empty:hidden">
          {state.error && (
            <p
              role="alert"
              className="border-brick/25 bg-brick-soft text-brick rounded-lg border px-3 py-2 text-sm"
            >
              {state.error}
            </p>
          )}
          {state.rows && (
            <>
              <p className="text-muted-foreground text-xs tabular-nums">{state.summary}</p>
              <ul className="divide-border border-border divide-y rounded-[10px] border">
                {state.rows.map((row) => (
                  <li
                    key={`${row.source}:${row.carrier}:${row.service}`}
                    className="flex items-center gap-3 px-3.5 py-2.5"
                  >
                    <CarrierMark mark={row.mark} />
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-center gap-2 text-sm font-bold">
                        {row.service}
                        <span className="text-muted-foreground text-xs font-normal">
                          via {SOURCE_NAMES[row.source]}
                        </span>
                      </span>
                      <span className="text-muted-foreground flex flex-wrap items-center gap-1.5 text-xs">
                        {row.days || "Transit time varies"}
                        {row.cheapest && <Badge tone="good">Cheapest</Badge>}
                        {row.fastest && <Badge tone="open">Fastest</Badge>}
                      </span>
                      {(row.others.length > 0 || row.note) && (
                        <span className="text-muted-foreground block text-xs tabular-nums">
                          {row.others.length > 0 &&
                            `Also ${row.others
                              .map(
                                (other) =>
                                  `${SOURCE_NAMES[other.source]} ${formatPrice(other.price, row.currency)}`,
                              )
                              .join(" · ")}`}
                          {row.others.length > 0 && row.note ? " · " : ""}
                          {row.note}
                        </span>
                      )}
                    </span>
                    <span className="text-base font-extrabold tabular-nums">
                      {formatPrice(row.price, row.currency)}
                    </span>
                  </li>
                ))}
              </ul>
              <p className="text-muted-foreground text-xs">
                Prices for looking at. To buy a label, open the order it&apos;s for.
              </p>
            </>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
