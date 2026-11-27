/**
 * The categorical chart palette: ONE deliberate exception to the house rule
 * of a single series colour (`--chart-1`) and small multiples. The owner
 * asked for the payoff projection as one line chart with a colour per debt,
 * so this palette exists for charts where identity is the point and lines
 * must share one axis. Everything else keeps `--chart-1`.
 *
 * Eight slots, in a fixed order that is never cycled, built from the Tuft
 * Life hues (teal, ochre, brick, khaki) with four companions in the same
 * register (plum, rust, slate, green), each stepped for the light and the
 * dark card. The values live in `globals.css` as `--chart-cat-1` …
 * `--chart-cat-8` (light and dark), and `palette.test.ts` holds them equal
 * and checks them: at least 3:1 against both cards' backgrounds, and
 * neighbours told apart under protanopia and deuteranopia (Machado,
 * Oliveira & Fernandes 2009, severity 1) and normal vision, in OKLab.
 * Colour is never the only cue: each slot also has its own dash pattern and
 * end marker, lines are named directly where the names fit, a legend always
 * names them, and the table view holds every figure.
 *
 * Past eight, a chart groups the rest as one line in the neutral ink
 * (`--chart-neutral`), dotted, and says so; it never makes a ninth colour.
 */

export const CATEGORICAL = {
  light: ["#14938d", "#a87520", "#a0340b", "#979031", "#945c9c", "#aa5d34", "#5a81bc", "#2c6e31"],
  dark: ["#00a291", "#ce8f49", "#bc4a3c", "#a38b09", "#aa4c93", "#bd7b3a", "#549de5", "#4ea06a"],
} as const;

/** "Other …" and lines that aren't one entity (a fund): the text ink, never a slot. */
export const NEUTRAL = { light: "#6c655d", dark: "#978f84" } as const;

/** The card surfaces the palette is checked against (`--tuft-surface`, `--tuft-panel`). */
export const SURFACES = {
  light: ["#ffffff", "#f8f6f3"],
  dark: ["#211f1d", "#161514"],
} as const;

export const SLOTS = CATEGORICAL.light.length;

/** Each slot's dash pattern (SVG `stroke-dasharray`), so colour is never the only cue. */
export const DASHES = [
  "",
  "7 3",
  "2 3",
  "10 3 2 3",
  "1.5 4",
  "5 5",
  "4 2 1 2",
  "12 3 4 3",
] as const;
/** Each slot's end marker. */
export const MARKERS = [
  "circle",
  "square",
  "triangle",
  "diamond",
  "circle",
  "square",
  "triangle",
  "diamond",
] as const;
export type Marker = (typeof MARKERS)[number];

/** The CSS colour of a slot (1-based), or the neutral ink for null. */
export const slotColour = (slot: number | null) =>
  slot === null ? "var(--chart-neutral)" : `var(--chart-cat-${slot})`;

// ---------------------------------------------------------------------------
// Colour arithmetic for the checks (WCAG contrast; OKLab distance, ×100)
// ---------------------------------------------------------------------------

const channel = (hex: string, at: number) => parseInt(hex.slice(1 + at * 2, 3 + at * 2), 16) / 255;
const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const linear = (hex: string): [number, number, number] => [
  toLinear(channel(hex, 0)),
  toLinear(channel(hex, 1)),
  toLinear(channel(hex, 2)),
];

const luminance = (hex: string) => {
  const [r, g, b] = linear(hex);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

/** WCAG 2 contrast ratio. */
export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const MACHADO = {
  protan: [
    [0.152286, 1.052583, -0.204868],
    [0.114503, 0.786281, 0.099216],
    [-0.003882, -0.048116, 1.051998],
  ],
  deutan: [
    [0.367322, 0.860646, -0.227968],
    [0.280085, 0.672501, 0.047413],
    [-0.01182, 0.04294, 0.968881],
  ],
} as const;
export type Vision = "normal" | keyof typeof MACHADO;

function seen(hex: string, vision: Vision): [number, number, number] {
  const rgb = linear(hex);
  if (vision === "normal") return rgb;
  const m = MACHADO[vision];
  const clamp = (v: number) => Math.min(1, Math.max(0, v));
  return [0, 1, 2].map((row) =>
    clamp(m[row][0] * rgb[0] + m[row][1] * rgb[1] + m[row][2] * rgb[2]),
  ) as [number, number, number];
}

function oklab([r, g, b]: [number, number, number]): [number, number, number] {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

/** How far apart two colours look, as OKLab distance ×100, under a kind of vision. */
export function difference(a: string, b: string, vision: Vision = "normal"): number {
  const [x, y] = [oklab(seen(a, vision)), oklab(seen(b, vision))];
  return 100 * Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]);
}

/** OKLCH lightness and chroma. */
export function lightnessChroma(hex: string): { l: number; c: number } {
  const [l, a, b] = oklab(linear(hex));
  return { l, c: Math.hypot(a, b) };
}
