"use client";

import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { ArrowDown, ArrowUp, Printer } from "lucide-react";
import { Button } from "@/components/ui/button";
import { FormMessage } from "@/components/ui/form-message";
import { Input, Label, Select } from "@/components/ui/input";
import {
  SLIP_SECTION_NAMES,
  SLIP_TEXT_SIZES,
  slipSections,
  type ShippingSettings,
  type SlipLayout,
} from "@/lib/shipping/config";
import { SLIP_CSS } from "@/lib/shipping/slip-css";
import { zebraClient } from "@/lib/shipping/zebra/client";
import { slipsGoToZebra } from "@/lib/shipping/zebra/settings";
import { buildSlipData, type SlipOrder } from "@/lib/shipping/zebra/slip";
import { usePrintSettings } from "@/lib/shipping/zebra/use-print-settings";
import { cn } from "@/lib/utils";
import { saveSlipLayout } from "./actions";
import { SlipSheet } from "./slip-sheet";
import { slipsForZebra } from "./slip-zebra";

/** A made-up order, so the preview shows every section. Nobody's real name or address. */
const SAMPLE: SlipOrder = {
  name: "#1042",
  placed_at: "2026-11-18T15:00:00Z",
  recipient: "Sam Shopper",
  company: null,
  address1: "12 Mill Lane",
  address2: "Apt 3",
  city: "Hudson",
  region: "NY",
  postal_code: "12534",
  country_code: "US",
  phone: null,
  shipping_method: "Standard shipping",
  pickup: false,
  note: "It's a gift, no receipt please.",
  items: [
    {
      line_id: "1",
      title: "Wool yarn cone",
      variant: "Royal",
      sku: "YARN-ROYAL",
      barcode: "0012345678905",
      price: 14,
      qty: 2,
      left: 2,
    },
    {
      line_id: "2",
      title: "Tufting cloth",
      variant: "2 yards",
      sku: "CLOTH-2",
      barcode: "0012345678912",
      price: 22,
      qty: 1,
      left: 1,
    },
  ],
};

const textarea =
  "border-input bg-card placeholder:text-muted-foreground focus-visible:border-ochre focus-visible:ring-ochre/25 w-full rounded-sm border px-[11px] py-2 text-sm outline-none focus-visible:ring-2";

function Segments<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: readonly (readonly [T, string])[];
  onChange: (next: T) => void;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-sm font-semibold">{label}</span>
      <span
        role="group"
        aria-label={label}
        className="border-input inline-flex w-fit overflow-hidden rounded-sm border text-xs font-semibold"
      >
        {options.map(([option, text]) => (
          <button
            key={option}
            type="button"
            aria-pressed={value === option}
            onClick={() => onChange(option)}
            className={cn(
              "h-[30px] px-3",
              value === option ? "bg-teal text-on-teal" : "bg-card hover:bg-hover",
            )}
          >
            {text}
          </button>
        ))}
      </span>
    </div>
  );
}

/**
 * Settings → Packing slip: what is on the slip and in what order, with the
 * slip itself beside it, redrawn as each thing changes. The preview is the
 * same sheet that prints, on paper and on a Zebra.
 */
export function SlipDesigner({
  slug,
  layout: saved,
  settings,
  workspaceName,
  timeZone,
  currency,
  logoUrl,
}: {
  slug: string;
  layout: SlipLayout;
  settings: ShippingSettings;
  workspaceName: string;
  timeZone: string;
  currency: string;
  /** The workspace's logo in our own storage; null when no asset is tagged `logo`. */
  logoUrl: string | null;
}) {
  const [layout, setLayout] = useState<SlipLayout>({ ...saved, sections: slipSections(saved) });
  const [dirty, setDirty] = useState(false);
  const [note, setNote] = useState<{ kind: "error" | "success"; text: string } | null>(null);
  const [saving, startSave] = useTransition();
  const [printing, startPrint] = useTransition();
  const [print, savePrint] = usePrintSettings();
  const size = print.slipPaper;
  const set = (next: Partial<SlipLayout>) => {
    setLayout((before) => ({ ...before, ...next }));
    setDirty(true);
    setNote(null);
  };
  const move = (index: number, by: -1 | 1) => {
    const next = [...layout.sections];
    const to = index + by;
    if (to < 0 || to >= next.length) return;
    [next[index], next[to]] = [next[to], next[index]];
    set({ sections: next });
  };
  const slip = useMemo(
    () =>
      buildSlipData({
        order: { ...SAMPLE, country_code: settings.ship_from_country },
        settings,
        layout,
        workspaceName,
        timeZone,
        currency,
        boxNames: ["Medium box"],
      }),
    [layout, settings, workspaceName, timeZone, currency],
  );
  const tick = (
    name:
      | "show_logo"
      | "show_return_address"
      | "show_sku"
      | "show_barcode"
      | "show_photo"
      | "show_price",
    text: string,
  ) => (
    <label className="flex items-center gap-2 text-sm">
      <input
        type="checkbox"
        checked={layout[name]}
        onChange={(event) => set({ [name]: event.target.checked })}
      />
      {text}
    </label>
  );

  return (
    <div className="grid gap-8 xl:grid-cols-[minmax(0,26rem)_minmax(0,1fr)]">
      <div className="flex min-w-0 flex-col gap-5">
        <fieldset className="flex flex-col gap-3">
          <legend className="mb-2 text-sm font-semibold">At the top</legend>
          {tick("show_logo", "Show your logo")}
          <p className="text-muted-foreground -mt-2 text-xs">
            {logoUrl
              ? "Your logo is the picture tagged “logo” in Assets. A plain dark logo on white prints best: thermal printers have no grey."
              : "No picture in Assets is tagged “logo” yet, so your name prints instead."}{" "}
            <Link
              href={`/w/${slug}/social/assets`}
              className="text-ochre-text font-medium underline-offset-2 hover:underline"
            >
              Open Assets
            </Link>
          </p>
          <div className="flex flex-wrap gap-x-6 gap-y-3">
            <Segments
              label="Logo size"
              value={layout.logo_size}
              options={[
                ["small", "Small"],
                ["medium", "Medium"],
                ["large", "Large"],
              ]}
              onChange={(logo_size) => set({ logo_size })}
            />
            <Segments
              label="Header"
              value={layout.align}
              options={[
                ["left", "Logo left"],
                ["center", "Centered"],
              ]}
              onChange={(align) => set({ align })}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="slip-store-name">Store name</Label>
            <Input
              id="slip-store-name"
              maxLength={60}
              value={layout.store_name}
              placeholder={settings.ship_from.name || workspaceName}
              onChange={(event) => set({ store_name: event.target.value })}
            />
          </div>
          <div className="flex flex-col gap-1.5 sm:max-w-xs">
            <Label htmlFor="slip-name-rule">Write the name out</Label>
            <Select
              id="slip-name-rule"
              value={layout.show_store_name}
              onChange={(event) =>
                set({ show_store_name: event.target.value as SlipLayout["show_store_name"] })
              }
            >
              <option value="without_logo">Only when no logo prints</option>
              <option value="always">Always</option>
              <option value="never">Never</option>
            </Select>
          </div>
          {tick("show_return_address", "Show your ship-from address")}
        </fieldset>

        <fieldset className="flex flex-col gap-1">
          <legend className="mb-2 text-sm font-semibold">
            What&apos;s on the slip, top to bottom
          </legend>
          <ul className="divide-border border-border flex flex-col divide-y rounded-md border">
            {layout.sections.map((section, index) => {
              const name = SLIP_SECTION_NAMES[section.id];
              return (
                <li key={section.id} className="flex items-center gap-2 px-3 py-1.5">
                  <label
                    className={cn(
                      "flex flex-1 items-center gap-2 text-sm",
                      !section.on && "text-muted-foreground",
                    )}
                  >
                    <input
                      type="checkbox"
                      checked={section.on}
                      onChange={(event) =>
                        set({
                          sections: layout.sections.map((each) =>
                            each.id === section.id ? { ...each, on: event.target.checked } : each,
                          ),
                        })
                      }
                    />
                    {name}
                    {section.id === "items" && (
                      <span className="text-muted-foreground text-xs">
                        anything below sits at the bottom
                      </span>
                    )}
                  </label>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={index === 0}
                    aria-label={`Move ${name} up`}
                    onClick={() => move(index, -1)}
                  >
                    <ArrowUp />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={index === layout.sections.length - 1}
                    aria-label={`Move ${name} down`}
                    onClick={() => move(index, 1)}
                  >
                    <ArrowDown />
                  </Button>
                </li>
              );
            })}
          </ul>
          <p className="text-muted-foreground mt-1 text-xs">
            The barcode is what Scan &amp; pack reads to open an order. The address and the shipping
            method sit side by side when they&apos;re next to each other.
          </p>
        </fieldset>

        <fieldset className="flex flex-col gap-2">
          <legend className="mb-2 text-sm font-semibold">Each item shows</legend>
          <div className="flex flex-wrap gap-x-5 gap-y-2">
            {tick("show_sku", "SKU")}
            {tick("show_barcode", "Product barcode")}
            {tick("show_photo", "Product photo")}
            {tick("show_price", "Price")}
          </div>
          {layout.show_photo && (
            <p className="text-muted-foreground text-xs">
              Photos print on paper, in grey. A slip sent straight to a Zebra goes without them.
            </p>
          )}
        </fieldset>

        <Segments
          label="Text size"
          value={layout.text_size}
          options={SLIP_TEXT_SIZES.map(
            (each) =>
              [
                each,
                each === "small" ? "Compact" : each === "normal" ? "Normal" : "Large",
              ] as const,
          )}
          onChange={(text_size) => set({ text_size })}
        />
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="slip-message">Thank-you message</Label>
          <textarea
            id="slip-message"
            rows={2}
            maxLength={600}
            value={layout.message}
            onChange={(event) => set({ message: event.target.value })}
            placeholder="Thanks for making with us!"
            className={`${textarea} font-read`}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="slip-footer">Footer (website, social, returns)</Label>
          <Input
            id="slip-footer"
            maxLength={120}
            value={layout.footer}
            onChange={(event) => set({ footer: event.target.value })}
            placeholder="yourstudio.com · @yourstudio"
          />
        </div>
        {note && <FormMessage kind={note.kind}>{note.text}</FormMessage>}
        <div className="flex flex-wrap items-center gap-3">
          <Button
            type="button"
            disabled={saving}
            onClick={() =>
              startSave(async () => {
                const result = await saveSlipLayout(slug, layout).catch(() => ({
                  error: "That didn't save. Please try again.",
                }));
                if ("error" in result && result.error) {
                  setNote({ kind: "error", text: result.error });
                  return;
                }
                setDirty(false);
                setNote({ kind: "success", text: "Saved. Your next slips will print this way." });
              })
            }
          >
            {saving ? "Saving…" : "Save packing slip"}
          </Button>
          {dirty && <span className="text-muted-foreground text-xs">Unsaved changes</span>}
        </div>
      </div>

      <div className="flex min-w-0 flex-col gap-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-sm font-bold">Preview</span>
          <span className="flex items-center gap-2">
            {slipsGoToZebra(print) && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={printing}
                title="Prints this sample on this computer's Zebra, as it stands here, saved or not"
                onClick={() =>
                  startPrint(async () => {
                    try {
                      const drawn = await slipsForZebra([slip], logoUrl, print.zebraDpi);
                      const { device } = await zebraClient().send(
                        drawn.zpl.join("\n"),
                        print.zebraName,
                      );
                      setNote({
                        kind: "success",
                        text: `Sample sent to ${device.name}.${drawn.plain > 0 ? " This browser couldn't draw the designed slip, so the plain one printed." : ""}`,
                      });
                    } catch (err) {
                      setNote({
                        kind: "error",
                        text:
                          err instanceof Error && err.message
                            ? err.message
                            : "The sample didn't reach the printer.",
                      });
                    }
                  })
                }
              >
                <Printer aria-hidden />
                {printing ? "Sending…" : "Print a sample"}
              </Button>
            )}
            <span
              role="group"
              aria-label="Paper"
              className="border-input inline-flex overflow-hidden rounded-sm border text-xs font-semibold"
            >
              {(
                [
                  ["4x6", "4 × 6"],
                  ["letter", "Letter"],
                ] as const
              ).map(([value, text]) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={size === value}
                  onClick={() => savePrint({ slipPaper: value })}
                  className={cn(
                    "h-[30px] px-2.5",
                    size === value ? "bg-teal text-on-teal" : "bg-card hover:bg-hover",
                  )}
                >
                  {text}
                </button>
              ))}
            </span>
          </span>
        </div>
        <div
          aria-label="Packing slip preview"
          className="bg-panel border-border overflow-auto rounded-lg border p-4"
        >
          <style>{SLIP_CSS}</style>
          <div
            className="slip-root mx-auto w-fit shadow-md"
            // A letter page is shown at half size so it fits beside the form.
            style={size === "letter" ? { zoom: 0.55 } : undefined}
          >
            <SlipSheet slip={slip} logo={logoUrl} size={size} />
          </div>
        </div>
        <p className="text-muted-foreground text-xs">
          A made-up order. Black and white, as a thermal printer prints it. The paper size is this
          computer&apos;s own choice for slips printed through the browser.
        </p>
      </div>
    </div>
  );
}
