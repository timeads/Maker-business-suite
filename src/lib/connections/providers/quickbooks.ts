import { ProviderHttpError, requestJson, requiredEnv } from "../http";
import {
  ConnectError,
  ReconnectRequiredError,
  type ConnectedAccount,
  type Fetch,
  type ProviderAdapter,
  type SnapshotRow,
  type TokenSet,
} from "../types";
import {
  parseAgedReceivables,
  parseBalanceSheet,
  parseProfitAndLoss,
  type QuickBooksReport,
} from "./quickbooks-reports";

const SCOPE = "com.intuit.quickbooks.accounting";
const AUTHORIZE_URL = "https://appcenter.intuit.com/connect/oauth2";
const TOKEN_URL = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";
const REVOKE_URL = "https://developer.api.intuit.com/v2/oauth2/tokens/revoke";

const apiBase = () =>
  process.env.QUICKBOOKS_ENVIRONMENT === "production"
    ? "https://quickbooks.api.intuit.com"
    : "https://sandbox-quickbooks.api.intuit.com";

type TokenResponse = {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  x_refresh_token_expires_in?: number;
};

function toTokenSet(response: TokenResponse, now: number): TokenSet {
  return {
    access_token: response.access_token,
    // Intuit rotates refresh tokens: always keep the newest one.
    refresh_token: response.refresh_token,
    expires_at: now + response.expires_in * 1000,
    ...(response.x_refresh_token_expires_in
      ? { refresh_expires_at: now + response.x_refresh_token_expires_in * 1000 }
      : {}),
  };
}

export function createQuickBooksAdapter(fetchImpl: Fetch = fetch): ProviderAdapter {
  const basicAuth = () =>
    "Basic " +
    Buffer.from(
      `${requiredEnv("QUICKBOOKS_CLIENT_ID")}:${requiredEnv("QUICKBOOKS_CLIENT_SECRET")}`,
    ).toString("base64");

  const tokenRequest = (body: Record<string, string>) =>
    requestJson<TokenResponse>(fetchImpl, "QuickBooks", TOKEN_URL, {
      method: "POST",
      headers: {
        Authorization: basicAuth(),
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams(body).toString(),
    });

  type CompanyInfo = { CompanyInfo: { CompanyName: string; Country?: string } };
  async function companyInfo(realmId: string, token: TokenSet) {
    try {
      return await requestJson<CompanyInfo>(
        fetchImpl,
        "QuickBooks",
        `${apiBase()}/v3/company/${encodeURIComponent(realmId)}/companyinfo/${encodeURIComponent(realmId)}?minorversion=75`,
        { headers: { Authorization: `Bearer ${token.access_token}`, Accept: "application/json" } },
      );
    } catch (err) {
      if (err instanceof ProviderHttpError && err.status === 401) {
        throw new ReconnectRequiredError("QuickBooks no longer accepts this company's access");
      }
      throw err;
    }
  }

  async function report(
    realmId: string,
    token: TokenSet,
    name: string,
    params: Record<string, string>,
  ): Promise<QuickBooksReport> {
    const query = new URLSearchParams({ ...params, minorversion: "75" });
    try {
      return await requestJson<QuickBooksReport>(
        fetchImpl,
        "QuickBooks",
        `${apiBase()}/v3/company/${encodeURIComponent(realmId)}/reports/${name}?${query}`,
        { headers: { Authorization: `Bearer ${token.access_token}`, Accept: "application/json" } },
      );
    } catch (err) {
      if (err instanceof ProviderHttpError && err.status === 401) {
        throw new ReconnectRequiredError("QuickBooks no longer accepts this company's access");
      }
      throw err;
    }
  }

  return {
    key: "quickbooks",
    name: "QuickBooks",
    blurb: "Profit and loss, cash and what you're owed",
    connectFields: [],
    // QuickBooks doesn't push changes, so reports are pulled on a schedule.
    pollEveryHours: 6,
    configured: () =>
      Boolean(process.env.QUICKBOOKS_CLIENT_ID && process.env.QUICKBOOKS_CLIENT_SECRET),

    beginConnect({ state, redirectUri }) {
      const url = new URL(AUTHORIZE_URL);
      url.searchParams.set("client_id", requiredEnv("QUICKBOOKS_CLIENT_ID"));
      url.searchParams.set("response_type", "code");
      url.searchParams.set("scope", SCOPE);
      url.searchParams.set("redirect_uri", redirectUri);
      url.searchParams.set("state", state);
      return url.toString();
    },

    async completeConnect({ params, redirectUri }): Promise<ConnectedAccount> {
      const code = params.get("code");
      const realmId = params.get("realmId");
      if (!code || !realmId || !/^\d+$/.test(realmId)) {
        throw new ConnectError("QuickBooks didn't finish connecting. Try again.");
      }
      const now = Date.now();
      const response = await tokenRequest({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
      });
      const token = toTokenSet(response, now);
      const info = await companyInfo(realmId, token);
      return {
        externalAccountId: realmId,
        displayName: info.CompanyInfo.CompanyName,
        scopes: [SCOPE],
        token,
        metadata: info.CompanyInfo.Country ? { country: info.CompanyInfo.Country } : {},
      };
    },

    async refresh(token) {
      if (!token.refresh_token) {
        throw new ReconnectRequiredError("QuickBooks access can't be renewed");
      }
      const now = Date.now();
      try {
        const response = await tokenRequest({
          grant_type: "refresh_token",
          refresh_token: token.refresh_token,
        });
        return toTokenSet(response, now);
      } catch (err) {
        // 400 invalid_grant: the refresh token expired or was revoked.
        if (err instanceof ProviderHttpError && (err.status === 400 || err.status === 401)) {
          throw new ReconnectRequiredError("QuickBooks rejected the saved access for this company");
        }
        throw err;
      }
    },

    async disconnect(token) {
      await requestJson(fetchImpl, "QuickBooks", REVOKE_URL, {
        method: "POST",
        headers: {
          Authorization: basicAuth(),
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ token: token.refresh_token ?? token.access_token }),
      });
    },

    async sync({ externalAccountId, token, store }) {
      const info = await companyInfo(externalAccountId, token);
      const today = new Date();
      const iso = (date: Date) => date.toISOString().slice(0, 10);
      const start = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 12, 1));

      // Three report pulls per sync, cached as snapshots. Dashboards read the
      // cache, never QuickBooks, which keeps us well inside Intuit's limits.
      const [profitAndLoss, balanceSheet, receivables] = await Promise.all([
        report(externalAccountId, token, "ProfitAndLoss", {
          start_date: iso(start),
          end_date: iso(today),
          summarize_column_by: "Month",
        }),
        report(externalAccountId, token, "BalanceSheet", { date_macro: "Today" }),
        report(externalAccountId, token, "AgedReceivables", { report_date: iso(today) }),
      ]);
      const snapshots = [
        ...parseProfitAndLoss(profitAndLoss),
        parseBalanceSheet(balanceSheet, iso(today)),
        parseAgedReceivables(receivables, iso(today)),
      ].filter((row): row is SnapshotRow => row !== null);
      await store.saveSnapshots(snapshots);
      await store.recordUsage(4);

      return {
        account: { displayName: info.CompanyInfo.CompanyName },
        cursor: { synced_through: today.toISOString() },
      };
    },
  };
}
