import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { listMyTenants } from "@/lib/tenants";

/** Front door after sign-in: your first workspace, or onboarding if you have none. */
export default async function AppIndexPage() {
  await requireUser("/app");
  const tenants = await listMyTenants();
  redirect(tenants.length > 0 ? `/w/${tenants[0].slug}` : "/onboarding");
}
