import { ZebraError, createZebraClient } from "@/lib/shipping/zebra/client";
import { labelsToZpl } from "@/lib/shipping/zebra/labels";
import { PdfLabelError } from "@/lib/shipping/zebra/pdf";
import type { PrintSettings } from "@/lib/shipping/zebra/settings";
import { getLabelPrintData, markLabelPrinted } from "./print-actions";

/**
 * Sends one parcel's label to this computer's Zebra, for the places that
 * print several one after another (a bulk run, printing a run again). Runs in
 * the browser. Never throws: a label that won't print is said in words, and
 * is still bought and safe.
 */
export type SentToZebra = { ok: true; text: string } | { ok: false; text: string };

export async function sendLabelToZebra(
  slug: string,
  shipmentId: string,
  settings: PrintSettings,
  /** Leave it be when it has already been printed somewhere (a run prints each label once). */
  onlyIfNew = false,
): Promise<SentToZebra> {
  try {
    const data = await getLabelPrintData(slug, shipmentId);
    if (data.error || !data.labels) {
      return { ok: false, text: data.error ?? "We couldn't load that label." };
    }
    if (onlyIfNew && data.printedAt) return { ok: true, text: "Already printed" };
    if (data.labels.length === 0) {
      return { ok: false, text: "We don't hold this label's file, so open it and print it." };
    }
    const jobs = await labelsToZpl(data.labels, settings.zebraDpi);
    const { device } = await createZebraClient().send(jobs.join("\n"), settings.zebraName);
    await markLabelPrinted(slug, shipmentId).catch(() => null);
    const missing = data.unprintable ?? 0;
    return missing > 0
      ? {
          ok: false,
          text: `Sent to ${device.name}, but ${missing === 1 ? "one box's label" : `${missing} boxes' labels`} couldn't go: open the label to print the rest.`,
        }
      : { ok: true, text: `Sent to ${device.name}` };
  } catch (err) {
    return {
      ok: false,
      text:
        err instanceof ZebraError || err instanceof PdfLabelError
          ? err.message
          : "The label didn't reach the printer.",
    };
  }
}
