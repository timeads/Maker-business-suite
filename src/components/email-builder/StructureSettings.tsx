"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowDown, ArrowUp, RotateCcw, Trash2 } from "lucide-react";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "./ui";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  FONTS,
  FONT_IDS,
  LAYOUT_NAMES,
  ROW_LAYOUTS,
  findRow,
  findSection,
  plainSectionStyles,
  type FontId,
  type SectionStyles,
} from "@/lib/design";
import { cn } from "@/lib/utils";
import { useBuilder } from "./context";
import { LayoutGlyph } from "./BlocksPanel";
import {
  BorderField,
  ColorField,
  Field,
  ImageField,
  PaddingField,
  SelectField,
  ToggleField,
} from "./fields";
import { FOCUS_NAME } from "./shared";

/** The side panel for a selected row: how its columns are arranged, and moving or removing it. */
export function RowSettings({ id }: { id: string }) {
  const { doc, dispatch, select } = useBuilder();
  const found = findRow(doc, id);
  if (!found) return null;
  return (
    <div className="space-y-5 p-4">
      <div className="space-y-2">
        <span className="block text-xs font-medium">Columns</span>
        <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Columns">
          {ROW_LAYOUTS.map((layout) => (
            <button
              key={layout}
              type="button"
              role="radio"
              aria-checked={found.row.layout === layout}
              onClick={() => dispatch({ type: "setRowLayout", id, layout })}
              className={cn(
                "flex h-9 items-center gap-2 rounded-md border px-2.5 text-xs",
                found.row.layout === layout
                  ? "border-ochre ring-ochre ring-1"
                  : "hover:border-foreground/50",
              )}
            >
              <LayoutGlyph layout={layout} />
              {LAYOUT_NAMES[layout]}
            </button>
          ))}
        </div>
        <p className="text-muted-foreground text-xs">
          With fewer columns, content from the ones removed moves into the last one kept.
        </p>
      </div>
      {found.row.columns.length > 1 && (
        <div className="space-y-1">
          <ToggleField
            label="Stack columns on mobile"
            checked={found.row.stackOnMobile}
            onChange={(stack) => dispatch({ type: "setRowStack", id, stack })}
          />
          <p className="text-muted-foreground text-xs">
            On: on a phone the columns go one under another. Off: they stay side by side, which
            suits small things like icons.
          </p>
        </div>
      )}
      <div className="flex gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="flex-1"
          onClick={() => dispatch({ type: "moveRow", id, by: -1 })}
        >
          <ArrowUp className="mr-1 h-3.5 w-3.5" /> Move up
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="flex-1"
          onClick={() => dispatch({ type: "moveRow", id, by: 1 })}
        >
          <ArrowDown className="mr-1 h-3.5 w-3.5" /> Move down
        </Button>
      </div>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="text-brick w-full"
        onClick={() => {
          dispatch({ type: "deleteRow", id });
          select(null);
        }}
      >
        <Trash2 className="mr-1.5 h-3.5 w-3.5" /> Delete this row and what is in it
      </Button>
    </div>
  );
}

const FONT_CHOICES: { value: FontId | ""; label: string }[] = [
  { value: "", label: "Same as the email" },
  ...FONT_IDS.map((f) => ({ value: f as FontId, label: FONTS[f].label })),
];

/** The side panel for a selected section: its name, and how it looks where it differs from the rest of the email. */
export function SectionSettings({ id }: { id: string }) {
  const { doc, dispatch } = useBuilder();
  const section = findSection(doc, id);
  // The name box keeps what is typed, so it can be emptied on the way to a new name.
  const [name, setName] = useState(section?.name ?? "");
  const nameBox = useRef<HTMLInputElement>(null);
  useEffect(() => {
    // Rename in the section's menu asks for this box.
    const focus = () => nameBox.current?.select();
    window.addEventListener(FOCUS_NAME, focus);
    return () => window.removeEventListener(FOCUS_NAME, focus);
  }, []);
  if (!section) return null;
  const s = section.styles;
  const set = (patch: Partial<SectionStyles>) =>
    dispatch({ type: "updateSectionStyles", id, patch });
  const styled = JSON.stringify(s) !== JSON.stringify(plainSectionStyles());
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <Field label="Section name" hint="Only you see this name. It is not in the email.">
          <Input
            ref={nameBox}
            className="h-9"
            value={name}
            maxLength={40}
            onChange={(e) => {
              setName(e.target.value);
              dispatch({ type: "renameSection", id, name: e.target.value });
            }}
          />
        </Field>
        <h3 className="mt-5 text-xs font-bold">Styles</h3>
        <Accordion type="single" collapsible defaultValue="band" className="mt-1">
          <AccordionItem value="band">
            <AccordionTrigger className="py-3 text-sm">Section background</AccordionTrigger>
            <AccordionContent className="space-y-4">
              <p className="text-muted-foreground text-[11px]">
                The band across the whole width, behind this section.
              </p>
              <ColorField
                label="Section colour"
                brand={doc.brand}
                value={s.background}
                onChange={(background) => set({ background })}
                onClear={() => set({ background: undefined })}
              />
              <ImageField
                label="Section picture"
                value={s.image ?? ""}
                onChange={(image) => set({ image: image || undefined })}
                hint="Many email programs leave background pictures out, so choose a colour as well."
              />
            </AccordionContent>
          </AccordionItem>
          <AccordionItem value="content">
            <AccordionTrigger className="py-3 text-sm">Content background</AccordionTrigger>
            <AccordionContent className="space-y-4">
              <p className="text-muted-foreground text-[11px]">
                The column in the middle that holds this section's content.
              </p>
              <ColorField
                label="Content colour"
                brand={doc.brand}
                value={s.contentBg}
                onChange={(contentBg) => set({ contentBg })}
                onClear={() => set({ contentBg: undefined })}
              />
            </AccordionContent>
          </AccordionItem>
          <AccordionItem value="text">
            <AccordionTrigger className="py-3 text-sm">Text</AccordionTrigger>
            <AccordionContent className="space-y-4">
              <ColorField
                label="Text colour"
                brand={doc.brand}
                value={s.textColor}
                onChange={(textColor) => set({ textColor })}
                onClear={() => set({ textColor: undefined })}
              />
              <SelectField
                label="Font"
                value={s.font ?? ""}
                options={FONT_CHOICES}
                onChange={(font) => set({ font: font || undefined })}
              />
            </AccordionContent>
          </AccordionItem>
          <AccordionItem value="link">
            <AccordionTrigger className="py-3 text-sm">Link</AccordionTrigger>
            <AccordionContent>
              <ColorField
                label="Link colour"
                brand={doc.brand}
                value={s.linkColor}
                onChange={(linkColor) => set({ linkColor })}
                onClear={() => set({ linkColor: undefined })}
              />
            </AccordionContent>
          </AccordionItem>
          <AccordionItem value="padding">
            <AccordionTrigger className="py-3 text-sm">Padding</AccordionTrigger>
            <AccordionContent>
              <PaddingField
                label="Space inside the section"
                value={s.padding}
                onChange={(padding) => set({ padding })}
              />
            </AccordionContent>
          </AccordionItem>
          <AccordionItem value="border">
            <AccordionTrigger className="py-3 text-sm">Border</AccordionTrigger>
            <AccordionContent>
              <BorderField
                value={s.border}
                brand={doc.brand}
                onChange={(border) => set({ border })}
              />
            </AccordionContent>
          </AccordionItem>
        </Accordion>
      </div>
      <div className="border-t p-3">
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="w-full"
          disabled={!styled}
          onClick={() => dispatch({ type: "clearSectionStyles", id })}
          title="Go back to the email's own styles for this section"
        >
          <RotateCcw className="mr-1.5 h-3.5 w-3.5" /> Clear styles
        </Button>
      </div>
    </div>
  );
}
