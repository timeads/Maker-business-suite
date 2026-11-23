import type { Fetch } from "../../connections/types";
import {
  MAX_BOXES,
  buyLabel as buyEasyPostLabel,
  buyOrder as buyEasyPostOrder,
  getPurchase as getEasyPostPurchase,
  getRates as getEasyPostRates,
  refundLabels as refundEasyPostLabels,
  type BoughtLabel,
} from "../easypost";
import {
  REDO_TOGETHER_MAX,
  buyRedo,
  downloadRedoLabel,
  getRedoRates,
  readSigOption,
  redoSignatureOption,
  voidRedo,
  type RedoAccess,
} from "./redo";
import {
  CannotLookUpError,
  SOURCE_NAMES,
  SourceError,
  shortHash,
  type LabelFile,
  type LabelSource,
  type LabelSourceKey,
  type SourceLabel,
  type SourceRate,
} from "./types";
import { createUpsShipment, getUpsRates, voidUpsShipment, type UpsAccess } from "./ups";

/** What each source needs to sign in. Read from Vault by the caller, never kept here. */
export type SourceAccess = {
  easypost: { key: string };
  ups: UpsAccess;
  redo: RedoAccess;
};

/** A rate id of our own, for sources that have none: it belongs to one quote and one service. */
const rateId = (source: LabelSourceKey, quoteRef: string, ...parts: string[]) =>
  `${source}rate_${shortHash([quoteRef, ...parts].join("\n"))}`;

const fromEasyPost = (label: BoughtLabel): SourceLabel => ({
  ...label,
  source: "easypost",
  files: [],
});

/**
 * EasyPost, exactly as before: it keeps what was quoted on its own side, so
 * buying names its ids and a purchase we never heard back about can be
 * looked up.
 */
export function easypostSource(fetchImpl: Fetch = fetch): LabelSource<SourceAccess["easypost"]> {
  return {
    key: "easypost",
    name: SOURCE_NAMES.easypost,
    canLookUp: true,
    maxBoxes: MAX_BOXES,
    async quote(access, request) {
      const quote = await getEasyPostRates(access.key, request, fetchImpl);
      return {
        shipmentId: quote.shipmentId,
        mode: quote.mode,
        rates: quote.rates.map((rate) => ({
          ...rate,
          source: "easypost" as const,
          ref: { shipment_id: quote.shipmentId, kind: quote.kind },
        })),
      };
    },
    async buy(access, purchase) {
      return fromEasyPost(
        purchase.kind === "order"
          ? await buyEasyPostOrder(
              access.key,
              purchase.shipmentId,
              {
                // EasyPost's own codes, from the quote the server kept.
                carrierCode: String(purchase.rate.carrierCode ?? ""),
                service: String(purchase.rate.service ?? ""),
              },
              fetchImpl,
            )
          : await buyEasyPostLabel(access.key, purchase.shipmentId, purchase.rate.id, fetchImpl),
      );
    },
    async lookUp(access, what) {
      const { label } = await getEasyPostPurchase(access.key, what.kind, what.shipmentId, fetchImpl);
      return { label: label ? fromEasyPost(label) : null };
    },
    refund: (access, shipmentIds) => refundEasyPostLabels(access.key, shipmentIds, fetchImpl),
  };
}

const NEEDS_REQUEST = "Those rates have run out. Press Get rates again, then choose one.";

/**
 * The business's own UPS account. Several boxes go as one shipment with a
 * label each. UPS keeps nothing between the quote and the purchase, so the
 * server rebuilds the request; and it has no way (here) to be asked what
 * became of a purchase.
 */
export function upsSource(fetchImpl: Fetch = fetch): LabelSource<UpsAccess> {
  return {
    key: "ups",
    name: SOURCE_NAMES.ups,
    canLookUp: false,
    maxBoxes: MAX_BOXES,
    async quote(access, request, quoteRef) {
      const rates = await getUpsRates(access, request, fetchImpl);
      return {
        shipmentId: null,
        mode: access.test ? "test" : null,
        rates: rates.map(
          (rate): SourceRate => ({
            id: rateId("ups", quoteRef, rate.serviceCode),
            carrier: "UPS",
            carrierCode: "UPS",
            service: rate.serviceCode,
            name: rate.name,
            price: rate.price,
            currency: rate.currency,
            days: rate.days,
            source: "ups",
            ref: { service_code: rate.serviceCode },
          }),
        ),
      };
    },
    async buy(access, purchase) {
      const code = String(purchase.rate.ref?.service_code ?? "");
      if (!purchase.request || !code) throw new SourceError(NEEDS_REQUEST, null, false);
      const made = await createUpsShipment(access, purchase.request, code, fetchImpl);
      const boxes = made.boxes.map((box) => ({
        // One shipment covers every box: voiding it voids them all.
        shipmentId: made.shipmentId,
        trackingCode: box.trackingNumber,
        labelUrl: null,
      }));
      return {
        source: "ups",
        shipmentId: made.shipmentId,
        kind: purchase.kind,
        trackingCode: boxes[0]?.trackingCode ?? "",
        labelUrl: null,
        boxes,
        carrier: "UPS",
        service: code,
        name: String(purchase.rate.name ?? "UPS"),
        price: made.price,
        currency: made.currency,
        mode: access.test ? "test" : "live",
        files: made.boxes.flatMap((box, index): LabelFile[] =>
          box.label ? [{ box: index + 1, contentType: "image/gif", data: box.label }] : [],
        ),
      };
    },
    async lookUp() {
      throw new CannotLookUpError("ups");
    },
    async refund(access, shipmentIds) {
      let asked = 0;
      let failed = 0;
      let error: unknown = null;
      for (const id of [...new Set(shipmentIds)]) {
        try {
          await voidUpsShipment(access, id, fetchImpl);
          asked += 1;
        } catch (err) {
          failed += 1;
          error ??= err;
        }
      }
      return { asked, failed, error };
    },
  };
}

/**
 * Redo. Up to five boxes can go in one carrier shipment where the carrier
 * allows; otherwise each box is its own shipment, bought one after another.
 * Like UPS, Redo can't be asked what became of a purchase, but each purchase
 * carries a key of ours so the same one is never made twice.
 */
export function redoSource(fetchImpl: Fetch = fetch): LabelSource<RedoAccess> {
  return {
    key: "redo",
    name: SOURCE_NAMES.redo,
    canLookUp: false,
    maxBoxes: MAX_BOXES,
    async quote(access, request, quoteRef) {
      // A price without the signature that was asked for would be the wrong price.
      if (request.signature !== "none" && !(await redoSignatureOption(access, fetchImpl))) {
        return {
          shipmentId: null,
          mode: null,
          rates: [],
          note: "Redo can't add a signature to a label from here, so its prices are left out when one is needed.",
        };
      }
      const rates = await getRedoRates(access, request, fetchImpl);
      return {
        shipmentId: null,
        mode: null,
        rates: rates.map(
          (rate): SourceRate => ({
            id: rateId(
              "redo",
              quoteRef,
              rate.mode,
              rate.carrierAccountId,
              rate.carrierCode,
              rate.service,
            ),
            carrier: rate.carrier,
            carrierCode: rate.carrierCode,
            service: rate.service,
            name: rate.name,
            price: rate.price,
            currency: rate.currency,
            days: rate.days,
            source: "redo",
            ref: {
              mode: rate.mode,
              account: rate.carrierAccountId,
              ...(rate.signature ? { signature: JSON.stringify(rate.signature) } : {}),
            },
            ...(rate.note ? { note: rate.note } : {}),
          }),
        ),
      };
    },
    async buy(access, purchase) {
      const ref = purchase.rate.ref ?? {};
      if (!purchase.request) throw new SourceError(NEEDS_REQUEST, null, false);
      let signature = null;
      if (ref.signature) {
        try {
          signature = readSigOption(JSON.parse(ref.signature));
        } catch {
          signature = null;
        }
      }
      const made = await buyRedo(
        access,
        purchase.request,
        {
          mode: ref.mode === "n" ? "n" : "1",
          carrierAccountId: String(ref.account ?? ""),
          carrierCode: String(purchase.rate.carrierCode ?? ""),
          service: String(purchase.rate.service ?? ""),
        },
        // Ours, and the same for every try at this quote.
        purchase.quoteId,
        signature,
        fetchImpl,
      );
      // The money is spent. A label file we can't fetch is still at Redo, and its link is kept.
      const files: LabelFile[] = [];
      for (const [index, box] of made.boxes.entries()) {
        if (!box.labelUrl) continue;
        const file = await downloadRedoLabel(access, box.labelUrl, fetchImpl);
        if (file) files.push({ box: index + 1, ...file });
      }
      const boxes = made.boxes.map((box) => ({
        shipmentId: box.shipmentId,
        trackingCode: box.trackingNumber,
        labelUrl: box.labelUrl,
      }));
      return {
        source: "redo",
        shipmentId: boxes[0]?.shipmentId ?? "",
        kind: purchase.kind,
        trackingCode: boxes[0]?.trackingCode ?? "",
        labelUrl: boxes[0]?.labelUrl ?? null,
        boxes,
        carrier: String(purchase.rate.carrier ?? "Carrier"),
        service: made.service,
        name: String(purchase.rate.name ?? made.service),
        price: made.price,
        currency: made.currency,
        mode: "live",
        files,
      };
    },
    async lookUp() {
      throw new CannotLookUpError("redo");
    },
    refund: (access, shipmentIds) => voidRedo(access, shipmentIds, fetchImpl),
  };
}

export { REDO_TOGETHER_MAX };

type Sources = { [K in LabelSourceKey]: LabelSource<SourceAccess[K]> };

/** Every place postage can be bought, by key. */
export function labelSources(fetchImpl: Fetch = fetch): Sources {
  return {
    easypost: easypostSource(fetchImpl),
    ups: upsSource(fetchImpl),
    redo: redoSource(fetchImpl),
  };
}

export const labelSource = <K extends LabelSourceKey>(key: K, fetchImpl: Fetch = fetch) =>
  labelSources(fetchImpl)[key];
