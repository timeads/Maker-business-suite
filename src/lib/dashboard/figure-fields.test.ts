import { describe, expect, it } from "vitest";
import { DEFAULT_BUDGET_SETTINGS } from "./budget";
import { DEFAULT_DEBT_SETTINGS } from "./debt/settings";
import {
  BUDGET_FIELDS,
  CUTTER_FIELDS,
  DEBT_FIELDS,
  HEALTH_FIELDS,
  type FigureGroup,
} from "./figure-fields";
import { DEFAULT_HEALTH_SETTINGS } from "./health";
import { DEFAULT_CUTTER_SETTINGS } from "./recurring";

const keys = (groups: FigureGroup[]) => groups.flatMap((g) => g.fields.map((f) => f.key)).sort();
const settable = (body: object) =>
  Object.keys(body)
    .filter((key) => key !== "version")
    .sort();

describe("the settings screens' boxes", () => {
  it("edit every figure of each setting, and nothing else", () => {
    expect(keys(HEALTH_FIELDS)).toEqual(settable(DEFAULT_HEALTH_SETTINGS));
    expect(keys(BUDGET_FIELDS)).toEqual(settable(DEFAULT_BUDGET_SETTINGS));
    expect(keys(CUTTER_FIELDS)).toEqual(settable(DEFAULT_CUTTER_SETTINGS));
    // The emergency fund's accounts are ticked in a picker of their own
    // (the earlier typed names are only read now).
    // One "Order" box stands for strategy_from and strategy together.
    expect(keys(DEBT_FIELDS)).toEqual(
      [
        ...settable(DEFAULT_DEBT_SETTINGS).filter(
          (key) =>
            !["emergency_picks", "emergency_accounts", "strategy", "strategy_from"].includes(key),
        ),
        "order",
      ].sort(),
    );
  });
});
