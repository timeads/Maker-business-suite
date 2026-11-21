import type { PlanKey } from "./plans";

export type SubscriptionStatus =
  | "trialing"
  | "active"
  | "past_due"
  | "unpaid"
  | "paused"
  | "incomplete"
  | "incomplete_expired"
  | "canceled";

/** What members can read about their workspace's subscription. */
export type SubscriptionSummary = {
  tenant_id: string;
  plan: PlanKey;
  status: SubscriptionStatus;
  trial_end: string | null;
  current_period_end: string | null;
  cancel_at_period_end: boolean;
  ended_at: string | null;
  purge_after: string | null;
  selected_modules: string[];
};

/** The full row, as the worker writes it. */
export type SubscriptionRow = SubscriptionSummary & {
  stripe_customer_id: string;
  stripe_subscription_id: string;
};
