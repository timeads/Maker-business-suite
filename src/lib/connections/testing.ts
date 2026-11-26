import type {
  BookExpenseRow,
  BookPaymentRow,
  CustomerRow,
  OrderRow,
  ProductPhotoRow,
  VariantPhotoRow,
  ProductRow,
  SnapshotRow,
  ShippingOrderRow,
  ShopBookingOrder,
  ShopOrderLines,
  StockItemRow,
  StockTagsRow,
  SyncStore,
} from "./types";

/** An in-memory SyncStore for tests: records everything a sync wrote. */
export function memoryStore() {
  const state = {
    customers: [] as CustomerRow[],
    products: [] as ProductRow[],
    orders: [] as OrderRow[],
    stock: [] as StockItemRow[],
    shipping: [] as ShippingOrderRow[],
    snapshots: [] as SnapshotRow[],
    shopBookings: [] as ShopBookingOrder[],
    shopOrderLines: [] as ShopOrderLines[],
    productPhotos: [] as ProductPhotoRow[],
    variantPhotos: [] as VariantPhotoRow[],
    stockTags: [] as StockTagsRow[],
    bookPayments: [] as BookPaymentRow[],
    /** Set to true for a workspace that asked for payments from its books. */
    bookPaymentsWanted: false,
    bookExpenses: [] as { run: string; row: BookExpenseRow }[],
    /** Set to true for a workspace with Money, which reads expenses from its books. */
    bookExpensesWanted: false,
    expenseCloses: [] as { run: string; since: string; entities: string[] }[],
    debtBalances: [] as { asOf: string; accounts: { name: string; cents: number }[] }[],
    /** How many full reads of the orders finished with Money's details. */
    detailsRead: 0,
    redacted: [] as { externalId: string; email: string | null }[],
    purged: 0,
    usage: 0,
    notices: [] as { subject: string; text: string }[],
  };
  const store: SyncStore = {
    async upsertCommerce(batch) {
      state.customers.push(...(batch.customers ?? []));
      state.products.push(...(batch.products ?? []));
      state.orders.push(...(batch.orders ?? []));
    },
    async noteDetailsRead() {
      state.detailsRead += 1;
    },
    async upsertShipping(orders) {
      state.shipping.push(...orders);
    },
    async upsertStock(items) {
      state.stock.push(...items);
    },
    async setProductPhotos(products) {
      state.productPhotos.push(...products);
    },
    async setVariantPhotos(items) {
      state.variantPhotos.push(...items);
    },
    async setStockTags(items) {
      state.stockTags.push(...items);
    },
    async noteShopOrderLines(orders) {
      state.shopOrderLines.push(...orders);
    },
    async bookShopOrders(orders) {
      state.shopBookings.push(...orders);
    },
    async bookPaymentsWanted() {
      return state.bookPaymentsWanted;
    },
    async bookExpensesWanted() {
      return state.bookExpensesWanted;
    },
    async fileBookExpenses(run, rows) {
      state.bookExpenses.push(...rows.map((row) => ({ run, row })));
    },
    async closeBookExpenses(run, since, entities) {
      state.expenseCloses.push({ run, since, entities });
    },
    async importBookPayments(rows) {
      state.bookPayments.push(...rows);
    },
    async saveSnapshots(rows) {
      state.snapshots.push(...rows);
    },
    async noteDebtBalances(asOf, accounts) {
      state.debtBalances.push({ asOf, accounts });
    },
    async redactCustomer(externalId, email) {
      state.redacted.push({ externalId, email });
    },
    async purgeProviderData() {
      state.purged += 1;
    },
    async recordUsage(calls) {
      state.usage += calls;
    },
    async notifyOwners(subject, text) {
      state.notices.push({ subject, text });
    },
  };
  return { store, state };
}
