import { Check } from "lucide-react";
import { PLANS, PLAN_ORDER, type Plan, type PlanKey } from "@/lib/billing/plans";
import { MODULES } from "@/lib/modules";
import { cn } from "@/lib/utils";

const moduleName = (key: string) => MODULES.find((m) => m.key === key)?.name ?? key;

export function planFeatures(plan: Plan): string[] {
  const allModules = plan.includedModules.length === MODULES.length;
  return [
    allModules
      ? "Every tool: Money, Help desk, Bookings and Social"
      : `${plan.includedModules.map(moduleName).join(", ")} plus ${plan.moduleChoices} more tool of your choice`,
    `${plan.seats} people on your team`,
    "An AI assistant allowance each month",
    ...(plan.mcp ? ["Connect your own Claude to your workspace"] : []),
    ...(plan.prioritySupport ? ["Priority support"] : []),
  ];
}

/** The three plans side by side. `footer` renders each card's button. */
export function PlanCards({
  current,
  footer,
}: {
  current?: PlanKey | null;
  footer: (plan: Plan) => React.ReactNode;
}) {
  return (
    <ul className="grid gap-4 lg:grid-cols-3">
      {PLAN_ORDER.map((key) => {
        const plan = PLANS[key];
        const isCurrent = current === key;
        return (
          <li
            key={key}
            className={cn(
              "bg-card flex flex-col gap-4 rounded-xl border p-5",
              isCurrent ? "border-primary" : "border-border",
            )}
          >
            <div className="flex flex-col gap-1">
              <div className="flex items-center justify-between gap-2">
                <h3 className="font-semibold">{plan.name}</h3>
                {isCurrent && (
                  <span className="bg-primary/10 text-primary rounded-full px-2 py-0.5 text-xs font-medium">
                    Your plan
                  </span>
                )}
              </div>
              <p className="text-muted-foreground text-sm">{plan.tagline}</p>
            </div>
            <p>
              <span className="text-3xl font-semibold tracking-tight">${plan.priceMonthly}</span>
              <span className="text-muted-foreground text-sm"> / month</span>
            </p>
            <ul className="flex flex-1 flex-col gap-2 text-sm">
              {planFeatures(plan).map((feature) => (
                <li key={feature} className="flex gap-2">
                  <Check className="text-primary mt-0.5 size-4 shrink-0" aria-hidden />
                  <span>{feature}</span>
                </li>
              ))}
            </ul>
            {footer(plan)}
          </li>
        );
      })}
    </ul>
  );
}
