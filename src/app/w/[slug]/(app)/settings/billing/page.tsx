import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PlanCards } from "@/components/plan-cards";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { FormMessage } from "@/components/ui/form-message";
import { requireUser } from "@/lib/auth";
import { RETENTION_DAYS, TRIAL_DAYS } from "@/lib/billing/plans";
import { billingConfigured } from "@/lib/billing/stripe";
import { getEntitlements, type Entitlements } from "@/lib/entitlements";
import { canManage, getTenantContext } from "@/lib/tenants";
import { MODULES } from "@/lib/modules";
import { ChoosePlanButton, ManageBillingButton, ModuleChoiceForm } from "./billing-forms";

export const metadata: Metadata = { title: "Billing" };

function statusLine(e: Entitlements, format: (iso: string) => string): string {
  if (e.internal) {
    return e.internal.endsAt
      ? `This workspace is on an internal plan, set up by us: ${e.plan?.name}, until ${format(e.internal.endsAt)}. There's nothing to pay.`
      : `This workspace is on an internal plan, set up by us: ${e.plan?.name}. There's nothing to pay.`;
  }
  switch (e.access) {
    case "none":
      return `No plan yet. Pick one below — the first ${TRIAL_DAYS} days are free.`;
    case "trialing":
      return e.trialEndsAt
        ? `Free trial of ${e.plan?.name} until ${format(e.trialEndsAt)}. Your card is charged after that unless you cancel.`
        : `Free trial of ${e.plan?.name}.`;
    case "active":
      if (e.cancelsAtPeriodEnd && e.renewsAt) {
        return `${e.plan?.name}, ending on ${format(e.renewsAt)}. The workspace becomes read-only then.`;
      }
      return e.renewsAt
        ? `${e.plan?.name}, renewing on ${format(e.renewsAt)}.`
        : `${e.plan?.name}.`;
    case "past_due":
      return `${e.plan?.name}, but your last payment didn't go through. Update your card to keep everything running.`;
    case "read_only":
      return e.purgeAfter
        ? `Your plan has ended. The workspace is read-only and its data will be deleted on ${format(e.purgeAfter)} unless you pick a plan again.`
        : "Your plan has ended and the workspace is read-only.";
  }
}

export default async function BillingPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ checkout?: string }>;
}) {
  const { slug } = await params;
  const { checkout } = await searchParams;
  const user = await requireUser(`/w/${slug}/settings/billing`);
  const ctx = await getTenantContext(slug, user.id);
  if (!ctx) notFound();
  const { tenant, role } = ctx;
  const entitlements = await getEntitlements(tenant.id);
  const manager = canManage(role);
  const ready = billingConfigured();

  const dateFormat = new Intl.DateTimeFormat("en-US", {
    dateStyle: "long",
    timeZone: tenant.timezone,
  });
  const format = (iso: string) => dateFormat.format(new Date(iso));

  const hasPlan = entitlements.plan !== null;
  const internal = entitlements.internal !== null;
  const canChoose = manager && ready && !hasPlan;
  const firstTime = entitlements.access === "none";

  return (
    <>
      {checkout === "success" && !hasPlan && (
        <FormMessage kind="success">
          Thanks! Your plan is being set up. This page will show it in a moment — refresh if it
          doesn&apos;t.
        </FormMessage>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Your plan</CardTitle>
          <CardDescription>{statusLine(entitlements, format)}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {internal && (
            <p className="text-muted-foreground text-sm">
              {entitlements.internal?.endsAt
                ? "When it ends, you can pick a plan here. If you'd like to change anything before then, just ask us."
                : "If you'd like to change it, just ask us."}
            </p>
          )}
          {!internal && !ready && (
            <p className="text-muted-foreground text-sm">
              Billing isn&apos;t switched on for this environment yet, so plans can&apos;t be
              started here.
            </p>
          )}
          {!internal && !manager && (
            <p className="text-muted-foreground text-sm">
              Only owners and admins can change the plan.
            </p>
          )}
          {!internal && manager && ready && entitlements.access !== "none" && (
            <>
              <ManageBillingButton
                slug={tenant.slug}
                label={
                  entitlements.access === "past_due"
                    ? "Update card"
                    : entitlements.access === "read_only"
                      ? "View invoices"
                      : "Manage billing"
                }
              />
              {entitlements.access !== "read_only" && (
                <p className="text-muted-foreground text-xs">
                  Change plan, update your card, see invoices or cancel. If you cancel, your data is
                  kept for {RETENTION_DAYS} days in case you come back.
                </p>
              )}
            </>
          )}
        </CardContent>
      </Card>

      {entitlements.plan && entitlements.plan.moduleChoices > 0 && manager && (
        <Card>
          <CardHeader>
            <CardTitle>Your extra tool</CardTitle>
            <CardDescription>
              {entitlements.plan.name} includes the money view plus one more tool. You can change
              your pick whenever you like.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ModuleChoiceForm
              slug={tenant.slug}
              chosen={entitlements.chosenModules}
              options={MODULES.filter(
                (m) => !entitlements.plan?.includedModules.includes(m.key),
              ).map((m) => ({ ...m }))}
            />
          </CardContent>
        </Card>
      )}

      <section aria-label="Plans" className="flex flex-col gap-4">
        <h2 className="text-lg font-semibold">Plans</h2>
        <PlanCards
          current={entitlements.plan?.key}
          footer={(plan) =>
            canChoose ? (
              <ChoosePlanButton
                slug={tenant.slug}
                plan={plan.key}
                highlighted={plan.key === "growth"}
                label={firstTime ? `Start free trial` : `Choose ${plan.name}`}
              />
            ) : null
          }
        />
        {hasPlan && manager && ready && !internal && (
          <p className="text-muted-foreground text-sm">
            To switch plans, use Manage billing above.
          </p>
        )}
      </section>
    </>
  );
}
