"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { ReconnectRequiredError } from "@/lib/connections/types";
import { getEntitlements } from "@/lib/entitlements";
import { trackingUrl } from "@/lib/shipping/carriers";
import {
  EasyPostError,
  MAX_BOXES,
  isLabelKind,
  isSignature,
  serviceWithoutCarrier,
  verifyAddress,
  type AddressCheck,
  type LabelKind,
} from "@/lib/shipping/easypost";
import {
  getLabelAccess,
  matchesFingerprint,
  requestFingerprint,
  withLabelSource,
  type Held,
} from "@/lib/shipping/label-access";
import { flagLabelKey } from "@/lib/shipping/label-key";
import {
  missingShipFrom,
  missingShipTo,
  parcelsFrom,
  parseInches,
  parseOunces,
  shipFromAddress,
  shipToAddress,
  withShipToEdit,
  type ShipToEdit,
  type SavedBox,
} from "@/lib/shipping/labels";
import { groupName, parseWith } from "@/lib/shipping/merge";
import { isInternational, todayIn } from "@/lib/shipping/queue";
import { labelSource } from "@/lib/shipping/sources";
import { mergeRates, sourceRateChoice, type SourceRateChoice } from "@/lib/shipping/sources/rates";
import {
  SOURCE_NAMES,
  SourceError,
  isLabelSource,
  type LabelRequest,
  type LabelSourceKey,
  type SourceLabel,
  type SourceQuote,
  type SourceRate,
} from "@/lib/shipping/sources/types";
import { upsChecksAddress, validateUpsAddress } from "@/lib/shipping/sources/ups";
import { getAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { canManage, getTenantContext } from "@/lib/tenants";
import type { ShippingState } from "./actions";
import {
  BOX_FIELDS,
  ORDER_FIELDS,
  loadGroup,
  loadLabelConnections,
  loadShippingSetup,
  type ShippingOrder,
} from "./data";

export type RatesState = {
  error?: string;
  /** One list from every connected source, cheapest first. */
  rates?: SourceRateChoice[];
  /** A short word on each source that couldn't be asked, so its prices are missing. */
  notes?: string[];
};
/** `bought`: money was spent. The screen must stop offering to buy. */
export type BuyState = { error?: string; bought?: boolean };

const NO_ACCESS = "Shipping isn't part of this workspace's plan right now.";
const NOT_ALLOWED = "Only owners and admins can do that.";
const READ_ONLY =
  "This workspace is read-only because its plan has ended. Pick a plan to make changes.";
const OOPS = "That didn't save. Please try again.";
const NOTHING_CONNECTED =
  "No postage account is connected. An owner or admin can connect EasyPost, UPS or Redo under Connections.";
const needsConnecting = (source: LabelSourceKey) =>
  `${SOURCE_NAMES[source]} needs connecting again. An owner or admin can do that under Connections.`;
const INTERNATIONAL =
  "International labels need a customs form, which isn't built yet. Buy this one elsewhere and record it below.";
const UUID = /^[0-9a-f-]{36}$/i;

async function context(slug: string, managersOnly = false) {
  const user = await requireUser(`/w/${slug}/shipping`);
  const ctx = await getTenantContext(slug, user.id);
  if (!ctx) return { error: NO_ACCESS } as const;
  const entitlements = await getEntitlements(ctx.tenant.id);
  if (!entitlements.can("module.shipping")) return { error: NO_ACCESS } as const;
  if (!entitlements.canWrite) return { error: READ_ONLY } as const;
  if (managersOnly && !canManage(ctx.role)) return { error: NOT_ALLOWED } as const;
  return { user, tenant: ctx.tenant, supabase: await createClient() } as const;
}

const text = (formData: FormData, name: string) => String(formData.get(name) ?? "").trim();
const done = (slug: string) => revalidatePath(`/w/${slug}/shipping`, "layout");

/** A source's sign-in for this workspace, or a sentence saying why there isn't one. */
async function labelAccess<K extends LabelSourceKey>(
  tenantId: string,
  source: K,
): Promise<Held<K> | { error: string }> {
  try {
    return await getLabelAccess(tenantId, source);
  } catch (err) {
    if (!(err instanceof ReconnectRequiredError)) {
      console.error(`${source} key read failed`, err instanceof Error ? err.message : err);
    }
    return { error: needsConnecting(source) };
  }
}

/** A plain "no" or "no answer" from a source, in words safe to show. */
const isSourceError = (err: unknown): err is EasyPostError | SourceError =>
  err instanceof EasyPostError || err instanceof SourceError;

/** A sentence for the person, whatever went wrong talking to a source. */
async function explain(
  err: unknown,
  connectionId: string,
  source: LabelSourceKey = "easypost",
): Promise<string> {
  if (err instanceof ReconnectRequiredError) {
    await flagLabelKey(connectionId, SOURCE_NAMES[source]);
    // What a source's own client says is written for people; anything else isn't.
    return /^[a-z]+ (is not connected|needs to be reconnected|has no)/.test(err.message)
      ? needsConnecting(source)
      : err.message;
  }
  if (isSourceError(err)) return err.message;
  console.error(`${source} call failed`, err instanceof Error ? err.message : err);
  return `Something went wrong talking to ${SOURCE_NAMES[source]}. Try again in a moment.`;
}

// ---------------------------------------------------------------------------
// Boxes
// ---------------------------------------------------------------------------

export async function saveBox(
  slug: string,
  _prev: ShippingState,
  formData: FormData,
): Promise<ShippingState> {
  const ctx = await context(slug, true);
  if ("error" in ctx) return { error: ctx.error };
  const name = text(formData, "name");
  const kind = text(formData, "kind") || "box";
  const length = parseInches(text(formData, "length"));
  const width = parseInches(text(formData, "width"));
  const height = parseInches(text(formData, "height"));
  const empty = parseOunces(text(formData, "empty_weight"));
  if (!name || name.length > 60) return { error: "Give the box a short name." };
  if (!["box", "envelope", "soft"].includes(kind)) return { error: OOPS };
  if (!(length && width && height)) {
    return { error: "Length, width and height are in inches, up to 108 each." };
  }
  if (empty === null) return { error: "The empty weight is in ounces, like 6 or 6.5." };
  const { error } = await ctx.supabase.rpc("save_shipping_box", {
    p_tenant_id: ctx.tenant.id,
    p_box_id: null,
    p_name: name,
    p_kind: kind,
    p_length_in: length,
    p_width_in: width,
    p_height_in: height,
    p_empty_weight_oz: empty,
    p_default: formData.get("default") === "on",
  });
  if (error) {
    return {
      error: error.message.includes("Too many")
        ? "That's a lot of boxes. Remove one you no longer use first."
        : OOPS,
    };
  }
  done(slug);
  return { message: `${name} added.` };
}

export async function makeDefaultBox(
  slug: string,
  boxId: string,
  _prev: ShippingState,
  _formData: FormData,
): Promise<ShippingState> {
  const ctx = await context(slug, true);
  if ("error" in ctx) return { error: ctx.error };
  if (!UUID.test(boxId)) return { error: OOPS };
  const { data } = await ctx.supabase
    .from("shipping_boxes")
    .select(BOX_FIELDS)
    .eq("tenant_id", ctx.tenant.id)
    .eq("id", boxId)
    .is("archived_at", null)
    .maybeSingle();
  const box = data as unknown as SavedBox | null;
  if (!box) return { error: OOPS };
  const { error } = await ctx.supabase.rpc("save_shipping_box", {
    p_tenant_id: ctx.tenant.id,
    p_box_id: box.id,
    p_name: box.name,
    p_kind: box.kind,
    p_length_in: box.length_in,
    p_width_in: box.width_in,
    p_height_in: box.height_in,
    p_empty_weight_oz: box.empty_weight_oz,
    p_default: true,
  });
  if (error) return { error: OOPS };
  done(slug);
  return { message: `${box.name} is your usual box now.` };
}

export async function archiveBox(
  slug: string,
  boxId: string,
  _prev: ShippingState,
  _formData: FormData,
): Promise<ShippingState> {
  const ctx = await context(slug, true);
  if ("error" in ctx) return { error: ctx.error };
  if (!UUID.test(boxId)) return { error: OOPS };
  const { error } = await ctx.supabase.rpc("archive_shipping_box", { p_id: boxId });
  if (error) return { error: OOPS };
  done(slug);
  return { message: "Removed." };
}

// ---------------------------------------------------------------------------
// Rates
// ---------------------------------------------------------------------------

/** One box as it stands on the screen. */
export type BoxInput = {
  /** A saved box's id, or empty for a size typed in. */
  boxId: string;
  length: string;
  width: string;
  height: string;
  weightLb: string;
  weightOz: string;
};

export type RatesInput = {
  /** One to six boxes; several are bought together as one purchase. */
  boxes: BoxInput[];
  /** The address boxes as they stand on the screen, for this label only. */
  shipTo?: ShipToEdit;
  residential?: boolean;
  /** "none", "signature" or "adult". */
  signature?: string;
  /** Other orders going in the same parcel; this order must be the oldest of them. */
  withIds?: string[];
};

const TOGETHER_CHANGED =
  "These orders can't go together any more. Go back to Shipping and open them again.";

type Ctx = Exclude<Awaited<ReturnType<typeof context>>, { error: string }>;
type Prepared = {
  stored: ShippingOrder;
  riders: string[];
  /** Both addresses, every box, the signature and the reference: what a carrier is asked. */
  request: LabelRequest;
};

/**
 * Builds what a carrier is asked from what is stored (the order, the
 * settings) and what is on the screen (boxes, weights, this label's address
 * changes). Used to get rates, and again when buying from a source that
 * keeps nothing on its side, so the same checks run both times.
 */
async function prepareRequest(
  ctx: Ctx,
  orderId: string,
  input: RatesInput,
): Promise<Prepared | { error: string }> {
  const [{ data }, setup] = await Promise.all([
    ctx.supabase
      .from("shipping_orders")
      .select(ORDER_FIELDS)
      .eq("tenant_id", ctx.tenant.id)
      .eq("id", orderId)
      .maybeSingle(),
    loadShippingSetup(ctx.supabase, ctx.tenant.id),
  ]);
  const stored = data as unknown as ShippingOrder | null;
  if (!stored) return { error: "We couldn't find that order." };
  if (stored.cancelled) return { error: "This order was cancelled, so there's nothing to send." };
  if (stored.units_left <= 0) return { error: "Everything on this order has already been sent." };
  const home = setup.settings.ship_from_country;
  // Several orders in one parcel: checked again here, and again when buying.
  const riders = parseWith((Array.isArray(input.withIds) ? input.withIds : []).join(","), orderId);
  let reference = stored.name ?? undefined;
  if (riders.length > 0) {
    const group = await loadGroup(
      ctx.supabase,
      ctx.tenant.id,
      [stored.id, ...riders],
      todayIn(ctx.tenant.timezone, new Date()),
    );
    if (!group.check.ok) {
      return {
        error: group.check.reason === "mismatch" ? TOGETHER_CHANGED : group.check.message,
      };
    }
    // The label goes on the oldest order, with its address.
    if (group.orders[0].id !== stored.id) return { error: TOGETHER_CHANGED };
    reference = groupName(group.orders);
  }
  if (isInternational(stored.country_code, home)) return { error: INTERNATIONAL };
  // What a person changed on the screen goes on this label and nowhere else.
  const order = withShipToEdit(stored, input.shipTo);
  if (!order) return { error: "That address doesn't look right. Check each box and try again." };
  const fromGaps = missingShipFrom(setup.settings);
  if (fromGaps.length > 0) {
    return {
      error: `Your ship-from address is missing: ${fromGaps.join(", ")}. Add it in Shipping settings.`,
    };
  }
  const toGaps = missingShipTo(order);
  if (toGaps.length > 0) {
    return {
      error: `The address is missing ${toGaps.join(", ")}. Fill it in under Ship to.`,
    };
  }

  const asked = Array.isArray(input.boxes) ? input.boxes : [];
  if (asked.length < 1 || asked.some((box) => !box || typeof box !== "object")) {
    return { error: "Add a box first." };
  }
  if (asked.length > MAX_BOXES) {
    return { error: `One label purchase covers up to ${MAX_BOXES} boxes.` };
  }
  const boxIds = [...new Set(asked.map((box) => String(box.boxId ?? "")).filter(Boolean))];
  if (boxIds.some((id) => !UUID.test(id))) return { error: "Pick a box." };
  const saved = new Map<string, SavedBox>();
  if (boxIds.length > 0) {
    const { data: rows } = await ctx.supabase
      .from("shipping_boxes")
      .select(BOX_FIELDS)
      .eq("tenant_id", ctx.tenant.id)
      .in("id", boxIds)
      .is("archived_at", null);
    for (const row of (rows ?? []) as unknown as SavedBox[]) saved.set(row.id, row);
    if (boxIds.some((id) => !saved.has(id))) {
      return { error: "That box isn't on your list any more. Pick another." };
    }
  }
  const parsed = parcelsFrom(
    asked.map((box) => ({
      box: box.boxId ? (saved.get(String(box.boxId)) ?? null) : null,
      length: String(box.length ?? ""),
      width: String(box.width ?? ""),
      height: String(box.height ?? ""),
      weightLb: String(box.weightLb ?? ""),
      weightOz: String(box.weightOz ?? ""),
    })),
  );
  if ("error" in parsed) return { error: parsed.error };

  return {
    stored,
    riders,
    request: {
      from: shipFromAddress(setup.settings),
      to: {
        ...shipToAddress(order, home),
        ...(typeof input.residential === "boolean" ? { residential: input.residential } : {}),
      },
      parcels: parsed.parcels,
      reference,
      signature: isSignature(input.signature) ? input.signature : "none",
    },
  };
}

/** How long one source gets to answer before the list goes on without it. */
const QUOTE_MS = 30_000;

const within = <T>(ms: number, name: string, work: Promise<T>): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    work,
    new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new SourceError(`${name} didn't answer in time.`, null, true)),
        ms,
      );
    }),
  ]).finally(() => clearTimeout(timer));
};

type Answer = { source: LabelSourceKey; quote?: SourceQuote; problem?: string };

/** Asks one source for its prices. Never throws: a source in trouble is a note, not an error. */
async function askSource<K extends LabelSourceKey>(
  tenantId: string,
  key: K,
  request: LabelRequest,
  quoteRef: string,
): Promise<Answer> {
  const source = labelSource(key);
  if (request.parcels.length > source.maxBoxes) {
    return {
      source: key,
      problem: `${source.name} takes up to ${source.maxBoxes} boxes in one purchase.`,
    };
  }
  const held = await labelAccess(tenantId, key);
  if ("error" in held) return { source: key, problem: held.error };
  try {
    const quote = await within(
      QUOTE_MS,
      source.name,
      withLabelSource(tenantId, key, (access) => source.quote(access, request, quoteRef), held),
    );
    return { source: key, quote, problem: quote.rates.length === 0 ? quote.note : undefined };
  } catch (err) {
    return { source: key, problem: await explain(err, held.connectionId, key) };
  }
}

/**
 * Asks every connected source what this order would cost to send, and puts
 * the answers in one list, cheapest first. A source that errors or is slow is
 * left out with a short note; the list is still shown. Both addresses come
 * from what is stored (the order, the settings): the browser only says which
 * boxes and what each weighs. The list is kept server-side as a quote, each
 * rate with its source and that source's own ids, which is what a purchase
 * is later checked against.
 */
export async function getLabelRates(
  slug: string,
  orderId: string,
  input: RatesInput,
): Promise<RatesState> {
  const ctx = await context(slug);
  if ("error" in ctx) return { error: ctx.error };
  if (!UUID.test(orderId)) return { error: OOPS };
  const prepared = await prepareRequest(ctx, orderId, input ?? { boxes: [] });
  if ("error" in prepared) return { error: prepared.error };
  const { stored, riders, request } = prepared;

  const connections = await loadLabelConnections(ctx.supabase, ctx.tenant.id);
  if (connections.active.length === 0) {
    return {
      error:
        connections.needsReconnect.length > 0
          ? needsConnecting(connections.needsReconnect[0])
          : NOTHING_CONNECTED,
    };
  }

  // Ours: it makes every rate id belong to this quote and no other.
  const quoteRef = `quote_${randomUUID().replace(/-/g, "")}`;
  const answers = await Promise.all(
    connections.active.map((key) => askSource(ctx.tenant.id, key, request, quoteRef)),
  );
  const several = request.parcels.length > 1;
  const one = connections.active.length === 1;
  const rates = mergeRates(answers.flatMap((answer) => answer.quote?.rates ?? [])).slice(0, 80);
  const notes = answers
    .filter((answer) => answer.problem)
    .map((answer) => `${SOURCE_NAMES[answer.source]} isn't in this list. ${answer.problem}`);
  if (rates.length === 0) {
    const problems = answers.filter((answer) => answer.problem);
    if (problems.length > 0) {
      // With one source its own words are the whole story, as they always were.
      return { error: one ? problems[0].problem : notes.join(" ") };
    }
    return {
      error: several
        ? "No carrier offered a rate for these boxes together. Check the address, sizes and weights, or send them as separate parcels."
        : `No carrier offered a rate for this box. Check the address, size and weight, and that a carrier is switched on in ${connections.active.map((key) => SOURCE_NAMES[key]).join(" or ")}.`,
    };
  }

  // Only prices and the sources' own ids are kept: no address. EasyPost's id
  // for what it quoted stays where it always was; without EasyPost, ours stands in.
  const easypost = answers.find((answer) => answer.source === "easypost")?.quote;
  const { error } = await getAdminClient().rpc("save_label_quote_from", {
    p_tenant_id: ctx.tenant.id,
    p_shipping_order_id: stored.id,
    p_created_by: ctx.user.id,
    p_provider: easypost?.shipmentId ? "easypost" : rates[0].source,
    p_provider_shipment_id: easypost?.shipmentId ?? quoteRef,
    p_rates: rates,
    p_kind: several ? "order" : "shipment",
    p_boxes: request.parcels.length,
    // Which orders these prices are for; only this exact set can buy them.
    p_rider_ids: riders,
    p_request_hash: requestFingerprint(request),
  });
  if (error) {
    console.error("could not save label quote", error.message);
    return { error: "We got rates but couldn't keep them. Try again." };
  }
  return { rates: rates.map(sourceRateChoice), ...(notes.length > 0 ? { notes } : {}) };
}

export type AddressState = {
  error?: string;
  check?: AddressCheck;
  /** No connected account can check addresses: nothing to show, and nothing wrong. */
  skipped?: boolean;
};

/**
 * Asks the carriers' address book about the address on the screen: EasyPost's
 * when it is connected, else UPS's own (US addresses), else not at all.
 * Nothing is saved: the answer only tells the person whether to look again.
 */
export async function checkLabelAddress(
  slug: string,
  orderId: string,
  shipTo: ShipToEdit,
): Promise<AddressState> {
  const ctx = await context(slug);
  if ("error" in ctx) return { error: ctx.error };
  if (!UUID.test(orderId)) return { error: OOPS };
  const [{ data }, setup, connections] = await Promise.all([
    ctx.supabase
      .from("shipping_orders")
      .select(ORDER_FIELDS)
      .eq("tenant_id", ctx.tenant.id)
      .eq("id", orderId)
      .maybeSingle(),
    loadShippingSetup(ctx.supabase, ctx.tenant.id),
    loadLabelConnections(ctx.supabase, ctx.tenant.id),
  ]);
  const stored = data as unknown as ShippingOrder | null;
  if (!stored) return { error: "We couldn't find that order." };
  const order = withShipToEdit(stored, shipTo);
  if (!order) return { error: "That address doesn't look right. Check each box and try again." };
  const gaps = missingShipTo(order);
  if (gaps.length > 0) return { error: `The address is missing ${gaps.join(", ")}.` };
  const to = shipToAddress(order, setup.settings.ship_from_country);
  const checker: "easypost" | "ups" | null = connections.active.includes("easypost")
    ? "easypost"
    : connections.active.includes("ups") && upsChecksAddress(to.country)
      ? "ups"
      : null;
  if (!checker) return { skipped: true };
  const held = await labelAccess(ctx.tenant.id, checker);
  if ("error" in held) return { error: held.error };
  try {
    return {
      check:
        checker === "easypost"
          ? await verifyAddress((held as Held<"easypost">).access.key, to)
          : await withLabelSource(
              ctx.tenant.id,
              "ups",
              (access) => validateUpsAddress(access, to),
              held as Held<"ups">,
            ),
    };
  } catch (err) {
    return { error: await explain(err, held.connectionId, checker) };
  }
}

// ---------------------------------------------------------------------------
// Buying
// ---------------------------------------------------------------------------

type Claim = {
  quote_id: string;
  /** Which source the chosen rate is bought from. */
  provider?: unknown;
  provider_shipment_id: string;
  /** A shipment (one box) or an order (several). */
  kind?: unknown;
  /** The fingerprint of what was priced, for sources that are sent it again. */
  request_hash?: unknown;
  /** The rate as the server stored it when it was quoted. */
  rate?: (Partial<SourceRate> & { id?: unknown }) | null;
};

const CLAIM_ERRORS: [match: string, message: string][] = [
  ["cancelled", "This order was cancelled, so there's nothing to send."],
  ["Nothing left", "Everything on this order has already been sent."],
  [
    "still being finished",
    "A label for this order has already been bought or is being bought right now. Reload this page to see it.",
  ],
  [
    "moments ago",
    "A label for this order was bought a moment ago. Reload this page to see it before buying another.",
  ],
  ["not quoted", "Those rates have run out. Press Get rates again, then choose one."],
  // Several orders going together.
  [
    "is on hold",
    "One of these orders has been put on hold, so they can't go together right now. Nothing was bought.",
  ],
  [
    "in-store pickup",
    "One of these orders is now an in-store pickup, so they can't go together. Nothing was bought.",
  ],
  [
    "no shipping address",
    "One of these orders has lost its shipping address. Check it in your shop. Nothing was bought.",
  ],
  [
    "ADDRESS_MISMATCH",
    "These orders no longer go to the same address. Go back to Shipping and open them together again to check. Nothing was bought.",
  ],
  [
    "oldest of these orders",
    "These orders have changed since you opened them. Go back to Shipping and open them together again. Nothing was bought.",
  ],
];

/**
 * Keeps a paid-for label's details; tried more than once, because losing
 * them matters. A label from EasyPost is kept exactly as it always was. One
 * from UPS or Redo also brings its own id and the label's file; if those
 * won't save, the last try leaves the file out so the tracking number and
 * the id a void needs are kept whatever happens.
 */
async function keepLabel(tenantId: string, quoteId: string, label: SourceLabel): Promise<boolean> {
  const parcels = label.boxes.map((box) => ({
    shipment_id: box.shipmentId,
    tracking_number: box.trackingCode,
    tracking_url: box.trackingCode ? trackingUrl(label.carrier, box.trackingCode) : null,
    label_url: box.labelUrl,
  }));
  const service = serviceWithoutCarrier(label.carrier, label.name);
  const save = (attempt: number) =>
    label.source === "easypost"
      ? getAdminClient().rpc("mark_label_bought", {
          p_tenant_id: tenantId,
          p_quote_id: quoteId,
          p_carrier: label.carrier,
          p_service: service,
          p_tracking_number: label.trackingCode,
          p_tracking_url: label.trackingCode
            ? trackingUrl(label.carrier, label.trackingCode)
            : null,
          p_label_url: label.labelUrl,
          p_label_mode: label.mode,
          // Text, so the price reaches the database exactly as EasyPost gave it.
          p_price: label.price,
          // Every box: what a refund is asked for by, its tracking and its label.
          p_parcels: parcels,
        })
      : getAdminClient().rpc("mark_label_bought_from", {
          p_tenant_id: tenantId,
          p_quote_id: quoteId,
          p_provider_shipment_id: label.shipmentId,
          p_carrier: label.carrier,
          p_service: service,
          p_label_mode: label.mode,
          p_price: label.price,
          p_parcels: parcels,
          p_files: attempt < 2 ? label.files : [],
        });
  const tries = label.source === "easypost" ? 2 : 3;
  for (let attempt = 0; attempt < tries; attempt++) {
    const { data, error } = await save(attempt);
    if (!error && (label.source === "easypost" || data === true)) return true;
    console.error("could not keep bought label", error?.message ?? "the quote was not waiting");
  }
  return false;
}

const tracked = (label: SourceLabel) => {
  const codes = label.boxes.map((box) => box.trackingCode).filter(Boolean);
  if (codes.length === 0) return "";
  return codes.length === 1
    ? ` (tracking number ${codes[0]})`
    : ` (tracking numbers ${codes.join(", ")})`;
};

/**
 * Buys the chosen rate and records the parcel. This spends real money, so:
 *  - the purchase is claimed in the database first, under a lock on the
 *    order; a second press, another tab or another person is refused;
 *  - only a rate the server itself quoted for this order can be bought, from
 *    the source that quoted it, with that source's own ids as the server
 *    stored them;
 *  - a source that keeps nothing between quote and purchase (UPS, Redo) is
 *    sent the request again, rebuilt here and checked against the quote's
 *    fingerprint, so what is bought is what was priced;
 *  - several boxes are bought as one purchase;
 *  - once the money is taken the label is written down before the parcel is
 *    recorded, and every message from then on says it WAS bought;
 *  - when we can't tell whether it went through, nothing is released: the
 *    order stays locked until the label is checked (EasyPost) or a person
 *    has looked in the account it would have been bought on (UPS, Redo).
 */
export async function buyLabel(
  slug: string,
  orderId: string,
  rateId: string,
  /** The two ticks beside the button; left out, the workspace's settings decide. */
  shop?: { markSent: boolean; notify: boolean },
  /** Other orders going in the same parcel, exactly as they were when rates were asked for. */
  withIds?: string[],
  /** The boxes and address as they stood when rates were asked for. */
  input?: RatesInput,
): Promise<BuyState> {
  const ctx = await context(slug);
  if ("error" in ctx) return { error: ctx.error };
  if (!UUID.test(orderId) || !/^[A-Za-z0-9_]{4,120}$/.test(String(rateId))) {
    return { error: "Choose a rate first." };
  }
  const setup = await loadShippingSetup(ctx.supabase, ctx.tenant.id);

  // With other orders riding along, every one of them is locked and checked
  // in the database before anything is bought.
  const riders = parseWith((Array.isArray(withIds) ? withIds : []).join(","), orderId);
  const { data: claimed, error: claimError } =
    riders.length > 0
      ? await ctx.supabase.rpc("claim_group_label_purchase", {
          p_shipping_order_id: orderId,
          p_rider_ids: riders,
          p_rate_id: rateId,
        })
      : await ctx.supabase.rpc("claim_label_purchase", {
          p_shipping_order_id: orderId,
          p_rate_id: rateId,
        });
  if (claimError || !claimed) {
    const known = CLAIM_ERRORS.find(([match]) => claimError?.message.includes(match));
    const message = known ? known[1] : "We couldn't start that purchase. Nothing was bought.";
    return {
      error:
        riders.length > 0 ? message.replace(/\bthis order\b/g, "one of these orders") : message,
    };
  }
  const claim = claimed as Claim;
  const kind: LabelKind = isLabelKind(claim.kind) ? claim.kind : "shipment";
  const sourceKey: LabelSourceKey = isLabelSource(claim.provider) ? claim.provider : "easypost";
  const source = labelSource(sourceKey);
  const name = source.name;
  const release = async () => {
    const { error } = await getAdminClient().rpc("release_label_purchase", {
      p_tenant_id: ctx.tenant.id,
      p_quote_id: claim.quote_id,
    });
    if (error) console.error("could not release label purchase", error.message);
  };

  // EasyPost holds what it quoted. Any other source is sent it again, and
  // only if it is exactly what the server priced.
  let request: LabelRequest | null = null;
  if (sourceKey !== "easypost") {
    const prepared = input
      ? await prepareRequest(ctx, orderId, { ...input, withIds: riders })
      : { error: "Those rates have run out. Press Get rates again, then choose one." };
    if ("error" in prepared) {
      await release();
      return { error: `${prepared.error} Nothing was bought.` };
    }
    if (!matchesFingerprint(claim.request_hash, prepared.request)) {
      await release();
      return {
        error:
          "Something about this order or its boxes changed after these rates were fetched. Press Get rates again, then choose one. Nothing was bought.",
      };
    }
    request = prepared.request;
  }

  const held = await labelAccess(ctx.tenant.id, sourceKey);
  if ("error" in held) {
    await release();
    return { error: `${held.error} Nothing was bought.` };
  }

  let label: SourceLabel;
  try {
    label = await withLabelSource(
      ctx.tenant.id,
      sourceKey,
      (access) =>
        // Everything here is from the quote the server kept; nothing from the browser.
        source.buy(access as never, {
          rate: { ...(claim.rate ?? {}), id: rateId },
          shipmentId: claim.provider_shipment_id,
          kind,
          quoteId: claim.quote_id,
          request,
        }),
      held,
    );
  } catch (err) {
    const refused = !(isSourceError(err) && err.uncertain);
    // A plain "no" means nothing was charged, with one exception: several
    // boxes at EasyPost are bought one after another on its side, so even a
    // plain "no" is checked first (a bad key aside: that buys nothing).
    if (refused && (sourceKey !== "easypost" || kind === "shipment" || !isSourceError(err))) {
      await release();
      return { error: `${await explain(err, held.connectionId, sourceKey)} Nothing was bought.` };
    }
    if (!source.canLookUp) {
      // No clear answer, and no way to ask. The order stays locked: a person
      // looks in the account, then says here what they found.
      done(slug);
      return {
        bought: true,
        error: `${isSourceError(err) ? `${err.message} ` : ""}We can't tell whether this label was bought. Please don't buy another. Look in your ${name} account for a label for this order: this page lists it under "Labels to finish" after a reload, with what to do next.`,
      };
    }
    // No clear answer. Ask the source whether the label exists before saying anything.
    const settled = await withLabelSource(
      ctx.tenant.id,
      sourceKey,
      (access) => source.lookUp(access as never, { kind, shipmentId: claim.provider_shipment_id }),
      held,
    ).catch(() => null);
    if (settled === null) {
      done(slug);
      return {
        bought: true,
        error: `${name} stopped answering part-way through, so we can't tell yet whether this label was bought. Please don't buy another. Reload this page in a minute and press Check this label; your ${name} account will also show it if it went through.`,
      };
    }
    if (!settled.label) {
      await release();
      return {
        error: refused
          ? `${await explain(err, held.connectionId, sourceKey)} Nothing was bought.`
          : `${name} didn't finish that purchase. Nothing was bought; try again.`,
      };
    }
    label = settled.label;
  }

  // From here on the money is spent.
  if (!(await keepLabel(ctx.tenant.id, claim.quote_id, label))) {
    done(slug);
    return {
      bought: true,
      error: source.canLookUp
        ? `Your label WAS bought${tracked(label)}, but we couldn't save it here just now. Please don't buy another. Reload this page in a minute and press Check this label to finish; the label is also in your ${name} account.`
        : `Your label WAS bought${tracked(label)}, but we couldn't save it here. Please don't buy another. Print it from your ${name} account, record the parcel by hand with that tracking number, then clear it under "Labels to finish" on this page.`,
    };
  }

  const push = setup.canSend && (shop ? shop.markSent === true : setup.settings.mark_sent_in_shop);
  const { data: number, error: recordError } = await ctx.supabase.rpc("record_label_shipment", {
    p_quote_id: claim.quote_id,
    p_push: push,
    p_notify: push && (shop ? shop.notify === true : setup.settings.notify_customer),
  });
  done(slug);
  if (recordError) {
    console.error("could not record label parcel", recordError.message);
    return {
      bought: true,
      error: `Your label WAS bought${tracked(label)} and is saved on ${riders.length > 0 ? "the first of these orders" : "this order"}, but recording the parcel didn't go through. Please don't buy another. Reload this page: the label is under "Labels to finish", where you can print it and finish recording.`,
    };
  }
  redirect(`/w/${slug}/shipping/orders/${orderId}?label=${number as number}`);
}

type OpenQuote = {
  id: string;
  shipping_order_id: string;
  provider: string;
  provider_shipment_id: string;
  status: string;
  label_kind: string;
  buying_at: string | null;
};
const OPEN_QUOTE =
  "id, shipping_order_id, provider, provider_shipment_id, status, label_kind, buying_at";

/**
 * Finishes a label that was bought (or may have been) but isn't a parcel
 * yet: asks the source what really happened if we never heard, then records
 * it. A source that can't be asked (UPS, Redo) leaves that to a person: see
 * `clearUnsureLabel`.
 */
export async function finishLabel(
  slug: string,
  quoteId: string,
  _prev: ShippingState,
  _formData: FormData,
): Promise<ShippingState> {
  const ctx = await context(slug);
  if ("error" in ctx) return { error: ctx.error };
  if (!UUID.test(quoteId)) return { error: OOPS };
  const { data } = await ctx.supabase
    .from("shipping_label_quotes")
    .select(OPEN_QUOTE)
    .eq("tenant_id", ctx.tenant.id)
    .eq("id", quoteId)
    .maybeSingle();
  const quote = data as OpenQuote | null;
  if (!quote || !["buying", "bought"].includes(quote.status)) {
    done(slug);
    return { error: "That label is already sorted. Reload this page." };
  }

  if (quote.status === "buying") {
    const sourceKey: LabelSourceKey = isLabelSource(quote.provider) ? quote.provider : "easypost";
    const source = labelSource(sourceKey);
    if (!source.canLookUp) {
      return {
        error: `We can't ask ${source.name} about a label from here. Look in your ${source.name} account for one bought for this order. If it's there, void it there or use it and record the parcel by hand; then an owner or admin can clear this.`,
      };
    }
    const held = await labelAccess(ctx.tenant.id, sourceKey);
    if ("error" in held) return { error: held.error };
    let settled: { label: SourceLabel | null };
    try {
      settled = await withLabelSource(
        ctx.tenant.id,
        sourceKey,
        (access) =>
          source.lookUp(access as never, {
            kind: isLabelKind(quote.label_kind) ? quote.label_kind : "shipment",
            shipmentId: quote.provider_shipment_id,
          }),
        held,
      );
    } catch (err) {
      return { error: await explain(err, held.connectionId, sourceKey) };
    }
    if (!settled.label) {
      const { error } = await getAdminClient().rpc("release_label_purchase", {
        p_tenant_id: ctx.tenant.id,
        p_quote_id: quote.id,
      });
      if (error) return { error: OOPS };
      done(slug);
      return {
        message: `${source.name} says that label was never bought, so nothing was charged. You can get rates again.`,
      };
    }
    if (!(await keepLabel(ctx.tenant.id, quote.id, settled.label))) {
      return {
        error:
          "The label was bought, but we still couldn't save it here. Try again in a minute; don't buy another.",
      };
    }
  }

  const setup = await loadShippingSetup(ctx.supabase, ctx.tenant.id);
  const push = setup.canSend && setup.settings.mark_sent_in_shop;
  const { data: number, error } = await ctx.supabase.rpc("record_label_shipment", {
    p_quote_id: quote.id,
    p_push: push,
    p_notify: push && setup.settings.notify_customer,
  });
  done(slug);
  if (error) {
    console.error("could not record label parcel", error.message);
    return {
      error:
        "The label is bought and safe, but recording the parcel still didn't go through. Try again in a minute; don't buy another.",
    };
  }
  redirect(`/w/${slug}/shipping/orders/${quote.shipping_order_id}?label=${number as number}`);
}

/** How long a purchase is left alone before a person may say what became of it. */
const UNSURE_WAIT_MS = 2 * 60_000;

/**
 * For a purchase at UPS or Redo that we never heard back about. Neither can
 * be asked from here, so an owner or admin looks in that account and then
 * presses this to free the order. It buys nothing and voids nothing: it only
 * stops this page waiting. Never offered for EasyPost, which can be asked.
 */
export async function clearUnsureLabel(
  slug: string,
  quoteId: string,
  _prev: ShippingState,
  _formData: FormData,
): Promise<ShippingState> {
  const ctx = await context(slug, true);
  if ("error" in ctx) return { error: ctx.error };
  if (!UUID.test(quoteId)) return { error: OOPS };
  const { data } = await ctx.supabase
    .from("shipping_label_quotes")
    .select(OPEN_QUOTE)
    .eq("tenant_id", ctx.tenant.id)
    .eq("id", quoteId)
    .maybeSingle();
  const quote = data as OpenQuote | null;
  if (!quote || quote.status !== "buying") {
    done(slug);
    return { error: "That label is already sorted. Reload this page." };
  }
  const sourceKey: LabelSourceKey = isLabelSource(quote.provider) ? quote.provider : "easypost";
  if (labelSource(sourceKey).canLookUp) {
    return { error: "Press Check this label instead: it can be looked up." };
  }
  if (!quote.buying_at || Date.now() - new Date(quote.buying_at).getTime() < UNSURE_WAIT_MS) {
    return { error: "This purchase may still be going through. Give it a couple of minutes." };
  }
  const { data: freed, error } = await getAdminClient().rpc("release_label_purchase", {
    p_tenant_id: ctx.tenant.id,
    p_quote_id: quote.id,
  });
  if (error || freed !== true) return { error: OOPS };
  done(slug);
  return { message: "Cleared. You can get rates for this order again." };
}
