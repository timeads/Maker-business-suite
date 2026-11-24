import { z } from "zod";
import { signatureByRule } from "./labels";

/**
 * Shipping rules: "when an order looks like this, pack and post it like
 * that". Data, like every other setting: an ordered list in `configs` under
 * module "shipping", parsed on every read. Ported from the reference help
 * desk's `rules.ts` with the same meaning: every condition of a rule must
 * match, and for each kind of action the first matching rule wins.
 *
 * Pure: no network, no database, safe in the browser.
 */
export const SHIPPING_RULES_KEY = "rules";

export const RULE_FIELD_KEYS = [
  "item_quantity",
  "order_total",
  "product_names",
  "product_skus",
  "destination_state",
  "destination_country",
  "shipping_service",
] as const;
export type RuleField = (typeof RULE_FIELD_KEYS)[number];

export const RULE_OPS = ["eq", "gt", "lt", "includes_any", "excludes", "contains"] as const;
export type RuleOp = (typeof RULE_OPS)[number];

export const RULE_ACTIONS = [
  "set_package",
  "require_signature",
  "set_service",
  "place_hold",
] as const;
export type RuleActionType = (typeof RULE_ACTIONS)[number];

/** What each condition looks at, in a maker's words, and the comparisons it takes. */
export const RULE_FIELDS: Record<RuleField, { label: string; ops: RuleOp[]; hint: string }> = {
  item_quantity: { label: "Items in the order", ops: ["eq", "gt", "lt"], hint: "A number, like 1" },
  order_total: {
    label: "Order total",
    ops: ["gt", "lt", "eq"],
    hint: "An amount, like 250",
  },
  product_names: {
    label: "Product names",
    ops: ["includes_any", "excludes", "contains"],
    hint: "One or more names, with commas between",
  },
  product_skus: {
    label: "Item codes (SKUs)",
    ops: ["includes_any", "excludes", "contains"],
    hint: "One or more codes, with commas between",
  },
  destination_state: {
    label: "State it's going to",
    ops: ["includes_any", "excludes"],
    hint: "Two-letter codes, like AK, HI",
  },
  destination_country: {
    label: "Country it's going to",
    ops: ["includes_any", "excludes"],
    hint: "Two-letter codes, like CA, GB",
  },
  shipping_service: {
    label: "Shipping the customer chose",
    ops: ["includes_any", "contains", "excludes"],
    hint: "Words from the checkout option, like express",
  },
};

export const RULE_OP_WORDS: Record<RuleOp, string> = {
  eq: "is",
  gt: "is more than",
  lt: "is less than",
  includes_any: "includes any of",
  excludes: "includes none of",
  contains: "contains",
};

export const RULE_ACTION_WORDS: Record<RuleActionType, string> = {
  set_package: "Pack it in",
  require_signature: "Ask for a signature",
  set_service: "Send it by",
  place_hold: "Put it on hold",
};

const conditionSchema = z
  .object({
    field: z.enum(RULE_FIELD_KEYS),
    op: z.enum(RULE_OPS),
    value: z.string().trim().max(500),
  })
  .refine((condition) => RULE_FIELDS[condition.field].ops.includes(condition.op), {
    message: "That comparison doesn't go with that condition.",
  });

const actionSchema = z
  .object({
    type: z.enum(RULE_ACTIONS),
    /** A box's name | "standard" or "adult" | "cheapest", "fastest" or a service's name | the hold's note. */
    value: z.string().trim().max(300).default(""),
  })
  .refine(
    (action) =>
      action.type === "place_hold" ||
      (action.type === "require_signature"
        ? action.value === "standard" || action.value === "adult"
        : action.value !== ""),
    { message: "That action needs a value." },
  );

export const shippingRuleSchema = z.object({
  /** Stays with the rule while others come and go. */
  id: z.string().trim().min(1).max(40),
  name: z.string().trim().min(1).max(80),
  enabled: z.boolean().default(true),
  /** Every one must match. */
  conditions: z.array(conditionSchema).min(1).max(10),
  /** One of each kind at most. */
  actions: z
    .array(actionSchema)
    .min(1)
    .max(RULE_ACTIONS.length)
    .refine((list) => new Set(list.map((action) => action.type)).size === list.length, {
      message: "A rule does each kind of thing once.",
    }),
});
export type ShippingRule = z.infer<typeof shippingRuleSchema>;
export type RuleCondition = ShippingRule["conditions"][number];
export type RuleAction = ShippingRule["actions"][number];

export const shippingRulesSchema = z.object({
  version: z.literal(1),
  /** Top to bottom: for each kind of action, the first rule that matches wins. */
  rules: z
    .array(shippingRuleSchema)
    .max(50)
    .refine((list) => new Set(list.map((rule) => rule.id)).size === list.length, {
      message: "Each rule needs its own id.",
    })
    .default([]),
});
export type ShippingRules = z.infer<typeof shippingRulesSchema>;

export const DEFAULT_SHIPPING_RULES: ShippingRules = { version: 1, rules: [] };

/** The saved rules, or none when nothing (or nonsense) is saved. */
export function parseShippingRules(body: unknown): ShippingRule[] {
  const parsed = shippingRulesSchema.safeParse(body);
  return parsed.success ? parsed.data.rules : [];
}

/** What a rule can see of an order. */
export type RuleOrder = {
  items: { title: string; sku?: string | null; qty: number }[];
  /** What the whole order came to; null when the sale isn't known. */
  total: number | null;
  /** State or province code. */
  region: string | null;
  country: string | null;
  /** The option picked at checkout. */
  shippingMethod: string | null;
};

export type RuleSignature = "standard" | "adult";

export type RuleResult = {
  /** The box a rule named, as typed in the rule. */
  packageName: string | null;
  signature: RuleSignature | null;
  /** The rule that asked for the signature. */
  signatureRule: string | null;
  /** "cheapest", "fastest" or a service's name. */
  service: string | null;
  /** The rule that picked the service. */
  serviceRule: string | null;
  /** The note, when a rule holds the order. */
  hold: string | null;
  /** Every rule that did something, in order. */
  matched: string[];
};

const list = (value: string) =>
  value
    .split(/[,\n]/)
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);

function values(order: RuleOrder, field: RuleField): string[] | number {
  switch (field) {
    case "item_quantity":
      return order.items.reduce((sum, item) => sum + item.qty, 0);
    case "order_total":
      return order.total === null ? Number.NaN : Number(order.total);
    case "product_names":
      return order.items.map((item) => item.title.toLowerCase());
    case "product_skus":
      return order.items.map((item) => (item.sku ?? "").toLowerCase()).filter(Boolean);
    case "destination_state":
      return [String(order.region ?? "").toLowerCase()];
    case "destination_country":
      return [String(order.country ?? "").toLowerCase()];
    case "shipping_service":
      return order.shippingMethod ? [order.shippingMethod.toLowerCase()] : [];
  }
}

export function conditionMatches(order: RuleOrder, condition: RuleCondition): boolean {
  const actual = values(order, condition.field);
  if (typeof actual === "number") {
    // "250", "$250", "1,000.00" all mean the number; anything else (or blank) never matches.
    const raw = String(condition.value ?? "").replace(/[$,\s]/g, "");
    const want = raw ? Number(raw) : Number.NaN;
    if (Number.isNaN(want) || Number.isNaN(actual)) return false;
    return condition.op === "eq"
      ? actual === want
      : condition.op === "gt"
        ? actual > want
        : condition.op === "lt"
          ? actual < want
          : false;
  }
  const wanted = list(condition.value);
  switch (condition.op) {
    case "includes_any": // an item equals or contains one of the listed values
      return actual.some((a) => wanted.some((w) => a === w || a.includes(w)));
    case "contains":
      return actual.some((a) => wanted.some((w) => a.includes(w)));
    case "excludes":
      return !actual.some((a) => wanted.some((w) => a === w || a.includes(w)));
    default:
      return false;
  }
}

/** The name the built-in "signature on orders of at least X" setting goes by among the rules. */
export const signatureOverName = (over: number, money?: (amount: number) => string) =>
  `Signature on orders of ${money ? money(over) : over} or more`;

/**
 * First matching enabled rule wins for each kind of action.
 *
 * `builtIn` is the older "ask for a signature on orders of at least X"
 * setting. It still works exactly as it did: an order worth that much always
 * gets a signature. It counts as one more rule after the list, so a rule that
 * asks for an adult signature isn't watered down by it, and it shows among
 * the rules that applied.
 */
export function evaluateRules(
  order: RuleOrder,
  rules: readonly ShippingRule[],
  builtIn?: { signatureOver: number | null | undefined; name?: string },
): RuleResult {
  const out: RuleResult = {
    packageName: null,
    signature: null,
    signatureRule: null,
    service: null,
    serviceRule: null,
    hold: null,
    matched: [],
  };
  for (const rule of rules) {
    if (!rule.enabled || !rule.conditions.length) continue;
    if (!rule.conditions.every((condition) => conditionMatches(order, condition))) continue;
    let used = false;
    for (const action of rule.actions) {
      if (action.type === "set_package" && !out.packageName && action.value) {
        out.packageName = action.value;
        used = true;
      }
      if (
        action.type === "require_signature" &&
        !out.signature &&
        (action.value === "standard" || action.value === "adult")
      ) {
        out.signature = action.value;
        out.signatureRule = rule.name;
        used = true;
      }
      if (action.type === "set_service" && !out.service && action.value) {
        out.service = action.value;
        out.serviceRule = rule.name;
        used = true;
      }
      if (action.type === "place_hold" && out.hold === null) {
        out.hold = action.value || rule.name;
        used = true;
      }
    }
    if (used) out.matched.push(rule.name);
  }
  const over = builtIn?.signatureOver;
  if (!out.signature && over !== null && over !== undefined && signatureByRule(order.total, over)) {
    const name = builtIn?.name ?? signatureOverName(over);
    out.signature = "standard";
    out.signatureRule = name;
    out.matched.push(name);
  }
  return out;
}

/** "UPS Ground" and "ups  ground" are the same service. */
const squash = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, "");

/** A service with its carrier in front, once: "UPS" + "Ground" and "UPS" + "UPS Ground" both read "upsground". */
function serviceNames(rate: { carrier: string; name: string }): string[] {
  const bare = squash(rate.name.replace(/\s·\s.*$/, ""));
  const carrier = squash(rate.carrier);
  return bare.startsWith(carrier)
    ? [bare, bare.slice(carrier.length)]
    : [`${carrier}${bare}`, bare];
}

export type ServiceRate = { carrier: string; name: string; price: string; days: number | null };

/**
 * The rate a plan would buy from a list that is cheapest first: "cheapest",
 * "fastest" (soonest, then cheapest; cheapest when nobody says how long), or
 * a service by name. A named service nobody offered falls back to the
 * cheapest, and `matched` says so.
 */
export function pickService<T extends ServiceRate>(
  rates: readonly T[],
  policy: string | null | undefined,
): { rate: T; matched: boolean } | null {
  if (rates.length === 0) return null;
  const cost = (rate: T) => {
    const amount = Number(rate.price);
    return Number.isFinite(amount) ? amount : Number.POSITIVE_INFINITY;
  };
  const byPrice = [...rates].sort((a, b) => cost(a) - cost(b));
  const wanted = (policy ?? "").trim();
  if (!wanted || wanted.toLowerCase() === "cheapest") {
    return { rate: byPrice[0], matched: Boolean(wanted) };
  }
  if (wanted.toLowerCase() === "fastest") {
    const timed = rates
      .filter((rate) => rate.days !== null)
      .sort((a, b) => a.days! - b.days! || cost(a) - cost(b));
    return { rate: timed[0] ?? byPrice[0], matched: timed.length > 0 };
  }
  const name = squash(wanted);
  const found = byPrice.find((rate) => serviceNames(rate).includes(name));
  return found ? { rate: found, matched: true } : { rate: byPrice[0], matched: false };
}

/** A service policy as a person would read it. */
export const serviceWords = (policy: string) =>
  policy.toLowerCase() === "cheapest"
    ? "the cheapest service"
    : policy.toLowerCase() === "fastest"
      ? "the fastest service"
      : policy;

/** Each condition as the start of a sentence: "the order total is more than…". */
const FIELD_SAID: Record<RuleField, string> = {
  item_quantity: "the number of items",
  order_total: "the order total",
  product_names: "a product name",
  product_skus: "an item code",
  destination_state: "the state it's going to",
  destination_country: "the country it's going to",
  shipping_service: "the shipping the customer chose",
};
const OP_SAID: Record<RuleOp, string> = {
  eq: "is",
  gt: "is more than",
  lt: "is less than",
  includes_any: "is or includes any of",
  excludes: "includes none of",
  contains: "contains",
};

/** One rule as a sentence, for the settings list. */
export function ruleSentence(rule: ShippingRule, money?: (amount: number) => string): string {
  const when = rule.conditions
    .map((condition) => {
      const amount = Number(condition.value.replace(/[$,\s]/g, ""));
      const value =
        condition.field === "order_total" && money && Number.isFinite(amount)
          ? money(amount)
          : condition.value;
      return `${FIELD_SAID[condition.field]} ${OP_SAID[condition.op]} ${value}`;
    })
    .join(", and ");
  const then = rule.actions
    .map((action) =>
      action.type === "set_package"
        ? `pack it in ${action.value}`
        : action.type === "require_signature"
          ? action.value === "adult"
            ? "ask for an adult signature"
            : "ask for a signature"
          : action.type === "set_service"
            ? `send it by ${serviceWords(action.value)}`
            : `put it on hold${action.value ? ` (“${action.value}”)` : ""}`,
    )
    .join(", ");
  return `When ${when}: ${then}.`;
}
