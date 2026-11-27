import type { SupabaseClient } from "@supabase/supabase-js";
import { loadBrands, pickBrand } from "../brand/brands";
import { BRAND_MODULE, KIT_KEY } from "../brand/kit";
import { canPost } from "../connections/meta-access";
import { accountName } from "./accounts";
import { hasLogo } from "./photo-match";
import { LINKS_KEY, PLAN_KEY, SOCIAL_MODULE, parseLinkPage, parsePlan } from "./plan";
import { REVIEW_KEY } from "./review";
import type { SocialSetupFacts } from "./setup";

const STATUSES = ["active", "needs_reconnect", "disconnected"] as const;

/**
 * Whether TikTok and LinkedIn are offered here: the same test as
 * `tiktokConfigured` / `linkedinConfigured` in their providers, which can't
 * be imported from here without a loop through the connections registry.
 */
export const networksOffered = {
  tiktok: () => Boolean(process.env.TIKTOK_CLIENT_KEY && process.env.TIKTOK_CLIENT_SECRET),
  linkedin: () => Boolean(process.env.LINKEDIN_CLIENT_ID && process.env.LINKEDIN_CLIENT_SECRET),
};

/**
 * The facts the Social checklist is worked out from, read as the member:
 * the main brand's kit, the connections' state and granted permissions
 * (never a token), the accounts in use, and three settings. The logo is
 * looked for only with `deep` (the guided page and the assistant): it reads
 * the asset rows the email header and slip read, and is optional anyway. A
 * part that fails is left out (counted as done), never an error.
 */
export async function loadSocialSetupFacts(
  supabase: SupabaseClient,
  tenant: { id: string },
  opts: { deep?: boolean } = {},
): Promise<SocialSetupFacts> {
  const [brands, kits, connections, accounts, configs, assets] = await Promise.all([
    loadBrands(supabase, tenant.id),
    supabase.from("configs").select("key").eq("tenant_id", tenant.id).eq("module", BRAND_MODULE),
    // Named columns only: members can't read the whole row.
    supabase
      .from("connections")
      .select("provider, status, scopes")
      .eq("tenant_id", tenant.id)
      .in("provider", ["meta", "tiktok", "linkedin"]),
    supabase
      .from("social_accounts")
      .select("id, network, name, handle, needs_login")
      .eq("tenant_id", tenant.id)
      .eq("active", true)
      .limit(200),
    supabase
      .from("configs")
      .select("key, body")
      .eq("tenant_id", tenant.id)
      .eq("module", SOCIAL_MODULE)
      .in("key", [PLAN_KEY, REVIEW_KEY, LINKS_KEY]),
    opts.deep
      ? supabase
          .from("social_assets")
          .select("id, tags, mime_type")
          .eq("tenant_id", tenant.id)
          .eq("hidden", false)
          .like("mime_type", "image/%")
          .order("created_at", { ascending: false })
          .limit(500)
      : Promise.resolve({ data: null, error: null }),
  ]);
  const main = pickBrand(brands);
  const kitKey = main?.kit_key ?? KIT_KEY;
  const byProvider = new Map(
    ((connections.data ?? []) as { provider: string; status: string; scopes: unknown }[]).map(
      (row) => [row.provider, row],
    ),
  );
  const metaRow = byProvider.get("meta");
  const scopes = Array.isArray(metaRow?.scopes) ? (metaRow.scopes as string[]) : [];
  const status = STATUSES.find((s) => s === metaRow?.status) ?? "disconnected";
  const rows = (accounts.data ?? []) as {
    id: string;
    network: string;
    name: string | null;
    handle: string | null;
    needs_login: boolean | null;
  }[];
  const saved = new Map(
    ((configs.data ?? []) as { key: string; body: unknown }[]).map((row) => [row.key, row.body]),
  );
  const known = !configs.error;
  const plan = parsePlan(saved.get(PLAN_KEY));
  const live = (provider: string) => byProvider.get(provider)?.status === "active";

  return {
    kitSaved: kits.error
      ? true
      : ((kits.data ?? []) as { key: string }[]).some((row) => row.key === kitKey),
    meta: connections.error
      ? { status: "active", canPostFacebook: true, canPostInstagram: true }
      : metaRow
        ? {
            status,
            canPostFacebook: canPost("facebook", scopes),
            canPostInstagram: canPost("instagram", scopes),
          }
        : null,
    metaAccounts: accounts.error
      ? 1
      : rows.filter((a) => a.network === "facebook" || a.network === "instagram").length,
    otherAccounts: rows.filter((a) => a.network === "tiktok" || a.network === "linkedin").length,
    needsLogin: rows.filter((a) => a.needs_login).map((a) => ({ id: a.id, name: accountName(a) })),
    tiktok: {
      offered: networksOffered.tiktok(),
      connected: connections.error ? true : live("tiktok"),
    },
    linkedin: {
      offered: networksOffered.linkedin(),
      connected: connections.error ? true : live("linkedin"),
    },
    plan: {
      topics: known ? plan.topics.length : 1,
      monthlyRunOn: known ? plan.review_days.some((day) => day.auto) : true,
    },
    review: { saved: known ? saved.has(REVIEW_KEY) : true },
    links: { published: known ? parseLinkPage(saved.get(LINKS_KEY)).published : true },
    logo:
      opts.deep && !assets.error
        ? hasLogo((assets.data ?? []) as Parameters<typeof hasLogo>[0])
        : null,
  };
}
