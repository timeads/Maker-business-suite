import { NextResponse } from "next/server";
import { bookingsConfigured, cancelByToken, moveByToken } from "@/lib/bookings/server";
import { getSiteUrl } from "@/lib/site-url";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Change or cancel from the customer's own booking link. */
export async function POST(request: Request) {
  const site = await getSiteUrl();
  const formData = await request.formData();
  const token = String(formData.get("token") ?? "");
  const go = (url: string) => NextResponse.redirect(url, 303);
  if (!bookingsConfigured() || !/^[A-Za-z0-9_-]{20,64}$/.test(token)) return go(site);
  const back = (note: string) => go(`${site}/booking/${token}?note=${note}`);

  if (formData.get("intent") === "cancel") {
    const result = await cancelByToken(token);
    return result === "missing" ? go(site) : back(result);
  }
  const sessionId = String(formData.get("session") ?? "");
  if (!UUID.test(sessionId)) return back("unavailable");
  return back(await moveByToken(token, sessionId));
}
