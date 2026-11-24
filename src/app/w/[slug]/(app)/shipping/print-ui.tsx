"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { Printer } from "lucide-react";
import { Button } from "@/components/ui/button";
import { FormMessage } from "@/components/ui/form-message";
import { Label, Select } from "@/components/ui/input";
import {
  ZEBRA_DOWNLOAD_LINK,
  ZEBRA_TRUST_LINK,
  ZebraError,
  zebraClient,
  type ZebraCheck,
  type ZebraDevice,
} from "@/lib/shipping/zebra/client";
import { labelsToZpl } from "@/lib/shipping/zebra/labels";
import { PdfLabelError } from "@/lib/shipping/zebra/pdf";
import { reprintQuestion } from "@/lib/shipping/zebra/reprint";
import { slipZpl } from "@/lib/shipping/zebra/slip";
import { slipsGoToZebra } from "@/lib/shipping/zebra/settings";
import { usePrintSettings } from "@/lib/shipping/zebra/use-print-settings";
import { testLabelZpl } from "@/lib/shipping/zebra/zpl";
import {
  getLabelPrintData,
  getSlipPrintData,
  markLabelPrinted,
  noteSlipsPrinted,
} from "./print-actions";
import type { SlipPrinted, SlipSelection, SlipToPrint } from "./slips-data";

const linkClass = "text-ochre-text font-medium hover:underline";
type Note = { kind: "error" | "success"; text: string } | null;

const said = (err: unknown, fallback: string) =>
  err instanceof ZebraError || err instanceof PdfLabelError ? err.message : fallback;

/** Where this computer's printing is set, as a link straight to that part of Shipping settings. */
export const printingSettingsHref = (slug: string) => `/w/${slug}/shipping/settings#printing`;

const never = () => () => undefined;
/** False on the server and while the page wakes up, so nothing about this computer is guessed. */
const useAwake = () =>
  useSyncExternalStore(
    never,
    () => true,
    () => false,
  );

/**
 * Beside a print button on a computer that prints through the browser: a
 * plain word that it could go straight to a Zebra, and where to set that up.
 * Says nothing on a computer already set to one.
 */
export function BrowserPrintingHint({ slug }: { slug: string }) {
  const [settings] = usePrintSettings();
  const awake = useAwake();
  if (!awake || settings.labels === "zebra") return null;
  return (
    <span className="text-muted-foreground text-xs print:hidden">
      This computer prints through the browser. Print straight to a Zebra?{" "}
      <Link href={printingSettingsHref(slug)} className={linkClass}>
        Set it up
      </Link>
    </span>
  );
}

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
  const [busy, setBusy] = useState<"look" | "find" | "test" | "check" | "reset" | null>(null);
  const [note, setNote] = useState<Note>(null);
  const [checks, setChecks] = useState<ZebraCheck[] | null>(null);
  const zebra = settings.labels === "zebra";

  // Only ever on a press: a browser may ask the person before a page talks to apps on their computer.
  const look = async () => {
    setBusy("look");
    setNote(null);
    setChecks(null);
    try {
      const found = await zebraClient().findPrinters();
      setPrinters(found);
      const kept = found.find((device) => device.name === settings.zebraName) ?? found[0];
      save({ labels: "zebra", zebraName: kept.name });
      setNote({
        kind: "success",
        text: `Found ${kept.name}${found.length > 1 ? ` and ${found.length - 1} more` : ""}. This computer now sends labels and packing slips straight to it. Print a test label to check.`,
      });
    } catch (err) {
      setNote({
        kind: "error",
        text: `${said(err, "We couldn't look for a Zebra. Try again.")} Nothing was changed: this computer still prints through the browser.`,
      });
    } finally {
      setBusy(null);
    }
  };

  const check = async () => {
    setBusy("check");
    setNote(null);
    try {
      setChecks(await zebraClient().diagnose(settings.zebraName));
    } catch {
      setChecks(null);
      setNote({ kind: "error", text: "We couldn't check the connection. Try again." });
    } finally {
      setBusy(null);
    }
  };

  const reset = async () => {
    setBusy("reset");
    setNote(null);
    try {
      const device = await zebraClient().reset(settings.zebraName);
      setNote({
        kind: "success",
        text: `Cleared anything stuck in ${device.name} and took it out of pause. Nothing was printed.`,
      });
    } catch (err) {
      setNote({ kind: "error", text: said(err, "The printer didn't take the reset. Try again.") });
    } finally {
      setBusy(null);
    }
  };

  const find = async () => {
    setBusy("find");
    setNote(null);
    setChecks(null);
    try {
      const found = await zebraClient().findPrinters();
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
      const { device } = await zebraClient().send(testLabelZpl(workspaceName), settings.zebraName);
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
              setChecks(null);
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
              Labels and packing slips go straight to the Zebra on one press, with no print window.
              Needs Zebra Browser Print (free) installed and running on this computer.
            </span>
          </span>
        </label>
      </fieldset>

      {!zebra && (
        <div className="flex flex-col gap-1.5">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="w-fit"
            onClick={look}
            disabled={busy !== null}
          >
            <Printer aria-hidden />
            {busy === "look" ? "Looking…" : "Look for a Zebra on this computer"}
          </Button>
          <p className="text-muted-foreground text-xs">
            If one is found, this computer is switched to it and you can print a test label. Your
            browser may ask whether this site can reach apps or devices on this computer: choose
            Allow.
          </p>
        </div>
      )}

      {zebra && (
        <>
          <ol className="text-muted-foreground flex list-decimal flex-col gap-1 pl-5 text-xs">
            <li>
              Install{" "}
              <a
                href={ZEBRA_DOWNLOAD_LINK}
                target="_blank"
                rel="noopener noreferrer"
                className={linkClass}
              >
                Zebra Browser Print
              </a>{" "}
              on this computer and set your label printer as its default.
            </li>
            <li>
              Open{" "}
              <a
                href={ZEBRA_TRUST_LINK}
                target="_blank"
                rel="noopener noreferrer"
                className={linkClass}
              >
                localhost:9101/ssl_support
              </a>{" "}
              once in this browser and accept it, so this page may talk to it.
            </li>
            <li>Press Find printers, then print a test label.</li>
          </ol>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={find}
              disabled={busy !== null}
            >
              {busy === "find" ? "Looking…" : "Find printers"}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={test}
              disabled={busy !== null}
            >
              <Printer aria-hidden /> {busy === "test" ? "Sending…" : "Print test label"}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={check}
              disabled={busy !== null}
            >
              {busy === "check" ? "Checking…" : "Check the connection"}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={reset}
              disabled={busy !== null}
              title="Clears stuck or half-sent labels and takes the printer out of pause. Prints nothing."
            >
              {busy === "reset" ? "Resetting…" : "Reset printer"}
            </Button>
          </div>
          {checks && (
            <ul className="flex flex-col gap-1 text-xs" aria-label="Connection check">
              {checks.map((line, index) => (
                <li key={index} className={line.ok ? "text-muted-foreground" : "text-brick"}>
                  <span className="font-semibold">{line.ok ? "OK" : "Problem"}:</span> {line.text}
                </li>
              ))}
            </ul>
          )}
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
              Send packing slips to the Zebra too
              <span className="text-muted-foreground block text-xs">
                They print on the same 4 × 6 labels, on one press. “Print on paper” stays there as a
                second choice.
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
            text: "We don't hold this label's file here, so it can't go to the Zebra. Open it below and print it the ordinary way.",
          });
          return;
        }
        const jobs = await labelsToZpl(data.labels, settings.zebraDpi);
        const { device, labels } = await zebraClient().send(jobs.join("\n"), settings.zebraName);
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
          text: `${said(err, "The label didn't reach the printer.")} Your label is bought and safe here${
            partly ? ", and nothing was bought twice" : ""
          }: press the print button again when the printer is ready, or open it below.`,
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
    // Not cancelled if this renders again: the two guards above already make it once only.
    window.setTimeout(() => void print(true), 0);
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
      {!zebra && primary && links.length > 0 && <BrowserPrintingHint slug={slug} />}
      {!zebra && links.length === 0 && (
        <span className="text-muted-foreground text-xs">
          This label&apos;s file isn&apos;t kept here. Print it from the account it was bought on.
        </span>
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

type Choice = "new" | "again" | "cancel";
type Asking = {
  title: string;
  lines: string[];
  /** How many haven't been printed yet; none means there is only "print again". */
  fresh: number;
  answer: (choice: Choice) => void;
};

/** Slips that were printed before: print them again, only the new ones, or nothing. */
function ReprintDialog({ asking }: { asking: Asking | null }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!asking || !dialog) return;
    if (!dialog.open) dialog.showModal();
    return () => {
      if (dialog.open) dialog.close();
    };
  }, [asking]);
  if (!asking) return null;
  return (
    <dialog
      ref={ref}
      aria-labelledby="reprint-title"
      className="fixed inset-0 m-0 grid h-full max-h-none w-full max-w-none place-items-center bg-transparent p-4 backdrop:bg-black/50"
      onCancel={(event) => {
        event.preventDefault();
        asking.answer("cancel");
      }}
    >
      <div className="bg-card text-foreground border-border flex w-full max-w-md flex-col gap-3 rounded-lg border p-5 text-left text-sm shadow-lg">
        <p id="reprint-title" className="text-base font-bold">
          {asking.title}
        </p>
        <ul className="list-disc pl-5">
          {asking.lines.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
        <p className="text-muted-foreground text-xs">Printing again makes a duplicate slip.</p>
        <div className="flex flex-wrap items-center gap-2">
          {asking.fresh > 0 && (
            <Button type="button" size="sm" onClick={() => asking.answer("new")}>
              Print only the {asking.fresh} new {asking.fresh === 1 ? "one" : "ones"}
            </Button>
          )}
          <Button
            type="button"
            size="sm"
            variant={asking.fresh > 0 ? "outline" : "default"}
            onClick={() => asking.answer("again")}
          >
            {asking.fresh > 0 ? "Print all again" : "Print again"}
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={() => asking.answer("cancel")}>
            Cancel
          </Button>
        </div>
      </div>
    </dialog>
  );
}

/** The slips a press is about: already in hand (the slips page), or to be asked for by the link's own choice. */
type SlipSource = { slips: SlipToPrint[]; printed: SlipPrinted[] } | SlipSelection;

/**
 * Sends packing slips straight to this computer's Zebra: no window, no print
 * box. Slips printed before are asked about first; what goes out is noted as
 * printed, so the next run leaves it out.
 */
function useSlipPrinter(slug: string) {
  const [settings] = usePrintSettings();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Note>(null);
  const [asking, setAsking] = useState<Asking | null>(null);
  const running = useRef(false);
  const zebra = slipsGoToZebra(settings);

  const print = async (source: SlipSource) => {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setNote(null);
    try {
      const data = "slips" in source ? source : await getSlipPrintData(slug, source);
      if (("error" in data && data.error) || !data.slips) {
        setNote({
          kind: "error",
          text: ("error" in data && data.error) || "We couldn't load those slips. Try again.",
        });
        return;
      }
      let slips = data.slips;
      if (slips.length === 0) {
        setNote({ kind: "error", text: "Nothing there is waiting for a slip." });
        return;
      }
      const question = reprintQuestion(slips, data.printed ?? []);
      if (question) {
        const choice = await new Promise<Choice>((answer) =>
          setAsking({
            title: question.title,
            lines: question.lines,
            fresh: question.freshOrders,
            answer,
          }),
        );
        setAsking(null);
        if (choice === "cancel") return;
        if (choice === "new") slips = question.fresh;
        if (slips.length === 0) return;
      }
      const zpl = slips.map((slip) => slipZpl(slip.data, settings.zebraDpi)).join("\n");
      const { device } = await zebraClient().send(zpl, settings.zebraName);
      const marked = await noteSlipsPrinted(slug, [
        ...new Set(slips.flatMap((slip) => slip.orderIds)),
      ]).catch(() => ({ error: "They printed, but we couldn't note that here." }));
      setNote({
        kind: marked.error ? "error" : "success",
        text: `${slips.length === 1 ? "Packing slip" : `${slips.length} packing slips`} sent to ${device.name}.${marked.error ? ` ${marked.error}` : ""}`,
      });
    } catch (err) {
      const partly = err instanceof ZebraError && err.printed > 0;
      setNote({
        kind: "error",
        text: `${said(err, "The slips didn't reach the printer.")}${partly ? " None of them was marked as printed." : ""} You can still print them on paper.`,
      });
    } finally {
      running.current = false;
      setBusy(false);
    }
  };

  return { zebra, busy, note, print, dialog: <ReprintDialog asking={asking} /> };
}

/**
 * The buttons at the top of the slips page. On a computer set to a Zebra the
 * main one sends every slip on the page straight to it, and printing through
 * the browser is the quiet second choice. Anywhere else the main one is the
 * browser's own print, with a word about setting up a Zebra.
 */
export function SlipsPagePrint({
  slug,
  slips,
  printed,
}: {
  slug: string;
  slips: SlipToPrint[];
  printed: SlipPrinted[];
}) {
  const printer = useSlipPrinter(slug);
  if (slips.length === 0) return null;
  const many = slips.length !== 1;
  return (
    <>
      {printer.zebra ? (
        <>
          <Button
            type="button"
            size="sm"
            title="Sends straight to this computer's Zebra"
            onClick={() => void printer.print({ slips, printed })}
            disabled={printer.busy}
          >
            <Printer aria-hidden />
            {printer.busy ? "Sending to the Zebra…" : many ? "Print these" : "Print this"}
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={() => window.print()}>
            Print on paper
          </Button>
        </>
      ) : (
        <Button type="button" size="sm" onClick={() => window.print()}>
          <Printer aria-hidden /> {many ? "Print these" : "Print this"}
        </Button>
      )}
      {printer.dialog}
      {printer.note && (
        <span className="w-full print:hidden">
          <FormMessage kind={printer.note.kind}>{printer.note.text}</FormMessage>
        </span>
      )}
    </>
  );
}

/**
 * A "Packing slip" button anywhere else (an order's page, the ticked orders
 * in the queue). On a computer set to a Zebra it prints them then and there;
 * anywhere else it opens the slips page, as it always has.
 */
export function SlipsButton({
  slug,
  href,
  selection,
  variant = "outline",
  title,
  children,
}: {
  slug: string;
  /** The slips page for the same slips: the link on a browser-printing computer, and the way out here. */
  href: string;
  selection: SlipSelection;
  variant?: "default" | "outline";
  title?: string;
  children: React.ReactNode;
}) {
  const printer = useSlipPrinter(slug);
  if (!printer.zebra) {
    return (
      <Button asChild variant={variant} size="sm">
        <Link href={href} title={title}>
          {children}
        </Link>
      </Button>
    );
  }
  return (
    <>
      <Button
        type="button"
        variant={variant}
        size="sm"
        title={title ?? "Sends straight to this computer's Zebra"}
        onClick={() => void printer.print(selection)}
        disabled={printer.busy}
      >
        <Printer aria-hidden />
        {printer.busy ? "Sending…" : children}
      </Button>
      {printer.dialog}
      {printer.note && (
        <span className="w-full">
          <FormMessage kind={printer.note.kind}>
            {printer.note.text}{" "}
            {printer.note.kind === "error" && (
              <Link href={href} className="font-semibold underline">
                Open the slips
              </Link>
            )}
          </FormMessage>
        </span>
      )}
    </>
  );
}

/** A word under the Buy button about where the label will come out, on a computer with a Zebra. */
export function PrintsToZebraNote({ fallback }: { fallback?: string }) {
  const [settings] = usePrintSettings();
  if (settings.labels !== "zebra") {
    return fallback ? <span className="text-muted-foreground text-xs">{fallback}</span> : null;
  }
  return (
    <span className="text-muted-foreground text-xs">
      Prints on {settings.zebraName || "your Zebra"} as soon as it&apos;s bought.
    </span>
  );
}
