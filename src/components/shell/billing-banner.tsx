import Link from "next/link";
import { TRIAL_DAYS } from "@/lib/billing/plans";
import type { Entitlements } from "@/lib/entitlements";
import { cn } from "@/lib/utils";

function formatDate(iso: string, timeZone: string) {
  return new Intl.DateTimeFormat("en-US", { dateStyle: "long", timeZone }).format(new Date(iso));
}

/** One line across the top of the workspace when billing needs attention. */
export function BillingBanner({
  entitlements,
  billingHref,
  timeZone,
  canManage,
}: {
  entitlements: Entitlements;
  billingHref: string;
  timeZone: string;
  canManage: boolean;
}) {
  const { access } = entitlements;
  let message: string | null = null;
  let action: string | null = null;
  let urgent = false;

  if (access === "none") {
    message = `Pick a plan to switch on your tools. The first ${TRIAL_DAYS} days are free.`;
    action = "See plans";
  } else if (access === "trialing" && entitlements.trialEndsAt) {
    message = `Your free trial runs until ${formatDate(entitlements.trialEndsAt, timeZone)}.`;
    action = "Billing";
  } else if (access === "past_due") {
    message = "Your last payment didn't go through. Update your card to keep everything running.";
    action = "Update card";
    urgent = true;
  } else if (access === "read_only") {
    message = entitlements.purgeAfter
      ? `This workspace's plan has ended, so it's read-only. Its data will be deleted on ${formatDate(entitlements.purgeAfter, timeZone)} unless you pick a plan again.`
      : "This workspace's plan has ended, so it's read-only.";
    action = "Pick a plan";
    urgent = true;
  } else if (entitlements.cancelsAtPeriodEnd && entitlements.renewsAt) {
    message = `Your plan is set to end on ${formatDate(entitlements.renewsAt, timeZone)}.`;
    action = "Billing";
  }

  if (!message) return null;
  return (
    <div
      role={urgent ? "alert" : "status"}
      className={cn(
        "flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-b px-4 py-2 text-sm md:px-10",
        urgent
          ? "border-destructive/30 bg-destructive/10 text-destructive"
          : "border-border bg-muted text-foreground",
      )}
    >
      <span>{message}</span>
      {canManage ? (
        <Link href={billingHref} className="font-medium underline underline-offset-4">
          {action}
        </Link>
      ) : (
        <span className="text-xs opacity-80">Ask a workspace owner or admin.</span>
      )}
    </div>
  );
}
