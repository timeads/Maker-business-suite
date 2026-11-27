# Switching Money over

Read [the shared list](README.md) first: what has to be true of the live site before any tool moves.

Money only reads: your shop's orders and your QuickBooks books. It sends nothing to anyone and changes nothing in either. So there is no moment when both apps could do something twice; this switch is about getting the figures right and then trusting them.

## Before the day

**Connections**

- **Your shop** (Connections → Shopify). Watch only is enough for Money.
- **QuickBooks** (Connections → QuickBooks). It reads the profit and loss, cash flow, balance sheet, aged receivables, invoices and expenses. Read only.

**Bring across** (Settings → Money → …). There is one import; everything else is typed in once.

| From your earlier dashboard                          | Where it goes here                                                                                                                                                                     |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Debt rates, minimums, payments, due days, priorities | Settings → Money → Debt payoff and emergency fund → **Bring your debt details across** ([money-import.md](../money-import.md)). The debts themselves come from your books.             |
| Which accounts the emergency fund is kept in         | The same screen, ticked from the latest balance sheet                                                                                                                                  |
| Business lines and how sales are sorted into them    | Settings → Money → Revenue and business lines (order tag, product tag, product type; and whether the figure is net sales or order totals)                                              |
| Vendor defaults and text rules for expenses          | Settings → Money → Sorting expenses (the shapes are the same as your earlier app's)                                                                                                    |
| Labour, salary, how shared costs split               | Settings → Money → Profit by line                                                                                                                                                      |
| Health thresholds                                    | Settings → Money → Cash health (starts at your earlier dashboard's)                                                                                                                    |
| Budget amounts; hidden accounts; cost of goods share | Money → Budget for the amounts; Settings → Money → Budget and break-even for the rest                                                                                                  |
| Projection growth rates                              | Settings → Money → Projection                                                                                                                                                          |
| Keep / cancel decisions on regular charges           | Money → Cost cutter, decided again; what to leave out is Settings → Money → Cost cutter                                                                                                |
| How you sorted each expense                          | Not brought across. Here you sort **by account**: one choice per books account sorts every expense in it (Money → Expenses to sort). It is usually a handful of choices, not hundreds. |

Then finish **Money → Set up** until it has nothing left but "Not now" items.

## What will be different

- **No AI summary of the month, no "things to review" scan, no "where to cut" list, no overhead review.** Ask the assistant about the month's figures instead.
- **No industry benchmark bands.** They were fixed figures in the earlier app, not your own data.
- **No "financial outlook" PDF.** Each part of it is a page here (Statements, the projection, the payoff plan); use the spreadsheet download on each.
- **No time tracker.** Keep using the earlier app for it, or a spreadsheet, until there's a decision on where it belongs.
- **No Redo shipping history.** Shipping margin counts only labels bought in the suite, so it starts on the day Shipping moves.
- **Sales won't match the earlier app to the cent.** Refunds always come out here; choose net sales or order totals in Settings → Money → Revenue and business lines.
- **The month still open never swaps in shop sales for the books.** What the books hold is added beside the shop, the same way every month.
- **History is shorter.** Reports go back three Januaries, balance sheets only from the day the books were first read here, and no single "all time" range.
- **Cost cutter decides per payee**, not per single charge, and doesn't read the real merchant out of bank memos.
- **Words, not bars** on the home card's debt line; **bars, not a donut** for revenue by line.
- **Debts and the emergency fund are for owners and admins only.** Anyone else sees no debt anywhere.
- **Your team hub page's money cards** stop updating once the earlier dashboard is off.

## On the day, in order

1. Check both connections show a finished read (Money → Set up says so if one hasn't been read, or not lately).
2. Open Money → Dashboard and your earlier dashboard side by side for the same month. Write down any figure that differs by more than you'd expect from the points above.
3. Sort the accounts still waiting (Money → Set up says how many), and check Money → Expenses to sort is empty or nearly.
4. From now on, look at the suite. Leave the earlier dashboard readable for a month or two, for comparing; it does no harm left on.

There is nothing to switch off to avoid doubling, and nothing that can be missed: both apps only read.

## Check it worked

**First hour**

- Money → Dashboard: this month's sales are within a few dollars of what your shop's own reports say for the same days.
- Money → Statements: last month's profit and loss matches QuickBooks' own report for that month.
- Money → Payoff plan (owners and admins): each debt has a rate; none says "Needs a rate" unless it really has none.

**First day**

- Money → Expenses to sort: new expenses arrive already sorted by their account.
- Money → Set up: nothing left but what you chose to leave.

## If something goes wrong

Go back to your earlier dashboard; it was never switched off. Nothing here changed your books or your shop, so there is nothing to undo out there. Under Connections, disconnecting QuickBooks stops the reads; what was read stays here until the workspace is closed. A setting saved here keeps its history, so a wrong change can be put back.

## Still needs a decision or isn't ready

- **The live site update** and **`QUICKBOOKS_ENVIRONMENT=production`** ([the shared list](README.md), items 1 and 5). Both need your go-ahead.
- **Order history beyond 60 days** needs the shop app to have `read_all_orders`. **To confirm** on the live app.
- **How each expense was sorted** in the earlier app has no import. The account-by-account sorting usually makes it unnecessary; if you want the old choices kept exactly, that import would have to be built.
- **Where the time tracker belongs**, if anywhere.
