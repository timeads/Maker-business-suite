import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { requireUser } from "@/lib/auth";
import { currencyOptions, timezoneOptions } from "@/lib/locale-options";
import { canManage, getTenantContext } from "@/lib/tenants";
import { WorkspaceForm } from "./workspace-form";

export const metadata: Metadata = { title: "Workspace settings" };

export default async function WorkspaceSettingsPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const user = await requireUser(`/w/${slug}/settings`);
  const ctx = await getTenantContext(slug, user.id);
  if (!ctx) notFound();
  const { tenant, role } = ctx;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Workspace</CardTitle>
        <CardDescription>
          The basics for your business. Dates and money across the app follow these.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <WorkspaceForm
          key={`${tenant.name}|${tenant.timezone}|${tenant.currency}`}
          slug={tenant.slug}
          canEdit={canManage(role)}
          defaults={{ name: tenant.name, timezone: tenant.timezone, currency: tenant.currency }}
          timezones={timezoneOptions()}
          currencies={currencyOptions()}
        />
      </CardContent>
    </Card>
  );
}
