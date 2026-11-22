import { NextResponse } from "next/server";
import {
  bookingsConfigured,
  getPublicService,
  getPublicWorkspace,
  joinWaitlist,
} from "@/lib/bookings/server";
import { getSiteUrl } from "@/lib/site-url";
import { emailSchema } from "@/lib/validation";

const isValidEmail = (value: string) => emailSchema.safeParse(value).success;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(request: Request) {
  const site = await getSiteUrl();
  const formData = await request.formData();
  const field = (name: string) => {
    const value = formData.get(name);
    return typeof value === "string" ? value : "";
  };
  const go = (url: string) => NextResponse.redirect(url, 303);

  if (!bookingsConfigured()) return go(site);
  const tenant = await getPublicWorkspace(field("workspace"));
  if (!tenant) return go(site);
  const service = await getPublicService(tenant.id, field("service"));
  if (!service) return go(`${site}/book/${tenant.slug}`);
  const embed = field("embed") === "1" ? "&embed=1" : "";
  const back = (query: string) =>
    go(`${site}/book/${tenant.slug}/${service.slug}?${query}${embed}`);

  const name = field("name").trim();
  const email = field("email").trim().toLowerCase();
  const sessionId = field("session");
  if (field("website")) return back("error=failed");
  if (!name || name.length > 120 || !isValidEmail(email) || !UUID.test(sessionId)) {
    return back(`error=details&waitlist=${UUID.test(sessionId) ? sessionId : ""}`);
  }
  const ok = await joinWaitlist({ tenantId: tenant.id, sessionId, name, email, seats: 1 });
  return back(ok ? "notice=waitlisted" : "error=gone");
}
