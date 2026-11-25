import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * What a date's places come to, as the database works them out
 * (`session_seat_figures`): what is taken, the date's own limit, the shared
 * limit when the date shares a room with a class at the same time, and what
 * is left under both. Nothing here is stored; it is read fresh each time.
 */
export type SeatFigures = {
  session_id: string;
  taken: number;
  capacity: number;
  seat_group_id: string | null;
  shared_capacity: number | null;
  shared_taken: number | null;
  seats_left: number;
};

/** The figures for a set of dates, read as the signed-in member. Empty if they can't be read. */
export async function loadSeatFigures(
  supabase: SupabaseClient,
  sessionIds: string[],
): Promise<Map<string, SeatFigures>> {
  const ids = [...new Set(sessionIds)].slice(0, 1000);
  if (ids.length === 0) return new Map();
  const { data, error } = await supabase.rpc("session_seat_figures", { p_session_ids: ids });
  if (error) return new Map();
  return new Map(((data ?? []) as SeatFigures[]).map((row) => [row.session_id, row]));
}

const isShared = (
  f: SeatFigures | undefined,
): f is SeatFigures & {
  seat_group_id: string;
  shared_capacity: number;
  shared_taken: number;
} => Boolean(f?.seat_group_id && f.shared_capacity !== null && f.shared_taken !== null);

/** No places left under either limit. Falls back to the date's own count when there are no figures. */
export function isFull(f: SeatFigures | undefined, taken: number, capacity: number): boolean {
  return f ? f.seats_left <= 0 : taken >= capacity;
}

/** More booked across the shared room than it holds. */
export function overShared(f: SeatFigures | undefined): boolean {
  return isShared(f) && f.shared_taken > f.shared_capacity;
}

/** "Shared room: 11 of 12 taken", or null for a date that doesn't share. */
export function sharedWords(f: SeatFigures | undefined): string | null {
  if (!isShared(f)) return null;
  return `Shared room: ${f.shared_taken} of ${f.shared_capacity} taken`;
}

/**
 * What a manager may raise a date's own limit to so that everyone booked
 * fits, and the shared limit too when the room is over. Null when it all fits.
 */
export function limitsToFit(
  f: SeatFigures | undefined,
): { capacity: number | null; shared: number | null } | null {
  if (!f) return null;
  const capacity = f.taken > f.capacity ? f.taken : null;
  const shared = isShared(f) && f.shared_taken > f.shared_capacity ? f.shared_taken : null;
  return capacity === null && shared === null ? null : { capacity, shared };
}
