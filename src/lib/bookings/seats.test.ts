import { describe, expect, it } from "vitest";
import { isFull, limitsToFit, overShared, sharedWords, type SeatFigures } from "./seats";

const alone: SeatFigures = {
  session_id: "a",
  taken: 3,
  capacity: 8,
  seat_group_id: null,
  shared_capacity: null,
  shared_taken: null,
  seats_left: 5,
};
const shared: SeatFigures = {
  ...alone,
  seat_group_id: "g",
  shared_capacity: 12,
  shared_taken: 12,
  seats_left: 0,
};

describe("seat figures", () => {
  it("a date in a full shared room is full though its own limit has room", () => {
    expect(isFull(shared, shared.taken, shared.capacity)).toBe(true);
    expect(isFull(alone, alone.taken, alone.capacity)).toBe(false);
    // Without figures, the date's own count decides.
    expect(isFull(undefined, 8, 8)).toBe(true);
  });

  it("says when a date shares a room, and only then", () => {
    expect(sharedWords(shared)).toBe("Shared room: 12 of 12 taken");
    expect(sharedWords(alone)).toBeNull();
    expect(sharedWords(undefined)).toBeNull();
  });

  it("over the shared limit is told apart from full", () => {
    expect(overShared(shared)).toBe(false);
    expect(overShared({ ...shared, shared_taken: 13 })).toBe(true);
  });

  it("works out the limits that would fit everyone", () => {
    expect(limitsToFit(alone)).toBeNull();
    expect(limitsToFit({ ...alone, taken: 10 })).toEqual({ capacity: 10, shared: null });
    expect(limitsToFit({ ...shared, shared_taken: 14 })).toEqual({ capacity: null, shared: 14 });
    expect(limitsToFit({ ...shared, taken: 9, shared_taken: 14 })).toEqual({
      capacity: 9,
      shared: 14,
    });
  });
});
