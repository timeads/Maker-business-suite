import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { FormMessage } from "@/components/ui/form-message";
import { requireUser } from "@/lib/auth";
import { PROVIDER_ORDER, getAdapter, isProviderKey } from "@/lib/connections/registry";
import type { ConnectionStatus, ProviderKey } from "@/lib/connections/types";
import { getEntitlements } from "@/lib/entitlements";
import { createClient } from "@/lib/supabase/server";
import { canManage, getTenantContext } from "@/lib/tenants";
import { cn } from "@/lib/utils";
import { ConnectForm, ConnectionActions } from "./connection-forms";

export const metadata: Metadata = { title: "Connections" };

type ConnectionRow = {
  provider: string;
  external_account_id: string;
  display_name: string | null;
  status: ConnectionStatus;
  last_synced_at: string | null;
  last_error: string | null;
};

const ERRORS: Record<string, (name: string) => string> = {
  expired: () => "That connection attempt timed out. Start it again from here.",
  not_allowed: () => "Only owners and admins can manage connections.",
  read_only: () => "This workspace is read-only because its plan has ended.",
  declined: (name) => `${name} wasn't connected because the request was declined.`,
  rejected: (name) => `We couldn't confirm ${name}'s response. Try connecting again.`,
  in_use: (name) =>
    `That ${name} account is already connected to another workspace. Disconnect it there first.`,
  failed: (name) => `Something went wrong connecting ${name}. Try again in a moment.`,
};

function StatusBadge({ status }: { status: ConnectionStatus | "none" }) {
  const label =
    status === "active"
      ? "Connected"
      : status === "needs_reconnect"
        ? "Needs reconnecting"
        : "Not connected";
  return (
    <span
      className={cn(
        "rounded-full px-2 py-0.5 text-xs font-medium",
        status === "active" && "bg-primary/10 text-primary",
        status === "needs_reconnect" && "bg-destructive/10 text-destructive",
        (status === "none" || status === "disconnected") && "bg-muted text-muted-foreground",
      )}
    >
      {label}
    </span>
  );
}

export default async function ConnectionsPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{
    connected?: string;
    error?: string;
    provider?: string;
    warning?: string;
  }>;
}) {
  const { slug } = await params;
  const query = await searchParams;
  const user = await requireUser(`/w/${slug}/connections`);
  const ctx = await getTenantContext(slug, user.id);
  if (!ctx) notFound();
  const { tenant, role } = ctx;
  const manager = canManage(role);
  const entitlements = await getEntitlements(tenant.id);

  const supabase = await createClient();
  const { data } = await supabase
    .from("connections")
    .select("provider, external_account_id, display_name, status, last_synced_at, last_error")
    .eq("tenant_id", tenant.id);
  const rows = new Map(((data as ConnectionRow[] | null) ?? []).map((row) => [row.provider, row]));

  const timeFormat = new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: tenant.timezone,
  });
  const nameOf = (key: string | undefined) =>
    isProviderKey(key) ? getAdapter(key).name : "That account";

  const serverReady = Boolean(process.env.SUPABASE_SECRET_KEY);

  return (
    <>
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Connections</h1>
        <p className="text-muted-foreground">
          Link the tools you already use. You sign in with them directly — we never see your
          password, and you can disconnect at any time.
        </p>
      </header>

      {query.connected && isProviderKey(query.connected) && (
        <FormMessage kind="success">
          {query.warning
            ? `${nameOf(query.connected)} is connected, but we couldn't switch on live updates. Use Sync now, or reconnect to try again.`
            : `${nameOf(query.connected)} is connected. The first sync is underway.`}
        </FormMessage>
      )}
      {query.error && ERRORS[query.error] && (
        <FormMessage>{ERRORS[query.error](nameOf(query.provider))}</FormMessage>
      )}

      <div className="flex flex-col gap-4">
        {PROVIDER_ORDER.map((key: ProviderKey) => {
          const adapter = getAdapter(key);
          const row = rows.get(key);
          const status = row?.status ?? "none";
          const live = status === "active" || status === "needs_reconnect";
          const available = adapter.configured() && serverReady;

          return (
            <Card key={key}>
              <CardHeader>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <CardTitle>{adapter.name}</CardTitle>
                  <StatusBadge status={status} />
                </div>
                <CardDescription>{adapter.blurb}</CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-4">
                {live && row && (
                  <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-[auto_1fr]">
                    <dt className="text-muted-foreground">Account</dt>
                    <dd>
                      {row.display_name ?? row.external_account_id}
                      {row.display_name && (
                        <span className="text-muted-foreground"> ({row.external_account_id})</span>
                      )}
                    </dd>
                    <dt className="text-muted-foreground">Last synced</dt>
                    <dd>
                      {row.last_synced_at
                        ? `${timeFormat.format(new Date(row.last_synced_at))}`
                        : "Not yet"}
                    </dd>
                  </dl>
                )}

                {status === "needs_reconnect" && (
                  <FormMessage>
                    {adapter.name} stopped accepting our access, so its data isn&apos;t updating.
                    Reconnect to pick up where it left off.
                  </FormMessage>
                )}
                {status === "active" && row?.last_error && (
                  <p className="text-muted-foreground text-sm">
                    The last sync didn&apos;t finish. We&apos;ll keep trying.
                  </p>
                )}

                {!available ? (
                  <p className="text-muted-foreground text-sm">
                    {adapter.name} isn&apos;t available in this environment yet.
                  </p>
                ) : !manager ? (
                  <p className="text-muted-foreground text-sm">
                    Only owners and admins can manage connections.
                  </p>
                ) : (
                  <>
                    {status !== "active" && entitlements.canWrite && (
                      <ConnectForm
                        slug={tenant.slug}
                        provider={key}
                        providerName={adapter.name}
                        fields={adapter.connectFields}
                        label={live ? `Reconnect ${adapter.name}` : `Connect ${adapter.name}`}
                      />
                    )}
                    {live && (
                      <ConnectionActions
                        slug={tenant.slug}
                        provider={key}
                        providerName={adapter.name}
                        canSync={status === "active"}
                      />
                    )}
                  </>
                )}
              </CardContent>
            </Card>
          );
        })}
      </div>
    </>
  );
}
