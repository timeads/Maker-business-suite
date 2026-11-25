import Link from "next/link";
import { notFound } from "next/navigation";
import { SectionHeading } from "@/components/settings/section-heading";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { requireUser } from "@/lib/auth";
import { getEntitlements, type Feature } from "@/lib/entitlements";
import { getTenantContext } from "@/lib/tenants";

export type Pointer = { name: string; about: string; href: string };

/**
 * A tool's entry in Settings when the tool has no settings screen of its own:
 * what you set up for it is done where you work, so this says where. `feature`
 * is the plan's gate; a tool that isn't on the plan has no page here.
 */
export async function WhereThingsLive({
  slug,
  path,
  feature,
  tool,
  title,
  description,
  pointers,
}: {
  slug: string;
  /** What follows `/settings/`. */
  path: string;
  feature?: Feature;
  /** The tool to go back to; `href` is what follows `/w/<slug>/`. */
  tool: { href: string; label: string };
  title: string;
  description: string;
  /** Each `href` is what follows `/w/<slug>/`. */
  pointers: Pointer[];
}) {
  const user = await requireUser(`/w/${slug}/settings/${path}`);
  const ctx = await getTenantContext(slug, user.id);
  if (!ctx) notFound();
  if (feature && !(await getEntitlements(ctx.tenant.id)).can(feature)) notFound();
  const base = `/w/${ctx.tenant.slug}`;
  return (
    <>
      <SectionHeading
        back={{ href: `${base}/${tool.href}`, label: tool.label }}
        title={title}
        description={description}
      />
      <Card>
        <CardHeader>
          <CardTitle>Where to change things</CardTitle>
          <CardDescription>
            Nothing for {title} is set on this page. Each of these is changed where you use it.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ul className="divide-border flex flex-col divide-y text-sm">
            {pointers.map((pointer) => (
              <li key={pointer.name} className="flex flex-col gap-0.5 py-2.5 first:pt-0 last:pb-0">
                <Link
                  href={`${base}/${pointer.href}`}
                  className="text-ochre-text w-fit font-semibold hover:underline"
                >
                  {pointer.name}
                </Link>
                <span className="text-muted-foreground font-read">{pointer.about}</span>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </>
  );
}
