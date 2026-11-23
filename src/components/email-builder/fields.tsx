"use client";

/* eslint-disable @next/next/no-img-element -- pictures in an email sit on other hosts, at addresses not known ahead of time */

import { useHost } from "./host";
import { useId, useState } from "react";
import { Ban, ImageIcon, Monitor, Smartphone, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "./ui";
import { Input } from "@/components/ui/input";
import type { BrandId } from "@/lib/design/brands";
import {
  hexOr,
  safeUrl,
  type Align,
  type Border,
  type BorderStyle,
  type Box,
  type Device,
} from "@/lib/design";
import { cn } from "@/lib/utils";
import { useBuilder } from "./context";
import { PhotoPicker } from "./PhotoPicker";
import { ALIGN_OPTIONS, selectClass } from "./shared";

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  // A wrapping label ties the words to the box for screen readers and for clicking.
  return (
    <label className="block space-y-1">
      <span className="block text-xs font-medium">{label}</span>
      {children}
      {hint && <span className="text-muted-foreground block text-[11px] leading-snug">{hint}</span>}
    </label>
  );
}

/** A text box that keeps what is being typed and reports it as it changes. */
export function TextField({
  label,
  value,
  onChange,
  hint,
  placeholder,
  inputMode,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  hint?: string;
  placeholder?: string;
  inputMode?: "url" | "text";
}) {
  return (
    <Field label={label} hint={hint}>
      <Input
        className="h-9"
        value={value}
        placeholder={placeholder}
        inputMode={inputMode}
        onChange={(e) => onChange(e.target.value)}
      />
    </Field>
  );
}

/** A whole number within limits. What is typed is kept as typed; the value changes once it is a number in range. */
export function NumberField({
  label,
  value,
  onChange,
  min,
  max,
  unit = "px",
  step = 1,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
  min: number;
  max: number;
  unit?: string;
  step?: number;
}) {
  const [text, setText] = useState(String(value));
  // When the value changes from elsewhere (undo, another control), the box follows it.
  const [shown, setShown] = useState(value);
  if (shown !== value) {
    setShown(value);
    setText(String(value));
  }
  return (
    <label className="block space-y-1">
      <span className="block text-xs font-medium">{label}</span>
      <span className="flex items-center gap-1">
        <Input
          type="number"
          className="h-9 w-full px-2"
          min={min}
          max={max}
          step={step}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            const n = Number(e.target.value);
            if (e.target.value.trim() !== "" && Number.isFinite(n) && n >= min && n <= max)
              onChange(step < 1 ? Math.round(n * 10) / 10 : Math.round(n));
          }}
          onBlur={() => setText(String(value))}
        />
        <span className="text-muted-foreground text-[11px]">{unit}</span>
      </span>
    </label>
  );
}

/** One choice from a few, shown side by side. */
export function Segmented<T extends string | number>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: { value: T; label: string; icon?: React.ReactNode }[];
  onChange: (value: T) => void;
}) {
  return (
    <div className="space-y-1">
      <span className="block text-xs font-medium">{label}</span>
      <div
        className="border-border flex rounded-md border p-0.5"
        role="radiogroup"
        aria-label={label}
      >
        {options.map((o) => (
          <button
            key={String(o.value)}
            type="button"
            role="radio"
            aria-checked={o.value === value}
            aria-label={o.label}
            title={o.label}
            onClick={() => onChange(o.value)}
            className={cn(
              "flex h-8 flex-1 items-center justify-center gap-1 rounded text-xs",
              o.value === value
                ? "bg-teal text-on-teal"
                : "text-muted-foreground hover:bg-sunken hover:text-foreground",
            )}
          >
            {o.icon ?? o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * A colour: the brand's own as swatches, or any other typed as a hex code. With `onClear`, the
 * colour can be taken off so the email's own is used.
 */
export function ColorField({
  label,
  value,
  onChange,
  onClear,
}: {
  label: string;
  value: string | undefined;
  onChange: (hex: string) => void;
  brand: BrandId;
  onClear?: () => void;
}) {
  const [text, setText] = useState(value ?? "");
  const id = useId();
  const [shown, setShown] = useState(value);
  if (shown !== value) {
    setShown(value);
    setText(value ?? "");
  }
  const host = useHost();
  const names: [string, string][] = host.swatches.map((c) => [c.name, c.hex]);
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="block text-xs font-medium">
        {label}
      </label>
      <div className="flex flex-wrap gap-1" role="group" aria-label={`${label}: brand colours`}>
        {onClear && (
          <button
            type="button"
            onClick={onClear}
            aria-label={`${label}: none`}
            title="None"
            aria-pressed={!value}
            className={cn(
              "text-muted-foreground border-border flex h-6 w-6 items-center justify-center rounded-full border",
              !value && "ring-ochre ring-2 ring-offset-1",
            )}
          >
            <Ban className="h-3.5 w-3.5" />
          </button>
        )}
        {[...new Set([...host.swatches.map((c) => c.hex), "#ffffff", "#000000"])].map((hex) => {
          const name =
            names.find(([, h]) => h === hex)?.[0] ?? (hex === "#ffffff" ? "white" : "black");
          return (
            <button
              key={hex}
              type="button"
              onClick={() => onChange(hex)}
              aria-label={`${label}: ${name}`}
              title={name}
              aria-pressed={value === hex}
              className={cn(
                "h-6 w-6 rounded-full border border-black/20",
                value === hex && "ring-ochre ring-2 ring-offset-1",
              )}
              style={{ background: hex }}
            />
          );
        })}
      </div>
      <div className="flex items-center gap-2">
        <span
          className="h-9 w-9 shrink-0 rounded-md border border-black/20"
          style={{ background: value ?? "transparent" }}
          aria-hidden
        />
        <Input
          id={id}
          className="h-9 font-mono text-xs"
          value={text}
          placeholder={onClear ? "Same as the email" : "#000000"}
          spellCheck={false}
          maxLength={7}
          onChange={(e) => {
            setText(e.target.value);
            const hex = hexOr(
              e.target.value.startsWith("#") ? e.target.value : `#${e.target.value}`,
              undefined,
            );
            // Only a finished six-figure code is taken, so a half-typed one never flashes the wrong colour.
            if (hex && hex.length === 7) onChange(hex);
          }}
          onBlur={() => setText(value ?? "")}
        />
      </div>
    </div>
  );
}

const SIDES: (keyof Box)[] = ["top", "bottom", "left", "right"];
const SIDE_NAMES: Record<keyof Box, string> = {
  top: "Top",
  bottom: "Bottom",
  left: "Left",
  right: "Right",
};

/** Space on the four sides of something, one side at a time or all at once. */
export function PaddingField({
  label = "Space inside",
  value,
  onChange,
}: {
  label?: string;
  value: Box;
  onChange: (box: Box) => void;
}) {
  const [all, setAll] = useState(false);
  return (
    <div className="space-y-2" role="group" aria-label={label}>
      <span className="block text-xs font-medium">{label}</span>
      <div className="grid grid-cols-2 gap-2">
        {SIDES.map((side) => (
          <NumberField
            key={side}
            label={SIDE_NAMES[side]}
            value={value[side]}
            min={0}
            max={80}
            onChange={(n) =>
              onChange(all ? { top: n, right: n, bottom: n, left: n } : { ...value, [side]: n })
            }
          />
        ))}
      </div>
      <label className="flex items-center gap-2 text-xs">
        <input
          type="checkbox"
          className="h-4 w-4"
          checked={all}
          onChange={(e) => setAll(e.target.checked)}
        />
        Apply to all sides
      </label>
    </div>
  );
}

/** Left, centre or right. */
export function AlignField({
  value,
  onChange,
}: {
  value: Align;
  onChange: (align: Align) => void;
}) {
  return (
    <Segmented
      label="Alignment"
      value={value}
      onChange={onChange}
      options={ALIGN_OPTIONS.map(({ value: v, label, Icon }) => ({
        value: v,
        label,
        icon: <Icon className="h-4 w-4" />,
      }))}
    />
  );
}

/** Something that is on or off. */
export function ToggleField({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex items-center justify-between gap-3 text-xs font-medium">
      {label}
      <Switch checked={checked} onCheckedChange={onChange} aria-label={label} />
    </label>
  );
}

export function CheckField({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex items-center gap-2 text-xs">
      <input
        type="checkbox"
        className="h-4 w-4"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      {label}
    </label>
  );
}

export function SelectField<T extends string | number>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
}) {
  return (
    <Field label={label}>
      <select
        className={selectClass}
        value={String(value)}
        onChange={(e) =>
          onChange(options.find((o) => String(o.value) === e.target.value)?.value ?? value)
        }
      >
        {options.map((o) => (
          <option key={String(o.value)} value={String(o.value)}>
            {o.label}
          </option>
        ))}
      </select>
    </Field>
  );
}

const BORDER_STYLES: { value: BorderStyle; label: string }[] = [
  { value: "none", label: "None" },
  { value: "solid", label: "Solid" },
  { value: "dashed", label: "Dashed" },
  { value: "dotted", label: "Dotted" },
];

/** A line around something: none, or a style with its thickness and colour. */
export function BorderField({
  label = "Border",
  value,
  onChange,
  brand,
}: {
  label?: string;
  value: Border;
  onChange: (border: Border) => void;
  brand: BrandId;
}) {
  return (
    <div className="space-y-2" role="group" aria-label={label}>
      <div className="grid grid-cols-2 gap-2">
        <SelectField
          label={label}
          value={value.style}
          options={BORDER_STYLES}
          onChange={(style) => onChange({ ...value, style })}
        />
        {value.style !== "none" && (
          <NumberField
            label="Thickness"
            value={value.width}
            min={0}
            max={20}
            onChange={(width) => onChange({ ...value, width })}
          />
        )}
      </div>
      {value.style !== "none" && (
        <ColorField
          label={`${label} colour`}
          brand={brand}
          value={value.color}
          onChange={(color) => onChange({ ...value, color })}
        />
      )}
    </div>
  );
}

/** A picture from the library, or none. */
export function ImageField({
  label,
  value,
  onChange,
  hint,
  removable = true,
}: {
  label: string;
  value: string;
  onChange: (url: string) => void;
  hint?: string;
  removable?: boolean;
}) {
  const [picking, setPicking] = useState(false);
  return (
    <div className="space-y-1.5" role="group" aria-label={label}>
      <span className="block text-xs font-medium">{label}</span>
      {value && (
        <img
          src={value}
          alt=""
          className="bg-sunken border-border max-h-24 w-full rounded border object-contain"
        />
      )}
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" size="sm" onClick={() => setPicking(true)}>
          <ImageIcon className="h-3.5 w-3.5" /> {value ? "Change picture" : "Choose from library"}
        </Button>
        {value && removable && (
          <Button type="button" variant="ghost" size="sm" onClick={() => onChange("")}>
            <X className="h-3.5 w-3.5" /> Remove
          </Button>
        )}
      </div>
      {hint && <span className="text-muted-foreground block text-[11px] leading-snug">{hint}</span>}
      <PhotoPicker
        open={picking}
        onOpenChange={setPicking}
        onSelect={(picked) => {
          const url = safeUrl(picked);
          if (url) onChange(url);
          setPicking(false);
        }}
      />
    </div>
  );
}

/**
 * Settings that can differ between a computer and a phone. While "same" is on there is one set;
 * with it off, Desktop and Mobile each have their own, starting on whichever the canvas shows.
 */
export function DeviceCard({
  same,
  onSame,
  children,
}: {
  same: boolean;
  onSame: (same: boolean) => void;
  children: (device: Device) => React.ReactNode;
}) {
  const { device: showing } = useBuilder();
  const [tab, setTab] = useState<Device>(showing);
  // Follows the canvas when it is switched between computer and phone.
  const [seen, setSeen] = useState(showing);
  if (seen !== showing) {
    setSeen(showing);
    setTab(showing);
  }
  const device = same ? "desktop" : tab;
  return (
    <div
      className="border-border space-y-3 rounded-md border p-3"
      role="group"
      aria-label="Device-specific"
    >
      <span className="block text-xs font-bold">Device-specific</span>
      <ToggleField label="Same styles for desktop and mobile" checked={same} onChange={onSame} />
      {!same && (
        <div
          className="border-border flex rounded-md border p-0.5"
          role="tablist"
          aria-label="Device"
        >
          {(
            [
              ["desktop", "Desktop", Monitor],
              ["mobile", "Mobile", Smartphone],
            ] as const
          ).map(([value, label, Icon]) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={tab === value}
              onClick={() => setTab(value)}
              className={cn(
                "flex h-7 flex-1 items-center justify-center gap-1.5 rounded text-xs",
                tab === value
                  ? "bg-teal text-on-teal"
                  : "text-muted-foreground hover:bg-sunken hover:text-foreground",
              )}
            >
              <Icon className="h-3.5 w-3.5" aria-hidden />
              {label}
            </button>
          ))}
        </div>
      )}
      {children(device)}
    </div>
  );
}
