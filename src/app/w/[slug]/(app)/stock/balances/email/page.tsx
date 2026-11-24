import type { Metadata } from "next";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { GMAIL_WITH_READING } from "@/lib/connections/providers/google-mail";
import {
  MAX_FILE_BYTES,
  MAX_MESSAGES_PER_DAY,
  MAX_MESSAGES_PER_LOOK,
} from "@/lib/stock/mail/message";
import { createClient } from "@/lib/supabase/server";
import { canManage } from "@/lib/tenants";
import { startConnection } from "../../../connections/actions";
import { stockAccess } from "../../gate";
import { clearBillsConfirmation } from "../mail-actions";
import { loadMailFacts, lookFacts } from "../mail-data";
import { BillsAddressBox, SourcesEditor } from "../mail-forms";
import { ConnectReadingForm } from "./connect-form";
import { ManagersOnly, moment } from "../parts";

export const metadata: Metadata = { title: "Bills by email" };

/**
 * Setting up balances that fill themselves in: the workspace's own bills
 * address to forward to (the usual way), who to recognise, and, as an extra
 * for those who want it, reading Gmail directly. Owners and admins only.
 */
export default async function BillsByEmailPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const access = await stockAccess(slug, `/w/${slug}/stock/balances/email`);
  if (!access.ok) return access.upsell;
  const { tenant, role, entitlements } = access;
  const base = `/w/${tenant.slug}/stock/balances`;
  const back = { href: base, label: "Supplier balances" };
  if (!canManage(role)) {
    return (
      <>
        <PageHeader back={back} title="Bills by email" />
        <ManagersOnly />
      </>
    );
  }
  const supabase = await createClient();
  const [mail, { data: supplierRows }] = await Promise.all([
    loadMailFacts(supabase, tenant),
    supabase
      .from("suppliers")
      .select("id, name, archived_at")
      .eq("tenant_id", tenant.id)
      .order("name")
      .limit(1000),
  ]);
  const suppliers = (
    (supplierRows ?? []) as { id: string; name: string; archived_at: string | null }[]
  )
    .filter((s) => !s.archived_at)
    .map((s) => ({ id: s.id, name: s.name }));
  const canEdit = entitlements.canWrite;
  const { lastGood, lastFailed } = lookFacts(mail.reads);
  const confirm = mail.bills?.confirm ?? null;

  return (
    <>
      <PageHeader
        back={back}
        title="Bills by email"
        description="Have your suppliers' invoices, statements and payment notices file themselves on their accounts."
      />

      <Card>
        <CardHeader>
          <CardTitle>How it works</CardTitle>
          <CardDescription>
            Forward a supplier&apos;s email to your own private bills address. Claude reads it (and
            any PDF or picture attached), and what it finds is filed on that supplier&apos;s
            account: an invoice, a statement&apos;s balance, a payment. Anything unclear is marked
            “to check” for you to look over. The email and its files aren&apos;t kept: only who sent
            it, when, its subject and the figures.
          </CardDescription>
        </CardHeader>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>1. Your bills address</CardTitle>
          <CardDescription>
            {mail.bills
              ? "Forward bills here. Treat the address like a password: anyone who has it can send things to your to-check list."
              : "Switch this on to get an address that is yours alone."}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {!mail.forwardingOffered ? (
            <p className="text-muted-foreground text-sm">
              Not available yet: receiving email isn&apos;t set up on this site. You can still
              upload a bill on a supplier&apos;s balance page.
            </p>
          ) : canEdit ? (
            <BillsAddressBox slug={tenant.slug} address={mail.bills?.address ?? null} />
          ) : (
            <p className="text-muted-foreground text-sm">This workspace is read-only right now.</p>
          )}

          {mail.bills && (
            <p className="text-muted-foreground text-xs">
              {mail.bills.lastReceivedAt
                ? `Last message received ${moment(mail.bills.lastReceivedAt, tenant.timezone)}.`
                : "Nothing has arrived at this address yet."}
            </p>
          )}

          {confirm && (
            <div className="border-ochre/30 bg-ochre-soft text-ochre-text font-read flex flex-col gap-1.5 rounded-lg border px-3 py-2 text-sm">
              <p className="font-semibold">Gmail wants to confirm this address</p>
              <p>
                {confirm.account ? `${confirm.account} asked` : "Someone asked"} Gmail to forward
                mail here ({moment(confirm.at, tenant.timezone)}). If that was you, give Gmail the
                code, or open the link yourself. We never open it for you.
              </p>
              {confirm.code && (
                <p>
                  Confirmation code:{" "}
                  <code className="font-mono text-base font-semibold select-all">
                    {confirm.code}
                  </code>
                </p>
              )}
              {confirm.link && (
                <p className="break-all">
                  <a
                    href={confirm.link}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="underline"
                  >
                    {confirm.link}
                  </a>
                </p>
              )}
              {canEdit && (
                <form action={clearBillsConfirmation.bind(null, tenant.slug)}>
                  <button type="submit" className="font-sans text-xs font-semibold underline">
                    Done — put this away
                  </button>
                </form>
              )}
            </div>
          )}

          {mail.bills && (
            <div className="text-sm">
              <p className="font-semibold">Forwarding automatically from Gmail</p>
              <ol className="font-read text-text-2 mt-1 list-decimal space-y-0.5 pl-5">
                <li>
                  In Gmail, open Settings → See all settings → Forwarding and POP/IMAP → “Add a
                  forwarding address”, and paste your bills address.
                </li>
                <li>
                  Gmail emails a confirmation code to the address. It shows up on this page within a
                  minute or two: refresh, then type the code into Gmail.
                </li>
                <li>
                  Leave Gmail&apos;s forwarding itself set to “Disable forwarding”. Instead, make a
                  filter: Settings → Filters and Blocked Addresses → Create a new filter. In “From”
                  put a supplier&apos;s address, press “Create filter”, tick “Forward it to” and
                  pick your bills address.
                </li>
                <li>
                  Make one filter per supplier (and one for your bank&apos;s payment notices).
                </li>
              </ol>
              <p className="text-muted-foreground mt-1.5 text-xs">
                Any mail provider&apos;s forwarding works the same way, and so does forwarding a
                single email by hand. Up to {MAX_MESSAGES_PER_DAY} messages a day are read; PDFs,
                PNGs and JPEGs up to {Math.round(MAX_FILE_BYTES / 1024 / 1024)} MB each.
              </p>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>2. Who to recognise</CardTitle>
          <CardDescription>
            Tell us which address each supplier&apos;s bills come from, so a forwarded email lands
            on the right account. Mail from anyone not listed here isn&apos;t filed anywhere: it
            waits on the Balances page for you to say whose it is.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {canEdit ? (
            <SourcesEditor
              slug={tenant.slug}
              initial={mail.sources}
              suppliers={suppliers}
              canTry={mail.gmail === "can_read"}
              showGmail={mail.gmailOffered}
            />
          ) : (
            <p className="text-muted-foreground text-sm">This workspace is read-only right now.</p>
          )}
        </CardContent>
      </Card>

      {mail.gmailOffered && (
        <Card>
          <CardHeader>
            <CardTitle className="flex flex-wrap items-center gap-2">
              Optional: let us read your Gmail instead of forwarding
              {mail.readingOn ? (
                <Badge tone="good">On</Badge>
              ) : mail.gmail === "can_read" ? (
                <Badge tone="waiting">Permission given, switched off</Badge>
              ) : (
                <Badge>Off</Badge>
              )}
            </CardTitle>
            <CardDescription>
              With your say-so, Gmail can be read once a day for mail from the senders listed above
              — only those searches, never the rest of your mailbox, and nothing in it is ever
              changed. It needs a wider permission from Google than sending orders does, so it is
              off unless you ask for it. Forwarding needs no permission at all.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-2 text-sm">
            {mail.gmail === "can_read" ? (
              <p className="font-read text-text-2">
                Gmail has given permission to read.{" "}
                {mail.sources.enabled
                  ? `It is read once a day (up to ${MAX_MESSAGES_PER_LOOK} messages a read).`
                  : "Tick “Read supplier emails from my Gmail once a day” above and save to start."}{" "}
                {lastGood && `Last read ${moment(lastGood.at, tenant.timezone)}.`}
                {lastFailed && ` The last read didn't finish: ${lastFailed.error}`}
              </p>
            ) : (
              <>
                <p className="font-read text-text-2">
                  {mail.gmail === "send_only"
                    ? "Your Gmail is connected for sending orders only. To let it read as well, connect it again with reading switched on; sending keeps working."
                    : mail.gmail === "needs_reconnect"
                      ? "Your Gmail needs connecting again."
                      : "Gmail isn't connected."}
                </p>
                {canEdit && (
                  <ConnectReadingForm
                    action={startConnection.bind(null, tenant.slug, "google_mail")}
                    access={GMAIL_WITH_READING}
                  />
                )}
              </>
            )}
            <p className="text-muted-foreground text-xs">
              To take the permission back, connect Gmail again under{" "}
              <Link href={`/w/${tenant.slug}/connections`} className="underline">
                Connections
              </Link>{" "}
              choosing “Send purchase orders only”, or disconnect it.
            </p>
          </CardContent>
        </Card>
      )}
    </>
  );
}
