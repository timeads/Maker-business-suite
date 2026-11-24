"use client";

import { useRef, useState } from "react";
import { Printer } from "lucide-react";
import { Button } from "@/components/ui/button";
import { usePrintSettings } from "@/lib/shipping/zebra/use-print-settings";
import { sendLabelToZebra } from "../print-run";

export type BatchLabel = {
  shipmentId: string;
  /** The order it is for. */
  name: string;
  /** Each box's label file to open, where we hold one. */
  links: string[];
};

/**
 * A run's labels, to print again. On a computer set to a Zebra they go to the
 * printer one after another, in the order they were bought; anywhere else
 * each label opens to print the ordinary way.
 */
export function BatchReprint({ slug, labels }: { slug: string; labels: BatchLabel[] }) {
  const [settings] = usePrintSettings();
  const zebra = settings.labels === "zebra";
  const running = useRef(false);
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<{ name: string; ok: boolean; text: string }[]>([]);
  const [open, setOpen] = useState(false);

  const printAll = async () => {
    if (running.current) return;
    if (
      !window.confirm(
        `Print ${labels.length === 1 ? "this label" : `all ${labels.length} labels`} again? Each is a second copy of a label you already have; only one copy of each can be used.`,
      )
    ) {
      return;
    }
    running.current = true;
    setBusy(true);
    setSaid([]);
    try {
      for (const label of labels) {
        const sent = await sendLabelToZebra(slug, label.shipmentId, settings);
        setSaid((before) => [...before, { name: label.name, ok: sent.ok, text: sent.text }]);
      }
    } finally {
      running.current = false;
      setBusy(false);
    }
  };

  const files = labels.flatMap((label) =>
    label.links.map((href, index) => ({
      href,
      text: label.links.length > 1 ? `${label.name} · label ${index + 1}` : label.name,
    })),
  );
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        {zebra ? (
          <Button type="button" variant="outline" size="sm" disabled={busy} onClick={printAll}>
            <Printer aria-hidden />
            {busy
              ? "Printing…"
              : `Print ${labels.length === 1 ? "the label" : `all ${labels.length} labels`} again`}
          </Button>
        ) : (
          files.length > 0 && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              aria-expanded={open}
              onClick={() => setOpen((shown) => !shown)}
            >
              <Printer aria-hidden />
              {`Print ${labels.length === 1 ? "the label" : `all ${labels.length} labels`} again`}
            </Button>
          )
        )}
      </div>
      {(open || (zebra && files.length > 0 && said.some((line) => !line.ok))) && (
        <ul className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
          {files.map((file) => (
            <li key={file.href}>
              <a
                href={file.href}
                target="_blank"
                rel="noopener noreferrer"
                className="text-ochre-text font-medium tabular-nums hover:underline"
              >
                {file.text}
              </a>
            </li>
          ))}
        </ul>
      )}
      {open && !zebra && (
        <p className="text-muted-foreground text-xs">
          Each label opens in its own tab, in the order they were bought. A label we only hold a
          carrier&apos;s link for is printed from its order&apos;s page.
        </p>
      )}
      {said.length > 0 && (
        <ul role="status" className="flex flex-col gap-0.5 text-xs">
          {said.map((line) => (
            <li key={line.name} className={line.ok ? "text-muted-foreground" : "text-brick"}>
              <span className="font-semibold tabular-nums">{line.name}</span> {line.text}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
