import type { SupabaseClient } from "@supabase/supabase-js";
import type { ShopOrderLines } from "../connections/types";
import { sendEmail } from "../email";
import { postAlert } from "../messages/alerts";
import { moduleOpen } from "../module-access";
import { queueCancelEmails } from "./shop";

/**
 * Shop orders that paid for a workshop without a usable date on the cart
 * line ("Buy again", a quick-add button, an invoice made by hand). The
 * database writes each such line down once (`note_shop_undated_lines`) and
 * keeps a booking a manager made from one in step with the order; this tells
 * the team about the new ones. A paid place is never dropped, and nothing
 * here may stop a sync.
 */

type Noted = {
  new: { order_name: string; service_name: string | null; seats: number }[];
  cancelled: string[];
  known: number;
};

export const places = (n: number) => (n === 1 ? "1 place" : `${n} places`);

/** One line of plain words for the team, per new order line. */
export function needsDateWords(line: Noted["new"][number]): string {
  const what = line.service_name ?? "a workshop";
  return `Order ${line.order_name || "from your shop"} paid for ${what} (${places(line.seats)}) without a date we can use, so nobody is booked in yet. It's waiting under Bookings → Needs a date: ask them which date they'd like and put them on it.`;
}

export async function noteShopOrderLines(
  admin: SupabaseClient,
  tenantId: string,
  provider: string,
  orders: ShopOrderLines[],
  deps: {
    open?: (tenantId: string) => Promise<boolean>;
    alert?: typeof postAlert;
    mail?: typeof sendEmail;
  } = {},
): Promise<void> {
  if (orders.length === 0) return;
  const { data, error } = await admin.rpc("note_shop_undated_lines", {
    p_tenant_id: tenantId,
    p_provider: provider,
    p_orders: orders.map((order) => ({
      order_id: order.external_id,
      name: order.name,
      cancelled: order.cancelled,
      lines: order.lines,
    })),
  });
  if (error) throw new Error(`note_shop_undated_lines failed: ${error.message}`);
  const noted = (data ?? { new: [], cancelled: [], known: 0 }) as Noted;
  if (noted.new.length === 0 && noted.cancelled.length === 0) return;

  // Written down whatever the plan; only the emails wait for it.
  const open = await (deps.open ?? ((id) => moduleOpen(id, "bookings")))(tenantId);
  if (open) await queueCancelEmails(admin, tenantId, noted.cancelled);
  if (noted.new.length === 0) return;

  const alert = deps.alert ?? postAlert;
  for (const line of noted.new) await alert(admin, tenantId, "bookings", needsDateWords(line));
  if (!open) return;
  try {
    const { data: owners } = await admin.rpc("tenant_owner_emails", { p_tenant_id: tenantId });
    const count = noted.new.length;
    const subject =
      count === 1
        ? `Needs a date: order ${noted.new[0].order_name}`
        : `${count} workshop orders need a date`;
    const text = [
      ...noted.new.map(needsDateWords),
      "",
      "This usually happens when someone uses “Buy again” in your shop, which adds a past order to the cart without its date.",
    ].join("\n\n");
    for (const { email } of (owners ?? []) as { email: string }[]) {
      await (deps.mail ?? sendEmail)({ to: email, subject, text });
    }
  } catch (err) {
    // The line is written down and the heads-up is posted; an email that didn't go changes nothing.
    console.error(
      `Could not email about undated orders: ${err instanceof Error ? err.message : "unknown"}`,
    );
  }
}
