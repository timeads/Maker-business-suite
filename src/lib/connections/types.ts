export type ProviderKey =
  | "shopify"
  | "quickbooks"
  | "stripe"
  | "meta"
  | "easypost"
  | "ups"
  | "redo"
  | "google_mail"
  | "michaels"
  | "twilio"
  | "eventbrite"
  | "tiktok"
  | "linkedin";

export type ConnectionStatus = "active" | "needs_reconnect" | "disconnected";

/** What we keep in Vault for a connection. Never logged, never sent to a browser. */
export type TokenSet = {
  access_token: string;
  refresh_token?: string;
  /** Epoch milliseconds; absent for tokens that don't expire. */
  expires_at?: number;
  refresh_expires_at?: number;
  /**
   * For a connection made of several typed-in keys (UPS's client id, secret
   * and account number): the parts beside the token, by name. Kept in Vault
   * with the rest, and just as secret.
   */
  secrets?: Record<string, string>;
};

export type ConnectedAccount = {
  externalAccountId: string;
  displayName: string;
  scopes: string[];
  token: TokenSet;
  metadata?: Record<string, unknown>;
};

export type ConnectStart = {
  state: string;
  redirectUri: string;
  /** Provider-specific input from the connect form (Shopify's shop domain). */
  input: Record<string, string>;
};

export type ConnectFinish = {
  /** Query parameters the provider sent to our callback. */
  params: URLSearchParams;
  redirectUri: string;
  /** What we stored when the flow started. */
  input: Record<string, string>;
};

export type CustomerRow = {
  external_id: string;
  email: string | null;
  first_name: string | null;
  last_name: string | null;
  source_created_at: string | null;
  source_updated_at: string | null;
};

export type ProductRow = {
  external_id: string;
  title: string;
  vendor: string | null;
  product_type: string | null;
  status: string | null;
  source_updated_at: string | null;
  /** The product's tags in the shop. Left out by a sender that didn't read them. */
  tags?: string[];
};

export type OrderLineRow = {
  external_id: string;
  product_external_id: string | null;
  title: string;
  variant_title: string | null;
  sku: string | null;
  quantity: number;
  unit_price: number;
  unit_cost: number | null;
  /** The Bookings date's id the product page put on the cart line, when it has one. */
  session_ref?: string | null;
  /** A date written on the cart line (YYYY-MM-DD), for a class booked another way. */
  class_date?: string | null;
};

export type OrderRow = {
  external_id: string;
  name: string | null;
  customer_external_id: string | null;
  email: string | null;
  processed_at: string;
  currency: string | null;
  net_sales: number;
  total_tax: number;
  total_shipping: number;
  total: number;
  /** The products before discounts, and the discounts, when the shop gives them. */
  gross_sales?: number | null;
  total_discounts?: number | null;
  financial_status: string | null;
  fulfillment_status: string | null;
  channel: string;
  cancelled_at: string | null;
  is_test: boolean;
  source_updated_at: string | null;
  /** The order's tags in the shop. Left out by a sender that didn't read them. */
  tags?: string[];
  lines: OrderLineRow[];
};

export type SnapshotRow = {
  kind: "profit_and_loss" | "balance_sheet" | "ar_aging" | "cash_flow";
  period_start: string;
  period_end: string;
  data: Record<string, unknown>;
};

/** One thing the shop keeps a count of (a product, or one option of it). */
export type StockItemRow = {
  external_id: string;
  product_external_id: string | null;
  inventory_item_id: string | null;
  title: string;
  variant_title: string | null;
  sku: string | null;
  on_hand: number;
  unit_cost: number | null;
  tracked: boolean;
  product_status: string | null;
  /** Who the shop says it comes from; becomes a supplier. */
  vendor: string | null;
  price: number | null;
};

/** Money paid out to a supplier, as the books record it. */
export type BookPaymentRow = {
  /** The books' own id for the record, and what kind of record it is. */
  external_id: string;
  kind: string;
  /** YYYY-MM-DD. */
  date: string;
  /** Who it was made out to, as the books name them. */
  payee: string;
  amount: number;
  memo: string;
};

/**
 * Money going out, as the books record it, for Money's expense inbox. Amounts
 * in whole cents. Transfers and card payments are moves between the
 * business's own accounts, kept marked and never counted as expenses.
 */
export type BookExpenseRow = {
  /** The books' own kind of record and its id: together, the key. */
  entity: string;
  external_id: string;
  kind: "purchase" | "bill" | "journal" | "transfer" | "card_payment";
  /** Purchases only: Cash, Check or CreditCard, as the books say. */
  payment_type: string | null;
  /** YYYY-MM-DD, the books' own day. */
  date: string;
  amount_cents: number;
  /** The account of the first line (for a move, the account paid into). */
  account: string | null;
  payee: string | null;
  memo: string;
  /** Moves only: the account the money left. */
  from_account: string | null;
  lines: { account: string | null; amount_cents: number; description: string }[];
};

/** A product's tags in the shop, noted on each of its stock items. */
export type StockTagsRow = { product_external_id: string; tags: string[] };

/** One option's own photo (a product with several colours has one each). */
export type VariantPhotoRow = { external_id: string; image_url: string | null };

export type ProductPhotoRow = {
  product_external_id: string;
  image_url: string | null;
  product_url: string | null;
};

/** What packing an order needs: who it's for and what is left to send. */
export type ShippingOrderRow = {
  external_id: string;
  recipient: string | null;
  company: string | null;
  address1: string | null;
  address2: string | null;
  city: string | null;
  region: string | null;
  postal_code: string | null;
  country_code: string | null;
  phone: string | null;
  /** The option the shopper picked at checkout. */
  shipping_method: string | null;
  /** What they paid for it. */
  shipping_paid: number | null;
  weight_grams: number | null;
  /** They're collecting it, so there's nothing to post. */
  pickup: boolean;
  note: string | null;
  paid: boolean;
  /** The shop's own tags on the order. */
  tags?: string[] | null;
  items: {
    line_id: string;
    title: string;
    variant: string | null;
    sku: string | null;
    barcode: string | null;
    /** What one of them cost the shopper. */
    price: number | null;
    /** A small picture of the option that was ordered, on the shop's image servers. */
    image?: string | null;
    qty: number;
    left: number;
  }[];
};

/**
 * A shop order that carries workshop dates: each line names the date it is
 * for (the date picker on the product page put it there).
 */
export type ShopBookingOrder = {
  external_id: string;
  /** The order number as the shopper sees it, e.g. #1042. */
  name: string;
  cancelled: boolean;
  customer_name: string;
  email: string | null;
  lines: {
    session_id: string;
    seats: number;
    amount_cents: number;
    /** A number for text reminders from the cart line, and whether the box was ticked. */
    text?: { phone: string; agreed: boolean };
  }[];
};

/**
 * Every line of a shop order with the date it carries, if any, so Bookings
 * can spot a workshop paid for without one. The database decides which lines
 * matter; nothing here says anything about who bought.
 */
export type ShopOrderLines = {
  external_id: string;
  /** The order number as the shopper sees it, e.g. #1042. */
  name: string;
  cancelled: boolean;
  lines: {
    line_id: string;
    product_id: string | null;
    /** What the order holds now: 0 once refunded. */
    seats: number;
    /** The date's id from the cart line, only when it has the shape of one. */
    session_id: string | null;
  }[];
};

/** Where a sync puts what it fetched. Always scoped to the job's workspace and provider. */
export type SyncStore = {
  upsertCommerce(batch: {
    customers?: CustomerRow[];
    products?: ProductRow[];
    orders?: OrderRow[];
  }): Promise<void>;
  upsertStock(items: StockItemRow[]): Promise<void>;
  /** Each product's main photo and its page in the shop. */
  setProductPhotos(products: ProductPhotoRow[]): Promise<void>;
  /** Each option's own photo, for the reorder list. */
  setVariantPhotos(items: VariantPhotoRow[]): Promise<void>;
  /** Each product's shop tags, for "never reorder anything tagged X". */
  setStockTags(items: StockTagsRow[]): Promise<void>;
  /** Turns orders with workshop dates on them into bookings. Safe to repeat. */
  bookShopOrders(orders: ShopBookingOrder[]): Promise<void>;
  /**
   * Writes down workshop lines that came with no usable date, and keeps a
   * booking made from one in step with its order. For orders already stored
   * with upsertCommerce. Safe to repeat.
   */
  noteShopOrderLines(orders: ShopOrderLines[]): Promise<void>;
  /**
   * Notes that a full read of the orders has finished with everything Money
   * needs from them (tags, products' tags, class dates), so the one-off
   * backfill of a shop's history isn't asked for again.
   */
  noteDetailsRead(): Promise<void>;
  /** For orders already stored with upsertCommerce. */
  upsertShipping(orders: ShippingOrderRow[]): Promise<void>;
  saveSnapshots(rows: SnapshotRow[]): Promise<void>;
  /**
   * Payments to suppliers read from the books, for Stock's Balances tab. The
   * database files only those the workspace asked for and can match.
   */
  importBookPayments(rows: BookPaymentRow[]): Promise<void>;
  /** Has the workspace asked for that? If not, the books aren't read for payments at all. */
  bookPaymentsWanted(): Promise<boolean>;
  /** Does the workspace have Money? If not, the books aren't read for expenses at all. */
  bookExpensesWanted(): Promise<boolean>;
  /**
   * Expenses read from the books in one read (`run`). Upserted by the books'
   * own ids; the workspace's rules sort new ones that nobody has sorted yet.
   */
  fileBookExpenses(run: string, rows: BookExpenseRow[]): Promise<void>;
  /**
   * After a complete read of these kinds since `since`: anything stored for
   * them in that window that this read didn't see is gone from the books.
   */
  closeBookExpenses(run: string, since: string, entities: string[]): Promise<void>;
  /**
   * The books' liability accounts as of a day, for Money's debts. The
   * database keeps a balance only for a debt linked to one of them.
   */
  noteDebtBalances(asOf: string, accounts: { name: string; cents: number }[]): Promise<void>;
  /** Erases one shopper's personal details, keeping the sales figures. */
  redactCustomer(externalId: string, email: string | null): Promise<void>;
  /** Deletes everything synced from this provider for the workspace. */
  purgeProviderData(): Promise<void>;
  /** Counts API calls made, for usage limits. */
  recordUsage(calls: number): Promise<void>;
  notifyOwners(subject: string, text: string): Promise<void>;
};

export type SyncContext = {
  store: SyncStore;
  connectionId: string;
  externalAccountId: string;
  token: TokenSet;
  job: {
    type: "full" | "incremental" | "webhook";
    topic: string | null;
    payload: unknown;
    cursor: unknown;
  };
};

export type SyncResult = {
  cursor?: Record<string, unknown>;
  /** Fresh details to show about the connected account. */
  account?: { displayName?: string; metadata?: Record<string, unknown> };
  /** Set when there is more to fetch: the job is re-queued with this cursor. */
  continueWith?: Record<string, unknown>;
  /**
   * What the provider says the connection is granted right now, when the sync
   * asked. Recorded as the connection's `scopes`; absent when it couldn't ask.
   */
  scopes?: string[];
  /** Set when the provider told us the connection is over (app uninstalled). */
  disconnected?: string;
};

/** A provider said the tokens are no longer good: the owner must reconnect. */
export class ReconnectRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReconnectRequiredError";
  }
}

/** The person connecting did something we can explain to them. */
export class ConnectError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConnectError";
  }
}

/**
 * Every integration implements this (CLAUDE.md rule 9). `connect` is split in
 * two because OAuth leaves our site and comes back.
 */
export interface ProviderAdapter {
  key: ProviderKey;
  name: string;
  blurb: string;
  /** Extra fields the connect form asks for. */
  connectFields: {
    name: string;
    label: string;
    placeholder: string;
    help?: string;
    /** Typed into a password box: an API key, never shown again. */
    secret?: boolean;
    /** A short list to pick from instead of a box to type in; the first is the usual choice. */
    options?: { value: string; label: string }[];
    /** Never drawn on the Connections page: set by the screen that starts the connection. */
    hidden?: boolean;
  }[];
  /** True when this environment has the provider's app credentials. */
  configured(): boolean;
  /**
   * Not every deployment has this one. Where its credentials aren't set it is
   * left off the Connections page altogether, rather than shown as "not
   * available yet".
   */
  optional?: boolean;
  /** Nothing is ever pulled from it: no "last synced", no "Sync now". */
  nothingToSync?: boolean;
  /**
   * One connection holding several logins (TikTok, LinkedIn): connecting
   * again ADDS a login (or renews that one) instead of replacing the
   * connection, and each login's tokens sit under "login:<id>"
   * (`lib/connections/logins.ts`). `refresh` is then called with one
   * login's token set and that login's id.
   */
  multiLogin?: boolean;
  /**
   * The provider wants PKCE: the connect flow makes a one-time verifier and
   * hands it to `beginConnect` and `completeConnect` as `input.pkce_verifier`
   * (kept meanwhile in the httpOnly, path-scoped state cookie).
   */
  pkce?: boolean;
  /**
   * For a connection made with a pasted key: what disconnecting means, for
   * the "are you sure?" question. Without it the page uses its usual words.
   */
  disconnectNote?: string;
  /**
   * One line about the connection worth showing under it, worked out from its
   * (never secret) details: how long a key has left, say. `today` is the
   * workspace's own day, YYYY-MM-DD.
   */
  statusNote?(
    metadata: Record<string, unknown>,
    today: string,
  ): { tone: "good" | "waiting" | "bad"; text: string } | null;
  /**
   * What a reconnect should ask for again without being told: a connection
   * that was granted something optional keeps it when it is renewed from the
   * Connections page. Worked out from the scopes on record.
   */
  reconnectInput?(scopes: string[]): Record<string, string>;
  /**
   * Where in the workspace to land after connecting, when it isn't the
   * Connections page (a path under `/w/<slug>/`, from a fixed list of ours).
   */
  returnPath?(input: Record<string, string>): string | null;
  /** Where to send the person to approve the connection. */
  beginConnect(start: ConnectStart): string;
  /** Exchanges the callback for tokens and identifies the account. */
  completeConnect(finish: ConnectFinish): Promise<ConnectedAccount>;
  /**
   * For providers that connect with a pasted API key rather than by sending
   * the person away to approve: checks the key and identifies the account in
   * one step. The key comes back as the token, so it is stored in Vault like
   * any other. When this is present, `beginConnect` is never used.
   */
  connectWithKey?(input: Record<string, string>): Promise<ConnectedAccount>;
  /** Runs once after a connection is saved (register webhooks, ...). */
  afterConnect?(account: ConnectedAccount, siteUrl: string): Promise<void>;
  /**
   * Runs once after a connection is saved, with the workspace named, for what
   * the provider's login said about the workspace's accounts (Meta's Pages).
   * Service-role calls only, each naming the workspace.
   */
  afterSaved?(
    where: { tenantId: string; admin: import("@supabase/supabase-js").SupabaseClient },
    account: ConnectedAccount,
  ): Promise<void>;
  /** Returns new tokens. Throws ReconnectRequiredError when they can't be renewed. */
  refresh(token: TokenSet, externalAccountId: string): Promise<TokenSet>;
  /**
   * Asks the provider which permissions the connection really has now (the
   * raw answer; the database keeps only the reading half for a watch-only
   * connection). Throws when the provider can't say.
   */
  grantedScopes?(token: TokenSet, externalAccountId: string): Promise<string[]>;
  /** Best-effort revoke on the provider's side. */
  disconnect(token: TokenSet, externalAccountId: string): Promise<void>;
  /** For a `multiLogin` provider: best-effort revoke of one login's own tokens. */
  disconnectLogin?(login: TokenSet, loginId: string): Promise<void>;
  sync(ctx: SyncContext): Promise<SyncResult>;
  /** Webhook topics that are handled without a token (it may already be dead). */
  tokenlessTopics?: readonly string[];
  /** How often to pull when the provider doesn't push changes. Null = webhook-driven. */
  pollEveryHours: number | null;
}

export type Fetch = typeof fetch;
