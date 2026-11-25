import { closedOn, planBuildAhead, type Closure } from "@/lib/stock/engine/closures";

const day = (value: string, today: string) =>
  new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    month: "short",
    day: "numeric",
    ...(value.slice(0, 4) === today.slice(0, 4) ? {} : { year: "numeric" }),
  }).format(new Date(`${value}T12:00:00Z`));

/** A calendar day in words, with the year only when it isn't this one. */
export const closureDay = day;

/** What a supplier's closures mean for ordering, using their own days to arrive. */
export function closureWords(shut: Closure[], leadDays: number, today: string) {
  const now = closedOn(today, shut);
  const ahead = planBuildAhead({ today, leadDays, closures: shut });
  return {
    now: now ? `Shut for ${now.name} until ${day(now.endsOn, today)}` : null,
    ahead: ahead
      ? ahead.missed
        ? `Shut for ${ahead.closure.name} from ${day(ahead.closure.startsOn, today)}. The last day to order and have it before then was ${day(ahead.orderBefore, today)}.`
        : `Shut for ${ahead.closure.name} from ${day(ahead.closure.startsOn, today)}. Order by ${day(ahead.orderBefore, today)} to have it before then.`
      : null,
    aheadShort: ahead
      ? ahead.missed
        ? `Shuts ${day(ahead.closure.startsOn, today)}`
        : `Order by ${day(ahead.orderBefore, today)}, before ${ahead.closure.name}`
      : null,
    missed: ahead?.missed ?? false,
  };
}
