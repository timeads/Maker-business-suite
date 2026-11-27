# Finish setting up: the pattern

A tool that needs a few choices before its figures are true (Money, Stock
and Shipping so far) gets three things: a checklist worked out on read, a quiet card on its
main page, and a guided setup page. The generic part lives in `lib/setup/`
and `components/setup/`; the tool supplies its own items and steps.

## What is stored

Nothing about the setup itself. Progress is the facts the workspace already
has. The only row kept is a person's **Not now** on one item
(`setup_not_now`: workspace, tool, item id, and a short fingerprint of the
item's facts, through `say_setup_not_now` / `bring_back_setup_item`). When the
facts change (a new debt needs a rate), the fingerprint no longer matches and
the item is open again by itself. Only owners and admins say it. Money's rows
are theirs alone to read (an item can be about debts); Stock's and Shipping's
are read by everyone with that tool too (20270210000100), so the team isn't
nagged about something already decided. A new tool whose items are nothing
sensitive is added to that policy's list in a new migration.

## Adding a checklist to a tool

1. **Steps.** A list of `SetupStep` (`id`, `title`, `managersOnly`), in the
   order a person walks them; the last is a review.
2. **Facts.** A loader that reads what the items need, as the member, with
   anything sensitive read only for the people allowed to see it (row-level
   security still decides). Make the card's version cheap: no query on every
   workspace page, and the expensive facts only on the setup page (`deep`).
   A part that fails is left out, never an error.
3. **Items.** A pure function from facts to `SetupItem[]`: plain words, why
   in one line, an optional count and names, the exact place that fixes it
   (`to`, a path inside the workspace with its anchor or query), its step,
   and `facts` (ids and counts only, never figures or names) for the
   fingerprint. Raise an item only when it makes the figures truer; never nag
   about optional things. Test it.
4. **The card.** `<SetupCard>` at the top of the tool's page with
   `sortItems(items, await loadNotNow(...)).open`. It is folded and is gone
   when nothing is left.
5. **The setup page.** One `<SetupStepCard>` per step, each holding a small
   form that writes through the tool's EXISTING checked functions and
   settings (never a second way to write), and `<SetupList>` for that step's
   open items. Land on `firstOpenStep()`; every step can be skipped. Add the
   page as a row in the tool's menu (`lib/nav/model.ts`).
6. **Explanations.** Pure functions that return words built from the
   workspace's own settings, shown in `<HowWorkedOut>` beside the figure
   with the link that changes it. No model call.
7. **The assistant.** Every setting the steps touch has a registry entry
   whose description names the everyday phrasings. What isn't a setting is a
   kind in `action_proposals` (propose → preview → a person applies through
   the checked function), owners and admins only where the data is.
8. **Tests.** The items and explanations are pure and tested; a new table
   gets RLS and a cross-tenant test.

Money's own: `lib/dashboard/setup.ts` (steps, items, pass-through accounts,
line suggestions), `setup-data.ts` (facts), `explain.ts`, the page at
`dashboard/setup`, and `lib/assistant/money-tools.ts`.

Stock's: `lib/stock/setup.ts` (steps, items, `stockRowFacts`),
`setup-data.ts`, `explain.ts` (order-by date, amount, sales rate, cost,
planning; shown on the item page and the setup page), the page at
`stock/setup`. Shipping's: `lib/shipping/setup.ts` (steps, items,
`shippingOrderFacts`), `setup-data.ts`, `explain.ts` (box and weight in
`planFor`'s order, best price and margin, signature, hold; shown in "Why this
plan" on the order page, packing on the setup page), the page at
`shipping/setup`. Both tools' assistant tools are `lib/assistant/setup-tools.ts`.

## What the shared pieces do

- `SetupItem.optional`: nice to have, never needed for true figures. The card
  (`<SetupCard>`, through `requiredItems`) leaves it out; the guided page shows
  it with an "Optional" badge. Never nag about an optional thing.
- `SetupItem.managersOnly`: only owners and admins can do it. `<SetupList>` /
  `<SetupCard>` with `canAct` false show "Ask an owner or admin" instead of the
  link. Money's card is for owners and admins only; Stock's and Shipping's are
  for the whole team with the tool, so most of their items carry this.
- `lib/setup/connection.ts`: `connectionFact` and `shopItems`, the one "your
  shop" item (connect, connect again, a read that didn't finish, the first
  read, an old read) for tools that read everything from the shop.
- A loader takes `loaded`: what the tool's first page already read (rows,
  boxes, postage), so the card costs a few counts and no second read of the
  big tables; the setup page and the assistant read the rest themselves.
- Explanations are built from the same object the figure came from (a
  `StockRow`, an `OrderPlan`), never recomputed, so they can't drift.

## Adding a tool: a checklist

1. `lib/<tool>/setup.ts`: a `<TOOL>_TOOL` key, `<TOOL>_STEPS` (last is a
   review), a facts type and a pure `<tool>SetupItems(facts)`. Each item: why
   in one plain sentence, `to`, `step`, `facts` (ids or counts, never names or
   figures), `optional` / `managersOnly` where they apply. Costs only from
   facts read for people who see them (`seesCosts`).
2. `lib/<tool>/setup-data.ts`: the loader, as the member, with `loaded` for
   what the first page already has; a part that fails is left out.
3. Tests: every item on and off, every item in a step that exists, optional
   ones off the card.
4. `<SetupCard>` on the tool's first page (with `canAct`), and
   `<tool>/setup/page.tsx` with one `<SetupStepCard>` per step, using the
   tool's existing forms and actions only.
5. A "Set up" row in the tool's menu (`lib/nav/model.ts`, `SETUP_WORDS`), and
   a nav test.
6. `lib/<tool>/explain.ts` for the figures people question, in
   `<HowWorkedOut>` beside them, tested.
7. A `<tool>_setup_status` entry in `lib/assistant/setup-tools.ts`, offered
   only to people who can open the tool, with a test.
8. Decide whether its "Not now" rows may be read by the tool's team; if so,
   add the tool to the policy in a new migration and to
   `tests/db/setup-not-now.test.ts`.
9. Only add it to the workspace home if Money's setup is there (it isn't yet).
