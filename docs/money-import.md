# Money: bringing debt details across

Settings → Money → Debt payoff → **Bring your debt details across**. For the
move from an earlier app: the debts themselves come from the books' balance
sheet on every QuickBooks sync, but the books can't say a debt's rate,
minimum or how it's paid. This fills those in from a spreadsheet, once.

Owners and admins only, like everything about debts.

## How it works

1. Save the earlier app's list of debts as CSV and pick the file. It is read
   in the browser and never kept.
2. Each row is matched to one of the workspace's debts by its **account
   name**: exactly first (the books' account name, then the debt's own
   name), then ignoring capitals and spaces. Two debts that could both be
   meant are never guessed between: that row is left for a person.
3. The preview lists, per debt, what would be filled and what is kept as a
   person set it, and the rows left out with the reason.
4. "Bring these across" writes it through one checked function
   (`import_money_debt_details`) with a request key: pressing again changes
   nothing, and the same file again fills nothing, as it's all set by then.

**Only what a person hasn't set is filled**: a rate not given yet, a
minimum of 0, no usual payment, no place, no due day, no note. How a debt is
paid is filled only on a debt nobody has saved by hand. A name, an account
or a balance is never written: those are the books'.

## Columns

The first line names the columns. Capitals and spaces in the names don't
matter, the order doesn't matter, and other columns are ignored. Commas,
semicolons or tabs between cells all work. Only the name column is needed;
an empty cell leaves that detail alone.

| Column (also read as)                          | What goes in it                                                               | Example     |
| ---------------------------------------------- | ----------------------------------------------------------------------------- | ----------- |
| `name` (`account`, `account name`, `debt`)     | The debt's account name, as the books have it                                 | Studio Card |
| `rate %` (`rate`, `apr`, `interest rate`)      | The yearly rate, up to two decimals, with or without `%`                      | 22.99%      |
| `minimum` (`minimum payment`, `min payment`)   | The least payment a month                                                     | $50.00      |
| `usual payment` (`payment`, `monthly payment`) | What's usually paid a month, if more than the minimum                         | 300         |
| `plan` (`plan kind`, `paid by`)                | `pool` (paid down by the plan), `fixed` (a fixed payment) or `share of sales` | fixed       |
| `priority` (`place`, `order`)                  | Its place in your own order, 1 to 999, lower first                            | 2           |
| `due day` (`due`)                              | The day of the month it's due, 1 to 31 (`15th` reads as 15)                   | 15          |
| `note` (`notes`)                               | Anything to remember, up to 500 characters                                    | Pay early   |

Money takes `1200.50` or `$1,200.50`. The example values are made up.

## Debts paid through a plan

If the business pays one amount a month to a company that pays several of
its debts (a debt-management or consolidation plan), the earlier app may
have kept that as one "consolidated" debt. Two more optional columns bring
it across:

| Column (also read as)                                              | What goes in it                                                                        | Example   |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------------- | --------- |
| `consolidated` (`is plan`, `pays other debts`, `debt plan`)        | `yes` on the plan's own row (`y`, `true`, `1` or `x` too); blank or `no` on the others | yes       |
| `paid through` (`covered by`, `consolidated into`, `paid by plan`) | On a debt's row, the name of the plan that pays it                                     | Card Plan |

- A plan's row is made into a plan (one fixed payment: its usual payment,
  else its minimum; its rate and due day; its balance the debts it pays,
  added up from the books) **only if no plan of that name is here yet**. If
  one is, its details are filled like any debt's, never how it's paid or a
  minimum. If its name is one of the books' accounts (exactly, then
  ignoring capitals and spaces, never a guess), that becomes the plan's own
  account: its payments are the money moved into it.
- A plan's name that is already a debt counted by itself here is left for a
  person: make the plan on Money → Debts and tick what it pays.
- A debt is put under a plan **only if no plan pays it yet**; one already
  under a plan stays where it is. Its own details still fill as usual.
- It's written by its own checked function (`import_money_debt_plans`), with
  its own request key, before the details: pressing again changes nothing,
  and the same file again makes and covers nothing.

For example (made-up names):

```csv
name,consolidated,paid through,rate %,usual payment,due day
Card Plan,yes,,0,400,3
Studio Card,,Card Plan,22.99,,
Supply Card,,Card Plan,19.99,,
Van Loan,,,6.5,310,15
```
