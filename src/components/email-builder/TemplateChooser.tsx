"use client";

import { useHost } from "./host";
import { useMemo } from "react";
import { FileText } from "lucide-react";
import { docFromTemplate, renderDocHtml, type EmailTemplate } from "@/lib/design";
import type { BrandId } from "@/lib/design/brands";
import { cn } from "@/lib/utils";

/** A small picture of a template: its exported HTML, shrunk, in a locked frame. */
function Thumb({ template }: { template: EmailTemplate }) {
  const html = useMemo(() => renderDocHtml(docFromTemplate(template)), [template]);
  return (
    <span className="border-border block h-36 overflow-hidden rounded border bg-white" aria-hidden>
      <iframe
        title=""
        tabIndex={-1}
        srcDoc={html}
        sandbox=""
        className="pointer-events-none origin-top-left border-0"
        style={{ width: 640, height: 440, transform: "scale(0.33)" }}
      />
    </span>
  );
}

/**
 * The templates an email can start from, or be changed to: the brand's starters, then the ones
 * the owner has saved for that brand. `blank` adds the plain starting layout as a first choice.
 */
export function TemplateChooser({
  brand,
  saved,
  value,
  onChange,
  blank = false,
}: {
  brand: BrandId;
  saved: EmailTemplate[];
  value: string;
  onChange: (id: string) => void;
  blank?: boolean;
}) {
  const { starters } = useHost();
  const own = saved.filter((t) => t.brand === brand);
  const card = (id: string, name: string, about: string, picture: React.ReactNode) => (
    <button
      key={id}
      type="button"
      role="radio"
      aria-checked={value === id}
      onClick={() => onChange(id)}
      data-template={id}
      className={cn(
        "border-border space-y-1.5 rounded-lg border p-2 text-left transition-colors",
        value === id ? "border-ochre ring-ochre ring-2" : "hover:border-foreground/40",
      )}
    >
      {picture}
      <span className="block text-sm font-bold">{name}</span>
      {about && (
        <span className="text-muted-foreground block text-[11px] leading-snug">{about}</span>
      )}
    </button>
  );
  return (
    <div className="space-y-3" role="radiogroup" aria-label="Template">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {blank &&
          card(
            "blank",
            "Blank",
            "The plain layout: logo, picture, headline, text, button.",
            <span
              className="bg-sunken/40 text-muted-foreground border-border flex h-36 items-center justify-center rounded border"
              aria-hidden
            >
              <FileText className="h-8 w-8" />
            </span>,
          )}
        {starters.map((t) => card(t.id, t.name, t.about, <Thumb template={t} />))}
      </div>
      {own.length > 0 && (
        <>
          <p className="text-xs font-bold">Your templates</p>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {own.map((t) => card(t.id, t.name, t.about, <Thumb template={t} />))}
          </div>
        </>
      )}
      {saved.length > own.length && (
        <p className="text-muted-foreground text-[11px]">
          Templates you saved for your other brands show when that brand is chosen.
        </p>
      )}
    </div>
  );
}
