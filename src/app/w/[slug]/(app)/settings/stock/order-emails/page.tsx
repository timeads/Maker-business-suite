import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { SectionHeading } from "@/components/settings/section-heading";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { googleMailConfigured } from "@/lib/connections/providers/google-mail";
import { STOCK_MODULE } from "@/lib/stock/config";
import { PO_EMAIL_KEY, parsePoEmail } from "@/lib/stock/po/email";
import { createClient } from "@/lib/supabase/server";
import { canManage } from "@/lib/tenants";
import { stockAccess } from "../../../stock/gate";
import { OrderEmailTemplateForm } from "./email-template-form";

export const metadata: Metadata = { title: "Order emails" };

/**
 * Settings → Stock → Order emails: the words an order's email starts from.
 * As before the move, it is only there for an owner or admin of a workspace
 * that can still change things, on a site where sending from Gmail is offered.
 */
export default async function OrderEmailsPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const access = await stockAccess(slug, `/w/${slug}/settings/stock/order-emails`);
  if (!access.ok) return access.upsell;
  const { tenant, role, entitlements } = access;
  if (!(canManage(role) && entitlements.canWrite && googleMailConfigured())) notFound();
  const supabase = await createClient();
  const { data: emailConfig } = await supabase
    .from("configs")
    .select("body")
    .eq("tenant_id", tenant.id)
    .eq("module", STOCK_MODULE)
    .eq("key", PO_EMAIL_KEY)
    .maybeSingle();
  const emailTemplate = parsePoEmail(emailConfig?.body);

  return (
    <>
      <SectionHeading
        back={{ href: `/w/${tenant.slug}/stock/orders`, label: "Stock orders" }}
        title="Order emails"
        description="What an order says when you email it to a supplier."
      />
      <Card>
        <CardHeader>
          <CardTitle>Emailing orders</CardTitle>
          <CardDescription>
            What an order&apos;s email starts out saying when you send it from your own Gmail. You
            can change any one of them before it goes. Connect Gmail under{" "}
            <Link href={`/w/${tenant.slug}/connections`} className="underline">
              Connections
            </Link>
            .
          </CardDescription>
        </CardHeader>
        <CardContent>
          <OrderEmailTemplateForm
            slug={tenant.slug}
            template={emailTemplate}
            workspaceName={tenant.name}
          />
        </CardContent>
      </Card>
    </>
  );
}
