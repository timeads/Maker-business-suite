import { describe, expect, it } from "vitest";
import { DEFAULT_BUDGET_SETTINGS } from "./budget";
import { BUDGET_FIELDS, CUTTER_FIELDS, HEALTH_FIELDS, type FigureGroup } from "./figure-fields";
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
  });
});
