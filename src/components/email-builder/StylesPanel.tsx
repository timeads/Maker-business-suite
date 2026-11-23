"use client";

import { useState } from "react";
import { Plus } from "lucide-react";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "./ui";
import { Button } from "@/components/ui/button";
import {
  BUTTON_PADDING,
  FONTS,
  FONT_IDS,
  LINE_HEIGHTS,
  allBlocks,
  logoBlock,
  safeHref,
  type ButtonAlign,
  type ButtonShape,
  type ButtonSize,
  type ButtonSizes,
  type Device,
  type FontId,
  type GlobalStyles,
  type TextKind,
  type TextSizes,
  type TextStyle,
} from "@/lib/design";
import { useBuilder } from "./context";
import {
  AlignField,
  BorderField,
  CheckField,
  ColorField,
  DeviceCard,
  ImageField,
  NumberField,
  PaddingField,
  Segmented,
  SelectField,
  TextField,
} from "./fields";

const TEXT_KINDS: { value: TextKind; label: string }[] = [
  { value: "p", label: "P" },
  { value: "h1", label: "H1" },
  { value: "h2", label: "H2" },
  { value: "h3", label: "H3" },
];
const KIND_NAMES: Record<TextKind, string> = {
  p: "Paragraphs",
  h1: "Largest headings",
  h2: "Medium headings",
  h3: "Small headings",
};
const FONT_OPTIONS = FONT_IDS.map((f) => ({ value: f as FontId, label: FONTS[f].label }));
const SHAPES: { value: ButtonShape; label: string }[] = [
  { value: "square", label: "Square" },
  { value: "round", label: "Round" },
  { value: "pill", label: "Pill" },
  { value: "custom", label: "Other" },
];
const SIZES: { value: ButtonSize; label: string }[] = [
  { value: "small", label: "Small" },
  { value: "medium", label: "Medium" },
  { value: "large", label: "Large" },
];
const BUTTON_ALIGNS: { value: ButtonAlign; label: string }[] = [
  { value: "left", label: "Left" },
  { value: "center", label: "Centre" },
  { value: "right", label: "Right" },
  { value: "full", label: "Full" },
];
const LINE_STYLES = [
  { value: "solid" as const, label: "Solid" },
  { value: "dashed" as const, label: "Dashed" },
  { value: "dotted" as const, label: "Dotted" },
];

type Set = (patch: Partial<GlobalStyles>) => void;
interface Part {
  g: GlobalStyles;
  set: Set;
}

function BackgroundStyles({ g, set }: Part) {
  const { doc } = useBuilder();
  return (
    <>
      <ColorField
        label="Content colour"
        brand={doc.brand}
        value={g.contentBg}
        onChange={(contentBg) => set({ contentBg })}
      />
      <ColorField
        label="Background colour"
        brand={doc.brand}
        value={g.pageBg}
        onChange={(pageBg) => set({ pageBg })}
      />
      <ImageField
        label="Background picture"
        value={g.pageBgImage}
        onChange={(pageBgImage) => set({ pageBgImage })}
        hint="Shown behind the email where the email program allows it. Many do not, so the background colour is what most readers see."
      />
      <NumberField
        label="Space at the sides on a phone"
        value={g.mobilePadding}
        min={0}
        max={40}
        onChange={(mobilePadding) => set({ mobilePadding })}
      />
    </>
  );
}

function TextStyles({ g, set }: Part) {
  const { doc } = useBuilder();
  const [kind, setKind] = useState<TextKind>("p");
  const style = g.text[kind];
  const change = (patch: Partial<TextStyle>) =>
    set({ text: { ...g.text, [kind]: { ...style, ...patch } } });
  const sizes = (device: Device, patch: Partial<TextSizes>) =>
    change({ [device]: { ...style[device], ...patch } });
  return (
    <>
      <Segmented<TextKind>
        label="Which text"
        value={kind}
        options={TEXT_KINDS}
        onChange={setKind}
      />
      <p className="text-muted-foreground text-[11px]">{KIND_NAMES[kind]}</p>
      <SelectField
        label="Font"
        value={style.font}
        options={FONT_OPTIONS}
        onChange={(font) => change({ font })}
      />
      <NumberField
        label="Letter spacing"
        value={style.letterSpacing}
        min={0}
        max={10}
        step={0.5}
        onChange={(letterSpacing) => change({ letterSpacing })}
      />
      <AlignField value={style.align} onChange={(align) => change({ align })} />
      <div className="flex flex-wrap gap-x-4 gap-y-2">
        <CheckField label="Bold" checked={style.bold} onChange={(bold) => change({ bold })} />
        <CheckField
          label="Italic"
          checked={style.italic}
          onChange={(italic) => change({ italic })}
        />
        <CheckField
          label="All capitals"
          checked={style.uppercase}
          onChange={(uppercase) => change({ uppercase })}
        />
      </div>
      <ColorField
        label="Text colour"
        brand={doc.brand}
        value={style.color}
        onChange={(color) => change({ color })}
      />
      <DeviceCard same={style.sameForMobile} onSame={(sameForMobile) => change({ sameForMobile })}>
        {(device) => (
          <>
            <NumberField
              label="Font size"
              value={style[device].size}
              min={10}
              max={72}
              onChange={(size) => sizes(device, { size })}
            />
            <SelectField
              label="Line height"
              value={style[device].lineHeight}
              options={LINE_HEIGHTS.map((n) => ({ value: n, label: String(n) }))}
              onChange={(lineHeight) => sizes(device, { lineHeight })}
            />
            <NumberField
              label="Space below"
              value={style[device].spacing}
              min={0}
              max={60}
              onChange={(spacing) => sizes(device, { spacing })}
            />
          </>
        )}
      </DeviceCard>
    </>
  );
}

function LinkStyles({ g, set }: Part) {
  const { doc } = useBuilder();
  return (
    <>
      <ColorField
        label="Link colour"
        brand={doc.brand}
        value={g.link.color}
        onChange={(color) => set({ link: { ...g.link, color } })}
      />
      <div className="flex gap-4">
        <CheckField
          label="Underlined"
          checked={g.link.underline}
          onChange={(underline) => set({ link: { ...g.link, underline } })}
        />
        <CheckField
          label="Bold"
          checked={g.link.bold}
          onChange={(bold) => set({ link: { ...g.link, bold } })}
        />
      </div>
    </>
  );
}

function ButtonStyles({ g, set }: Part) {
  const { doc } = useBuilder();
  const b = g.button;
  const change = (patch: Partial<GlobalStyles["button"]>) => set({ button: { ...b, ...patch } });
  const sizes = (device: Device, patch: Partial<ButtonSizes>) =>
    change({ [device]: { ...b[device], ...patch } });
  return (
    <>
      <Segmented
        label="Shape"
        value={b.shape}
        onChange={(shape) => change({ shape })}
        options={SHAPES}
      />
      {b.shape === "custom" && (
        <NumberField
          label="Corner rounding"
          value={b.radius}
          min={0}
          max={60}
          onChange={(radius) => change({ radius })}
        />
      )}
      <ColorField
        label="Button colour"
        brand={doc.brand}
        value={b.bg}
        onChange={(bg) => change({ bg })}
      />
      <ColorField
        label="Button text colour"
        brand={doc.brand}
        value={b.color}
        onChange={(color) => change({ color })}
      />
      <BorderField value={b.border} brand={doc.brand} onChange={(border) => change({ border })} />
      <SelectField
        label="Font"
        value={b.font}
        options={FONT_OPTIONS}
        onChange={(font) => change({ font })}
      />
      <div className="flex flex-wrap gap-x-4 gap-y-2">
        <CheckField label="Bold" checked={b.bold} onChange={(bold) => change({ bold })} />
        <CheckField label="Italic" checked={b.italic} onChange={(italic) => change({ italic })} />
        <CheckField
          label="Underlined"
          checked={b.underline}
          onChange={(underline) => change({ underline })}
        />
      </div>
      <NumberField
        label="Letter spacing"
        value={b.letterSpacing}
        min={0}
        max={10}
        step={0.5}
        onChange={(letterSpacing) => change({ letterSpacing })}
      />
      <DeviceCard same={b.sameForMobile} onSame={(sameForMobile) => change({ sameForMobile })}>
        {(device) => (
          <>
            {/* A size is a starting point: it sets the space inside the button, which can then be changed by hand. */}
            <Segmented
              label="Size"
              value={b[device].size}
              options={SIZES}
              onChange={(size) => sizes(device, { size, padding: { ...BUTTON_PADDING[size] } })}
            />
            <Segmented
              label="Button alignment"
              value={b[device].align}
              options={BUTTON_ALIGNS}
              onChange={(align) => sizes(device, { align })}
            />
            <PaddingField
              label="Space inside the button"
              value={b[device].padding}
              onChange={(padding) => sizes(device, { padding })}
            />
          </>
        )}
      </DeviceCard>
    </>
  );
}

function DividerStyles({ g, set }: Part) {
  const { doc } = useBuilder();
  const d = g.divider;
  return (
    <>
      <ColorField
        label="Line colour"
        brand={doc.brand}
        value={d.color}
        onChange={(color) => set({ divider: { ...d, color } })}
      />
      <NumberField
        label="Thickness"
        value={d.thickness}
        min={1}
        max={12}
        onChange={(thickness) => set({ divider: { ...d, thickness } })}
      />
      <SelectField
        label="Line style"
        value={d.style}
        options={LINE_STYLES}
        onChange={(style) => set({ divider: { ...d, style } })}
      />
      <PaddingField
        label="Space around the line"
        value={d.padding}
        onChange={(padding) => set({ divider: { ...d, padding } })}
      />
    </>
  );
}

function ImageStyles({ g, set }: Part) {
  const { doc } = useBuilder();
  const i = g.image;
  return (
    <>
      <NumberField
        label="Corner rounding"
        value={i.radius}
        min={0}
        max={60}
        onChange={(radius) => set({ image: { ...i, radius } })}
      />
      <BorderField
        value={i.border}
        brand={doc.brand}
        onChange={(border) => set({ image: { ...i, border } })}
      />
      <PaddingField
        label="Space around pictures"
        value={i.padding}
        onChange={(padding) => set({ image: { ...i, padding } })}
      />
    </>
  );
}

function LogoStyles({ g, set }: Part) {
  const { doc, dispatch, select } = useBuilder();
  const l = g.logo;
  const placed = allBlocks(doc).some((b) => b.type === "image" && b.role === "logo");
  const place = () => {
    const block = logoBlock(doc.brand);
    dispatch({ type: "insertBlock", block, at: { sectionId: doc.sections[0].id, rowIndex: 0 } });
    select({ kind: "block", id: block.id });
  };
  return (
    <>
      <ImageField
        label="Logo"
        value={l.src}
        removable={false}
        onChange={(src) => set({ logo: { ...l, src } })}
        hint="Used by the logo at the top of the email."
      />
      <NumberField
        label="Width"
        value={l.width}
        min={24}
        max={600}
        onChange={(width) => set({ logo: { ...l, width } })}
      />
      <AlignField value={l.align} onChange={(align) => set({ logo: { ...l, align } })} />
      <TextField
        label="Link when clicked"
        value={l.link}
        inputMode="url"
        placeholder="https://example.com"
        onChange={(link) => set({ logo: { ...l, link } })}
        hint={l.link && !safeHref(l.link) ? "Links must start with https://" : undefined}
      />
      {!placed && l.src && (
        <Button type="button" variant="outline" size="sm" className="w-full" onClick={place}>
          <Plus className="h-3.5 w-3.5" /> Add the logo to the top of the email
        </Button>
      )}
    </>
  );
}

const PARTS: [string, string, (props: Part) => React.ReactElement][] = [
  ["background", "Background", BackgroundStyles],
  ["text", "Text", TextStyles],
  ["link", "Link", LinkStyles],
  ["button", "Button", ButtonStyles],
  ["divider", "Divider", DividerStyles],
  ["image", "Image", ImageStyles],
  ["logo", "Logo", LogoStyles],
];

/** The look of the whole email. Blocks follow these unless they have been given styles of their own. */
export function StylesPanel() {
  const { doc, dispatch } = useBuilder();
  const set: Set = (patch) => dispatch({ type: "setGlobalStyles", patch });
  return (
    <div className="p-4">
      <h2 className="text-sm font-bold">Email styles</h2>
      <p className="text-muted-foreground text-xs">
        The look of the whole email. A block with its own styles keeps them.
      </p>
      <Accordion type="single" collapsible defaultValue="background" className="mt-2">
        {PARTS.map(([value, title, Body]) => (
          <AccordionItem key={value} value={value}>
            <AccordionTrigger className="py-3 text-sm">{title}</AccordionTrigger>
            <AccordionContent className="space-y-4">
              <Body g={doc.globalStyles} set={set} />
            </AccordionContent>
          </AccordionItem>
        ))}
      </Accordion>
    </div>
  );
}
