import { describe, expect, it } from "vitest";
import {
  DEFAULT_PRINT_SETTINGS,
  PRINT_SETTINGS_KEY,
  printSettings,
  readPrintSettings,
  savePrintSettings,
  slipsGoToZebra,
  wantedLabelFormat,
} from "./settings";

const memory = () => {
  const kept = new Map<string, string>();
  return {
    kept,
    getItem: (key: string) => kept.get(key) ?? null,
    setItem: (key: string, value: string) => void kept.set(key, value),
  };
};

describe("printing on this computer", () => {
  it("is ordinary browser printing until someone chooses otherwise", () => {
    expect(printSettings(memory())).toEqual(DEFAULT_PRINT_SETTINGS);
    expect(printSettings(null)).toEqual(DEFAULT_PRINT_SETTINGS);
    expect(wantedLabelFormat(DEFAULT_PRINT_SETTINGS)).toBeUndefined();
  });

  it("remembers the choice in this browser, and asks for ZPL once a Zebra is chosen", () => {
    const store = memory();
    savePrintSettings({ labels: "zebra", zebraName: "ZT220" }, store);
    savePrintSettings({ zebraDpi: 300 }, store);
    expect(printSettings(store)).toEqual({
      labels: "zebra",
      zebraName: "ZT220",
      zebraDpi: 300,
      slips: true,
      slipPaper: "4x6",
      autoPrint: false,
    });
    expect(wantedLabelFormat(printSettings(store))).toBe("zpl");
    expect([...store.kept.keys()]).toEqual([PRINT_SETTINGS_KEY]);
  });

  it("falls back to the defaults when what was saved makes no sense", () => {
    const store = memory();
    store.kept.set(PRINT_SETTINGS_KEY, "{not json");
    expect(printSettings(store)).toEqual(DEFAULT_PRINT_SETTINGS);
    expect(readPrintSettings({ labels: "fax", zebraDpi: 9000, zebraName: 7, slips: "no" })).toEqual(
      DEFAULT_PRINT_SETTINGS,
    );
    expect(readPrintSettings(null)).toEqual(DEFAULT_PRINT_SETTINGS);
  });

  it("works for the page even when the browser won't keep anything", () => {
    const locked = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    expect(printSettings(locked)).toEqual(DEFAULT_PRINT_SETTINGS);
    expect(savePrintSettings({ labels: "zebra" }, locked).labels).toBe("zebra");
  });

  it("sends slips to the Zebra as soon as one is chosen, until someone unticks it", () => {
    const store = memory();
    expect(slipsGoToZebra(printSettings(store))).toBe(false);
    // Choosing a Zebra is all it takes: nothing else was ever saved on this computer.
    expect(slipsGoToZebra(savePrintSettings({ labels: "zebra" }, store))).toBe(true);
    expect(slipsGoToZebra(savePrintSettings({ slips: false }, store))).toBe(false);
    // Back to the browser and then to the Zebra again: the untick is remembered.
    savePrintSettings({ labels: "browser" }, store);
    expect(slipsGoToZebra(printSettings(store))).toBe(false);
    expect(slipsGoToZebra(savePrintSettings({ labels: "zebra", slips: true }, store))).toBe(true);
  });

  it("remembers the bench's auto-print tick and the paper slips are drawn for, per computer", () => {
    const kept = new Map<string, string>();
    const store = {
      getItem: (key: string) => kept.get(key) ?? null,
      setItem: (key: string, value: string) => void kept.set(key, value),
    };
    expect(printSettings(store)).toMatchObject({ autoPrint: false, slipPaper: "4x6" });
    savePrintSettings({ autoPrint: true, slipPaper: "letter" }, store);
    expect(printSettings(store)).toMatchObject({ autoPrint: true, slipPaper: "letter" });
    // Anything odd falls back to the safe choice: nothing buys by itself.
    expect(readPrintSettings({ autoPrint: "yes", slipPaper: "a4" })).toMatchObject({
      autoPrint: false,
      slipPaper: "4x6",
    });
  });
});
