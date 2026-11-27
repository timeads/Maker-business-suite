import Link from "next/link";
import { notFound } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { requireUser } from "@/lib/auth";
import { getEntitlements } from "@/lib/entitlements";
import { canManage, getTenantContext } from "@/lib/tenants";

/**
 * Loads what every help desk page needs, or the "not on your plan" screen
 * to show instead.
 */
export async function helpdeskAccess(slug: string, path: string) {
  const user = await requireUser(path);
  const ctx = await getTenantContext(slug, user.id);
  if (!ctx) notFound();
  const entitlements = await getEntitlements(ctx.tenant.id);
  if (entitlements.can("module.helpdesk")) {
    return { ok: true as const, user, ...ctx, entitlements };
  }
  // On the plan, but not one of this person's tools (docs/roles.md).
  const notTheirs = entitlements.onPlan("module.helpdesk");
  const hasChoice = entitlements.plan !== null && entitlements.plan.moduleChoices > 0;
  return {
    ok: false as const,
    upsell: (
      <>
        <h1 className="text-2xl font-semibold tracking-tight">Help desk</h1>
        <Card>
          <CardHeader>
            <CardTitle>One inbox, with each customer&apos;s orders beside their message</CardTitle>
            <CardDescription>
              {notTheirs
                ? "The help desk isn't one of the tools you can open here."
                : hasChoice
                  ? "Your plan includes one extra tool of your choice. Pick the help desk to switch it on."
                  : entitlements.plan
                    ? "The help desk isn't part of your current plan."
                    : "Pick a plan to switch the help desk on — the first 14 days are free."}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {canManage(ctx.role) ? (
              <Button asChild>
                <Link href={`/w/${ctx.tenant.slug}/settings/billing`}>
                  {hasChoice ? "Choose your tool" : "See plans"}
                </Link>
              </Button>
            ) : (
              <p className="text-muted-foreground text-sm">
                {notTheirs
                  ? "Ask a workspace owner or admin to add it to your tools."
                  : "Ask a workspace owner or admin to switch it on."}
              </p>
            )}
          </CardContent>
        </Card>
      </>
    ),
  };
}
