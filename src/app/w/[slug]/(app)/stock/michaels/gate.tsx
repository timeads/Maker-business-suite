import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { canManage } from "@/lib/tenants";
import { stockAccess } from "../gate";

/**
 * What every Michaels page needs, or the screen to show instead. The
 * connector has its own entitlement key (`michaels`), asked through
 * lib/entitlements like every other gate.
 */
export async function michaelsAccess(slug: string, path: string) {
  const access = await stockAccess(slug, path);
  if (!access.ok) return access;
  if (access.entitlements.can("michaels")) return access;
  return {
    ok: false as const,
    upsell: (
      <>
        <PageHeader title="Michaels Marketplace" />
        <Card>
          <CardHeader>
            <CardTitle>Selling on Michaels isn&apos;t part of your plan</CardTitle>
            <CardDescription>
              The Michaels connector comes with any plan that includes Stock.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {canManage(access.role) ? (
              <Button asChild>
                <Link href={`/w/${access.tenant.slug}/settings/billing`}>See plans</Link>
              </Button>
            ) : (
              <p className="text-muted-foreground text-sm">
                Ask a workspace owner or admin to switch it on.
              </p>
            )}
          </CardContent>
        </Card>
      </>
    ),
  };
}
