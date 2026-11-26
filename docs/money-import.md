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
