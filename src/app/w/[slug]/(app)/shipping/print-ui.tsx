"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Printer } from "lucide-react";
import { Button } from "@/components/ui/button";
import { FormMessage } from "@/components/ui/form-message";
import { Label, Select } from "@/components/ui/input";
import {
  ZEBRA_DOWNLOAD_LINK,
  ZEBRA_TRUST_LINK,
  ZebraError,
  createZebraClient,
  type ZebraDevice,
} from "@/lib/shipping/zebra/client";
import { labelsToZpl } from "@/lib/shipping/zebra/labels";
import { slipZpl, type SlipData } from "@/lib/shipping/zebra/slip";
import { usePrintSettings } from "@/lib/shipping/zebra/use-print-settings";
import { testLabelZpl } from "@/lib/shipping/zebra/zpl";
import { getLabelPrintData, markLabelPrinted } from "./print-actions";

const linkClass = "text-ochre-text font-medium hover:underline";
type Note = { kind: "error" | "success"; text: string } | null;

const said = (err: unknown, fallback: string) =>
  err instanceof ZebraError ? err.message : fallback;

// ---------------------------------------------------------------------------
// Shipping settings: "Printing on this computer"
// ---------------------------------------------------------------------------

/**
 * This computer's own choice, kept in its browser: the packing bench can send
 * labels straight to its Zebra while the office desk prints as it always has.
 */
export function PrintingOnThisComputer({ workspaceName }: { workspaceName: string }) {
  const [settings, save] = usePrintSettings();
  const [printers, setPrinters] = useState<ZebraDevice[] | null>(null);
  const [busy, setBusy] = useState<"find" | "test" | null>(null);
  const [note, setNote] = useState<Note>(null);
  const zebra = settings.labels === "zebra";

  const find = async () => {
    setBusy("find");
    setNote(null);
    try {
      const found = await createZebraClient().findPrinters();
      setPrinters(found);
      // The first time, the one Browser Print calls its own is chosen.
      const kept = found.find((device) => device.name === settings.zebraName) ?? found[0];
      if (kept.name !== settings.zebraName) save({ zebraName: kept.name });
      setNote({
        kind: "success",
        text:
          found.length === 1
            ? `Found ${kept.name}. Print a test label to check it.`
            : `Found ${found.length} printers. ${kept.name} is chosen; pick another below if that's not the one.`,
      });
    } catch (err) {
      setPrinters(null);
      setNote({ kind: "error", text: said(err, "We couldn't look for printers. Try again.") });
    } finally {
      setBusy(null);
    }
  };

  const test = async () => {
    setBusy("test");
    setNote(null);
    try {
      const { device } = await createZebraClient().send(
        testLabelZpl(workspaceName),
        settings.zebraName,
      );
      if (device.name !== settings.zebraName) save({ zebraName: device.name });
      setNote({ kind: "success", text: `Sent a test label to ${device.name}.` });
    } catch (err) {
      setNote({ kind: "error", text: said(err, "The test label didn't go. Try again.") });
    } finally {
      setBusy(null);
    }
  };

  const names = [
    ...new Set([
      ...(settings.zebraName ? [settings.zebraName] : []),
      ...(printers ?? []).map((device) => device.name),
    ]),
  ];

  return (
    <div className="flex flex-col gap-5 text-sm">
      <fieldset className="flex flex-col gap-3">
        <legend className="mb-2 text-sm font-semibold">Shipping labels</legend>
        <label className="flex items-start gap-2">
          <input
            type="radio"
            name="print-labels"
            className="mt-1"
            checked={!zebra}
            onChange={() => {
              save({ labels: "browser" });
              setNote({ kind: "success", text: "Saved for this computer." });
            }}
          />
          <span>
            Print through the browser
            <span className="text-muted-foreground block text-xs">
              The label opens in a new tab and you print it to any printer.
            </span>
          </span>
        </label>
        <label className="flex items-start gap-2">
          <input
            type="radio"
            name="print-labels"
            className="mt-1"
            checked={zebra}
            onChange={() => {
              save({ labels: "zebra" });
              setNote({ kind: "success", text: "Saved for this computer." });
            }}
          />
          <span>
            Zebra thermal printer
            <span className="text-muted-foreground block text-xs">
              Labels go straight to the Zebra the moment you buy them, with no print window. Needs
              Zebra Browser Print (free) installed and running on this computer.
            </span>
          </span>
        </label>
      </fieldset>

      {zebra && (
        <>
          <ol className="text-muted-foreground flex list-decimal flex-col gap-1 pl-5 text-xs">
            <li>
              Install{" "}
              <a href={ZEBRA_DOWNLOAD_LINK} target="_blank" rel="noopener noreferrer" className={linkClass}>
                Zebra Browser Print
              </a>{" "}
              on this computer and set your label printer as its default.
            </li>
            <li>
              Open{" "}
              <a href={ZEBRA_TRUST_LINK} target="_blank" rel="noopener noreferrer" className={linkClass}>
                localhost:9101/ssl_support
              </a>{" "}
              once in this browser and accept it, so this page may talk to it.
            </li>
            <li>Press Find printers, then print a test label.</li>
          </ol>
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" variant="outline" size="sm" onClick={find} disabled={busy !== null}>
              {busy === "find" ? "Looking…" : "Find printers"}
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={test} disabled={busy !== null}>
              <Printer aria-hidden /> {busy === "test" ? "Sending…" : "Print test label"}
            </Button>
          </div>
          {names.length > 0 && (
            <div className="flex flex-col gap-1.5 sm:max-w-xs">
              <Label htmlFor="zebra-printer">Printer on this computer</Label>
              <Select
                id="zebra-printer"
                value={settings.zebraName}
                onChange={(event) => {
                  save({ zebraName: event.target.value });
                  setNote({ kind: "success", text: "Saved for this computer." });
                }}
              >
                {names.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </Select>
            </div>
          )}
          <div className="flex flex-col gap-1.5 sm:max-w-xs">
            <Label htmlFor="zebra-dpi">Print quality of this printer</Label>
            <Select
              id="zebra-dpi"
              value={String(settings.zebraDpi)}
              onChange={(event) => {
                save({ zebraDpi: event.target.value === "300" ? 300 : 203 });
                setNote({ kind: "success", text: "Saved for this computer." });
              }}
            >
              <option value="203">203 dpi (most Zebras)</option>
              <option value="300">300 dpi</option>
            </Select>
          </div>
          <label className="flex items-start gap-2">
            <input
              type="checkbox"
              className="mt-1"
              checked={settings.slips}
              onChange={(event) => {
                save({ slips: event.target.checked });
                setNote({ kind: "success", text: "Saved for this computer." });
              }}
            />
            <span>
              Offer to send packing slips to the Zebra too
              <span className="text-muted-foreground block text-xs">
                They print on the same 4 × 6 labels. Printing through the browser stays there as
                well.
              </span>
            </span>
          </label>
        </>
      )}
      <FormMessage kind={note?.kind ?? "success"}>{note?.text}</FormMessage>
    </div>
  );
}

// ---------------------------------------------------------------------------
// A bought label: straight to the Zebra, or opened to print as always
// ---------------------------------------------------------------------------

export type LabelLink = { href: string; text: string };

/**
 * The ways to print one parcel's label. On a computer set to browser
 * printing this is the links it has always been. On one set to a Zebra the
 * label goes straight to the printer: by itself when it has just been bought
 * (`auto`), and on a button from then on, with a warning before a label that
 * was already printed comes out a second time.
 */
export function LabelPrint({
  slug,
  shipmentId,
  links,
  printedAt,
  printedText,
  auto = false,
  primary = false,
}: {
  slug: string;
  shipmentId: string;
  /** Each box's label to open in the browser: today's way, and the way out when the Zebra won't answer. */
  links: LabelLink[];
  /** When this label last went to a printer, on any computer. */
  printedAt: string | null;
  /** The same, as words in the workspace's own time. */
  printedText: string | null;
  /** Just bought: print it without being asked, once. */
  auto?: boolean;
  /** The main thing on the card, so its button is the filled one. */
  primary?: boolean;
}) {
  const [settings] = usePrintSettings();
  const zebra = settings.labels === "zebra";
  const [printing, setPrinting] = useState(false);
  const [note, setNote] = useState<Note>(null);
  const [printedHere, setPrintedHere] = useState(false);
  const running = useRef(false);
  const already = Boolean(printedAt) || printedHere;

  const print = useCallback(
    async (byItself: boolean) => {
      if (running.current) return;
      if (
        !byItself &&
        already &&
        !window.confirm(
          `This label was already printed${printedText ? ` (${printedText})` : ""}. Printing it again makes a second copy of the same label; only one of them can be used. Print it again?`,
        )
      ) {
        return;
      }
      running.current = true;
      setPrinting(true);
      setNote(null);
      try {
        const data = await getLabelPrintData(slug, shipmentId);
        if (data.error || !data.labels) {
          setNote({ kind: "error", text: data.error ?? "We couldn't load that label. Try again." });
          return;
        }
        // Someone else's computer got there first: one copy is enough.
        if (byItself && data.printedAt) return;
        const missing = data.unprintable ?? 0;
        if (data.labels.length === 0) {
          setNote({
            kind: "error",
            text: "This label isn't in a form we can send to the Zebra from here. Open it below and print it the ordinary way.",
          });
          return;
        }
        const jobs = await labelsToZpl(data.labels, settings.zebraDpi);
        const { device, labels } = await createZebraClient().send(
          jobs.join("\n"),
          settings.zebraName,
        );
        setPrintedHere(true);
        const marked = await markLabelPrinted(slug, shipmentId).catch(() => null);
        setNote({
          kind: missing > 0 || marked?.error ? "error" : "success",
          text: `${labels === 1 ? "Label" : `${labels} labels`} sent to ${device.name}.${
            missing > 0
              ? ` ${missing === 1 ? "One box's label" : `${missing} boxes' labels`} couldn't go to the Zebra: open ${missing === 1 ? "it" : "them"} below and print the ordinary way.`
              : ""
          }`,
        });
      } catch (err) {
        const partly = err instanceof ZebraError && err.printed > 0;
        setNote({
          kind: "error",
          text: `${said(err, "The label didn't reach the printer.")} ${
            partly ? "" : "Nothing printed. "
          }Your label is bought and safe here: press Print again when the printer is ready, or open it below.`,
        });
      } finally {
        running.current = false;
        setPrinting(false);
      }
    },
    [slug, shipmentId, already, printedText, settings.zebraDpi, settings.zebraName],
  );

  // Just bought on a computer with a Zebra: print by itself, once, even if this page is shown again.
  const started = useRef(false);
  useEffect(() => {
    if (!zebra || !auto || printedAt || started.current) return;
    started.current = true;
    const key = `zebra-auto:${shipmentId}`;
    try {
      if (window.sessionStorage.getItem(key)) return;
      window.sessionStorage.setItem(key, "1");
    } catch {
      // No session storage: the note in the database still stops a second copy after a reload.
    }
    const timer = window.setTimeout(() => void print(true), 0);
    return () => window.clearTimeout(timer);
  }, [zebra, auto, printedAt, shipmentId, print]);

  const openLinks = (from: number) =>
    links.slice(from).map((link) => (
      <a
        key={link.href}
        href={link.href}
        target="_blank"
        rel="noopener noreferrer"
        className={`${linkClass} text-sm`}
      >
        {link.text}
      </a>
    ));

  return (
    <span className="flex flex-wrap items-center gap-x-4 gap-y-2">
      {zebra ? (
        <>
          <Button
            type="button"
            variant={primary ? "default" : "outline"}
            size={primary ? "default" : "sm"}
            onClick={() => void print(false)}
            disabled={printing}
          >
            <Printer aria-hidden />
            {printing ? "Sending to the Zebra…" : already ? "Print again" : "Print to Zebra"}
          </Button>
          {openLinks(0)}
        </>
      ) : (
        <>
          {primary && links[0] ? (
            <Button asChild>
              <a href={links[0].href} target="_blank" rel="noopener noreferrer">
                {links[0].text}
              </a>
            </Button>
          ) : null}
          {openLinks(primary ? 1 : 0)}
        </>
      )}
      {printedText && !printedHere && (
        <span className="text-muted-foreground text-xs">Printed {printedText}</span>
      )}
      {note && (
        <span className="w-full">
          <FormMessage kind={note.kind}>{note.text}</FormMessage>
        </span>
      )}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Packing slips
// ---------------------------------------------------------------------------

/** Sends the slips on this page to the Zebra as 4 × 6 labels. Only shown on a computer set up for one. */
export function ZebraSlipsButton({ slips }: { slips: SlipData[] }) {
  const [settings] = usePrintSettings();
  const [printing, setPrinting] = useState(false);
  const [note, setNote] = useState<Note>(null);
  if (settings.labels !== "zebra" || !settings.slips || slips.length === 0) return null;

  const print = async () => {
    setPrinting(true);
    setNote(null);
    try {
      const zpl = slips.map((slip) => slipZpl(slip, settings.zebraDpi)).join("\n");
      const { device } = await createZebraClient().send(zpl, settings.zebraName);
      setNote({
        kind: "success",
        text: `${slips.length === 1 ? "Slip" : `${slips.length} slips`} sent to ${device.name}.`,
      });
    } catch (err) {
      setNote({
        kind: "error",
        text: `${said(err, "The slips didn't reach the printer.")} You can still use Print these.`,
      });
    } finally {
      setPrinting(false);
    }
  };

  return (
    <>
      <Button type="button" variant="outline" size="sm" onClick={print} disabled={printing}>
        <Printer aria-hidden /> {printing ? "Sending…" : "Print on the Zebra"}
      </Button>
      {note && (
        <span className="w-full print:hidden">
          <FormMessage kind={note.kind}>{note.text}</FormMessage>
        </span>
      )}
    </>
  );
}

/** A word under the Buy button about where the label will come out, on a computer with a Zebra. */
export function PrintsToZebraNote() {
  const [settings] = usePrintSettings();
  if (settings.labels !== "zebra") return null;
  return (
    <span className="text-muted-foreground text-xs">
      Prints on {settings.zebraName || "your Zebra"} as soon as it&apos;s bought.
    </span>
  );
}
