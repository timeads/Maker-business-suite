# Finish setting up: the pattern

A tool that needs a few choices before its figures are true (Money is the
first) gets three things: a checklist worked out on read, a quiet card on its
main page, and a guided setup page. The generic part lives in `lib/setup/`
and `components/setup/`; the tool supplies its own items and steps.

## What is stored

Nothing about the setup itself. Progress is the facts the workspace already
has. The only row kept is a person's **Not now** on one item
(`setup_not_now`: workspace, tool, item id, and a short fingerprint of the
item's facts, through `say_setup_not_now` / `bring_back_setup_item`). When the
facts change (a new debt needs a rate), the fingerprint no longer matches and
the item is open again by itself. The table is owners' and admins' only, so an
item about something sensitive never leaks through it.

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
