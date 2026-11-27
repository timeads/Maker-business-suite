import { hideToolUnlessOpen } from "@/lib/team/guard";

/** Not one of this person's tools: not there at all (docs/roles.md). */
export default async function ShippingLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  await hideToolUnlessOpen(slug, "shipping");
  return children;
}
