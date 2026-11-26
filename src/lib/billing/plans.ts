import type { ModuleKey } from "../modules";

export type PlanKey = "starter" | "growth" | "studio";

export type Plan = {
  key: PlanKey;
  name: string;
  /** USD per month. Placeholder pricing to test with beta users. */
  priceMonthly: number;
  /** Stripe price lookup key; `pnpm stripe:setup` creates the matching price. */
  lookupKey: string;
  tagline: string;
  seats: number;
  /** Modules always on. */
  includedModules: readonly ModuleKey[];
  /** Extra modules the workspace picks for itself. */
  moduleChoices: number;
  /** Monthly AI allowance in tokens. Placeholder until real usage is measured. */
  aiCredits: number;
  /** How many brands a workspace can keep (each with its own look and accounts). */
  brands: number;
  /** How many accounts of one network (Facebook Pages, Instagram accounts) a workspace can post and answer from. */
  socialAccountsPerNetwork: number;
  mcp: boolean;
  prioritySupport: boolean;
};

const ALL_MODULES = [
  "messages",
  "dashboard",
  "helpdesk",
  "bookings",
  "social",
  "stock",
  "shipping",
] as const;

export const PLANS: Record<PlanKey, Plan> = {
  starter: {
    key: "starter",
    name: "Starter",
    priceMonthly: 49,
    lookupKey: "starter_monthly",
    tagline: "The money view plus one tool of your choice",
    seats: 2,
    includedModules: ["messages", "dashboard"],
    moduleChoices: 1,
    aiCredits: 250_000,
    brands: 5,
    socialAccountsPerNetwork: 5,
    mcp: false,
    prioritySupport: false,
  },
  growth: {
    key: "growth",
    name: "Growth",
    priceMonthly: 99,
    lookupKey: "growth_monthly",
    tagline: "Every tool, for a small team",
    seats: 5,
    includedModules: ALL_MODULES,
    moduleChoices: 0,
    aiCredits: 1_000_000,
    brands: 10,
    socialAccountsPerNetwork: 10,
    mcp: false,
    prioritySupport: false,
  },
  studio: {
    key: "studio",
    name: "Studio",
    priceMonthly: 199,
    lookupKey: "studio_monthly",
    tagline: "Every tool, your own Claude connected, and priority help",
    seats: 10,
    includedModules: ALL_MODULES,
    moduleChoices: 0,
    aiCredits: 3_000_000,
    brands: 25,
    socialAccountsPerNetwork: 25,
    mcp: true,
    prioritySupport: true,
  },
};

export const PLAN_ORDER: readonly PlanKey[] = ["starter", "growth", "studio"];

export const TRIAL_DAYS = 14;
/** How long a workspace stays read-only after its subscription ends, before its data is deleted. */
export const RETENTION_DAYS = 30;
/** Seats available before a workspace has picked a plan. */
export const SEATS_WITHOUT_PLAN = PLANS.starter.seats;

export function isPlanKey(value: unknown): value is PlanKey {
  return typeof value === "string" && value in PLANS;
}

export function planFromLookupKey(lookupKey: string | null | undefined): PlanKey | null {
  return PLAN_ORDER.find((key) => PLANS[key].lookupKey === lookupKey) ?? null;
}
