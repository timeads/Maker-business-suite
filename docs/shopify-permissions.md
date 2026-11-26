# Shopify permissions: what a shop really granted

Three tools write to a shop, each only with its own permission:

| Tool and screen                                           | Gate (app / database)                                        | Scope(s)                                    |
| --------------------------------------------------------- | ------------------------------------------------------------ | ------------------------------------------- |
| Bookings → Order tags (`settings/bookings/shop-tags`)     | `canTagInShopify` / `private.shop_can_tag_orders`            | `write_orders`                              |
| Shipping: mark sent, pickups, voids (`settings/shipping`) | `canSendInShopify` / `private.shop_can_fulfil`               | `write_merchant_managed_fulfillment_orders` |
| Stock: add checked-in deliveries (`settings/stock`)       | `canWriteShopifyStock` (app only, when a delivery is queued) | `write_inventory` + `read_locations`        |

Every gate reads the connection's `scopes`. This page is about making that
column true.

## What we found

Our Shopify apps use **Shopify-managed installation**
(`use_legacy_install_flow = false`). On staging, putting `write_orders` in
the authorize link's `scope` parameter did nothing: the shop got exactly the
scopes in the app's released version, after the merchant approved them.
Shopify's docs say the same (shopify.dev, "App configuration", read through
the Shopify docs search on 2026-11-26):

> `use_legacy_install_flow` … When omitted or false, scopes are saved in your
> app's configuration, and are automatically requested when the app is
> installed on a store or when you update the scopes value. This is referred
> to as Shopify managed installation. When true, the legacy installation flow
> requests scopes through a URL parameter during the OAuth flow.

So what we asked for, and even the token response's `scope`, can differ from
what the store allows.

## What the suite does now

- **The connection's `scopes` is what the store reports**, from the Admin
  GraphQL `currentAppInstallation { accessScopes { handle } }`
  (`lib/connections/providers/shopify-scopes.ts`). Shopify: "To see what an
  installation actually has, query currentAppInstallation in the GraphQL
  Admin API."
  - after connecting (in the same question as the shop's name);
  - after each scheduled read of the shop finishes (`syncShopify`; one small
    question, allowed to fail: the read still counts and the scopes on record
    stand). An app update the merchant approves reaches every gate within
    about an hour, without a reconnect; a permission taken back goes the
    same way;
  - when an owner or admin presses **Check again** on one of the screens
    above (`checkShopPermissions` in `connections/actions.ts`).
- All three write through `record_granted_scopes` (migration
  `20270128000600`), which names the workspace, and stamps
  `metadata.scopes_checked_at`. A scope Shopify didn't report counts as not
  granted; if Shopify can't answer, nothing is changed.
- **Watch only stays watch only.** Under managed installation a watch-only
  connection gets the same scopes as any other. Both the app
  (`usableShopifyScopes`) and the database keep only `read_*` scopes for a
  connection with `metadata.watch_only`, so no gate ever passes for one.
- **The screens say what happened.** Each connection keeps what it asked for
  (`metadata.asked_scopes`). `lib/connections/shop-permission.ts` works out
  one of: allowed, not connected, needs connecting again, watch only,
  _asked and Shopify didn't give it_, or not granted; `ShopPermissionNote`
  shows the words, what to do next and "Check again". Once Shopify has said
  no, the order-tags screen stops offering "Connect my shop again" (it would
  only loop) and says to approve the app's update in Shopify, or that the
  permission isn't on offer yet.

Nothing here writes to a shop: it only changes which permissions we believe
we have.

## What the app owner sets in the Shopify Dev Dashboard

Whatever the code asks for, under managed installation the **app version**
decides. For each version you release:

### Today (managed installation, no optional scopes)

- **Required scopes** (`scopes`): the read scopes every workspace needs
  (`read_orders`, `read_customers`, `read_products`, `read_inventory`, plus
  `read_all_orders` once approved) **and every write scope any tool may
  use**: `write_orders`, `write_merchant_managed_fulfillment_orders`,
  `write_inventory`, `read_locations`. A write scope includes its read scope.
- Merchants already installed are asked to approve the new version the next
  time they open the app in their Shopify admin; until they do, the suite's
  scopes don't change and the screens say so. "Check again" (or the next
  hourly read) picks the approval up.
- The suite's own switches still decide whether anything is written (order
  tags on/off, "mark sent", "add deliveries"), and watch-only connections
  never write.
- `SHOPIFY_EXTRA_SCOPES` and the `order_tags` connect field only affect the
  authorize link's `scope` parameter, which managed installation ignores.
  They matter only for an app on the legacy flow.

### Later, with optional scopes (not built)

Shopify supports `optional_scopes` under managed installation (changelog,
2024-12-04, API 2024-10):

> Apps on Admin API version 2024-10 can use the new optional_scopes app
> configuration to: Separate required scopes from optional; Request unique
> sets of access scopes on a store-by-store basis; Revoke optional scopes
> granted to the app from a store; Request and revoke scopes in-context, at
> app runtime. All while taking advantage of Shopify managed install.

The shape would be: required = the read scopes; optional = `write_orders`,
`write_merchant_managed_fulfillment_orders`, `write_inventory` (keep
`read_locations` required, or make it optional alongside `write_inventory`).
Note from "Manage access scopes": "A required scope can't implicitly grant an
optional one" — e.g. `read_orders` may not be optional while `write_orders`
is required; the reverse (read required, write optional) is what we'd use.
Moving a scope from required to optional keeps it on stores that already
granted it.

### Why requesting optional scopes isn't built

The docs describe three ways to request optional scopes:

> Requesting a scope asks the merchant to grant or decline it. What the
> merchant sees depends on the mechanism: the App Bridge method opens a
> permission grant modal on top of your running app, while the request URL
> and the React Router method redirect the browser to the Shopify admin.
>
> If you're not using one of Shopify's API libraries, request access scopes
> by directing the merchant to the request URL:
>
> Browser redirect URL — Query parameter / Description: `STORE_NAME` The name
> of the merchant's store. `CLIENT_ID` The app's client ID.
> `REQUESTED_SCOPES` A comma-separated list of access scopes to request. This
> must be a subset of the declared optional_scopes in your TOML file.

App Bridge is out (the suite is a standalone web app, not embedded). The
"request URL" is the only route for us, but the documentation search
returned the parameter table **without the URL template itself**, and nothing
about where the browser comes back to afterwards, whether a `state` or
`redirect_uri` can be carried, or whether the return is signed with an
`hmac`. Our callback checks state and HMAC on every return
(`api/connections/[provider]/callback`), and we won't build a flow whose
return we can't check, or guess a URL. So this part is deliberately not
built.

To build it later: read the "Request new access scopes dynamically" section
of shopify.dev's "Manage access scopes" page in a browser, confirm the URL
and what comes back, try it on a development store, then put it behind the
existing "allow" buttons, check the return like the OAuth callback, and
re-read the granted scopes as above. Shopify also offers an
`app/scopes_update` webhook ("fires when the merchant approves the changes");
subscribing to it would make the change show up at once instead of within
the hour. It isn't subscribed today.

## Not verified here

- Whether `accessScopes` lists a write scope's implied read scope separately.
  The docs' example answer lists both `write_products` and `read_products`;
  the gates only ever look for the scopes named in the table above.
- The exact place in the Shopify admin where a merchant approves an app
  update for a non-embedded app; the screens say "open our app under Apps".
