import Link from "next/link";
import { notFound } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { requireUser } from "@/lib/auth";
import { MODULES } from "@/lib/modules";
import { canManage, getTenantContext } from "@/lib/tenants";

export default async function WorkspaceHomePage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const user = await requireUser(`/w/${slug}`);
  const ctx = await getTenantContext(slug, user.id);
  if (!ctx) notFound();
  const { tenant, role } = ctx;

  return (
    <>
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">{tenant.name}</h1>
        <p className="text-muted-foreground">
          Your workspace is ready. The tools below switch on as we finish building them.
        </p>
      </header>

      <section aria-label="Modules" className="grid gap-4 sm:grid-cols-2">
        {MODULES.map((m) => (
          <Card key={m.key} className={m.available ? undefined : "border-dashed bg-transparent"}>
            <CardHeader>
              <CardTitle className="text-base">{m.name}</CardTitle>
              <CardDescription>{m.blurb}</CardDescription>
            </CardHeader>
            <CardContent className="text-muted-foreground pt-4 text-xs">
              {m.available ? (
                <Button asChild variant="outline" size="sm">
                  <Link href={`/w/${tenant.slug}/${m.key}`}>Open {m.name}</Link>
                </Button>
              ) : (
                "Coming soon"
              )}
            </CardContent>
          </Card>
        ))}
      </section>

      {canManage(role) && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Bring your team along</CardTitle>
            <CardDescription>
              Invite the people you work with so they&apos;re set up when the first tools arrive.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button asChild variant="outline">
              <Link href={`/w/${tenant.slug}/settings/team`}>Invite a teammate</Link>
            </Button>
          </CardContent>
        </Card>
      )}
    </>
  );
}
