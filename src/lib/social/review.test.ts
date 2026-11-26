import { describe, expect, it } from "vitest";
import {
  DEFAULT_REVIEW,
  approverWords,
  canApprove,
  canSchedule,
  parseReview,
  reviewError,
} from "./review";

describe("post review settings", () => {
  it("changes nothing out of the box", () => {
    expect(DEFAULT_REVIEW.require_approval).toBe(false);
    expect(canSchedule("member", DEFAULT_REVIEW)).toBe(true);
    expect(canApprove("admin", DEFAULT_REVIEW)).toBe(true);
    expect(canApprove("member", DEFAULT_REVIEW)).toBe(false);
  });

  it("always counts owners as approvers", () => {
    const settings = parseReview({ version: 1, require_approval: true, approvers: ["member"] });
    expect(canApprove("owner", settings)).toBe(true);
    expect(canApprove("member", settings)).toBe(true);
    expect(canApprove("admin", settings)).toBe(false);
    expect(canSchedule("admin", settings)).toBe(false);
    expect(approverWords(settings)).toBe("Owners and members");
  });

  it("falls back to the default for anything it can't read", () => {
    expect(parseReview({ version: 1, approvers: ["boss"] })).toEqual(DEFAULT_REVIEW);
    expect(parseReview(null)).toEqual(DEFAULT_REVIEW);
  });

  it("puts the database's refusals in plain words", () => {
    expect(reviewError("error: needs_approval")).toMatch(/Send it for review/);
    expect(reviewError("something else")).toBeNull();
  });
});
