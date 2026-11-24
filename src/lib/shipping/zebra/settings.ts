/**
 * How this computer prints. Kept in this browser only, so the packing bench
 * can print straight to its Zebra while the office desk goes on printing
 * through the browser. Nothing here is a workspace setting, and every page
 * must work when the browser won't keep it (a private window, say).
 */
export type PrintSettings = {
  /** "browser": open the label and print it. "zebra": send it straight to the printer. */
  labels: "browser" | "zebra";
  /** The printer picked on this computer, by the name Zebra Browser Print gives it. */
  zebraName: string;
  /** Dots per inch: 203 for most Zebras, 300 for the finer ones. */
  zebraDpi: 203 | 300;
  /** With a Zebra chosen: whether packing slips can go to it too. */
  slips: boolean;
};

export const PRINT_SETTINGS_KEY = "shipping.printing";

export const DEFAULT_PRINT_SETTINGS: PrintSettings = {
  labels: "browser",
  zebraName: "",
  zebraDpi: 203,
  slips: true,
};

type Store = Pick<Storage, "getItem" | "setItem">;

const browserStore = (): Store | null => {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
};

/** Whatever was saved, made safe: anything odd falls back to the default. */
export function readPrintSettings(raw: unknown): PrintSettings {
  const saved = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  return {
    labels: saved.labels === "zebra" ? "zebra" : "browser",
    zebraName: typeof saved.zebraName === "string" ? saved.zebraName.slice(0, 200) : "",
    zebraDpi: Number(saved.zebraDpi) === 300 ? 300 : 203,
    slips: saved.slips !== false,
  };
}

export function printSettings(store: Store | null = browserStore()): PrintSettings {
  try {
    return readPrintSettings(JSON.parse(store?.getItem(PRINT_SETTINGS_KEY) || "{}"));
  } catch {
    return { ...DEFAULT_PRINT_SETTINGS };
  }
}

/** Saves a change for this computer. Returns what is now in force, saved or not. */
export function savePrintSettings(
  next: Partial<PrintSettings>,
  store: Store | null = browserStore(),
): PrintSettings {
  const merged = readPrintSettings({ ...printSettings(store), ...next });
  try {
    store?.setItem(PRINT_SETTINGS_KEY, JSON.stringify(merged));
  } catch {
    // A private window: the choice lasts for this page only.
  }
  return merged;
}

/** The format labels are asked for on this computer. */
export const wantedLabelFormat = (settings: PrintSettings): "zpl" | undefined =>
  settings.labels === "zebra" ? "zpl" : undefined;

/**
 * Whether a slip button on this computer sends straight to the Zebra. On as
 * soon as a Zebra is chosen, unless someone unticked it on this computer.
 */
export const slipsGoToZebra = (settings: PrintSettings): boolean =>
  settings.labels === "zebra" && settings.slips;
