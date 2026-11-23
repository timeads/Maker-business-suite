/**
 * Which items go in which box, when an order is packed in several. Pure:
 * no network, no database. The rules follow the bench: every unit is in
 * exactly one box unless a person deliberately leaves it out.
 */

export type PackLine = {
  id: string;
  /** How many are going in this purchase. */
  qty: number;
  /** One unit's weight in tenths of an ounce, when the shop knows it. */
  tenthOz: number | null;
};

/** Units of each line in one box, by line id. */
export type Alloc = Record<string, number>;

export const emptyAlloc = (lines: PackLine[]): Alloc =>
  Object.fromEntries(lines.map((line) => [line.id, 0]));

export const fullAlloc = (lines: PackLine[]): Alloc =>
  Object.fromEntries(lines.map((line) => [line.id, line.qty]));

const held = (alloc: Alloc, id: string) => alloc[id] ?? 0;

/**
 * Puts `count` of a line in one box. Extra units come out of whichever other
 * boxes hold the most; units taken out go to the next box, so nothing is left
 * unpacked by accident.
 */
export function setQty(allocs: Alloc[], line: PackLine, box: number, count: number): Alloc[] {
  if (box < 0 || box >= allocs.length) return allocs;
  const wanted = Math.max(0, Math.min(line.qty, Math.round(Number(count) || 0)));
  const next = allocs.map((alloc) => ({ ...alloc }));
  let diff = wanted - held(next[box], line.id);
  next[box][line.id] = wanted;
  if (diff > 0) {
    const others = next
      .map((alloc, index) => ({ alloc, index }))
      .filter((entry) => entry.index !== box)
      .sort((a, b) => held(b.alloc, line.id) - held(a.alloc, line.id));
    for (const { alloc } of others) {
      const take = Math.min(diff, held(alloc, line.id));
      alloc[line.id] = held(alloc, line.id) - take;
      diff -= take;
      if (diff === 0) break;
    }
  } else if (diff < 0 && next.length > 1) {
    const to = next[(box + 1) % next.length];
    to[line.id] = held(to, line.id) - diff;
  }
  return next;
}

/** A box is taken away: what was in it goes to the box before it. */
export function withoutBox(allocs: Alloc[], index: number): Alloc[] {
  if (allocs.length <= 1 || index < 0 || index >= allocs.length) return allocs;
  const next = allocs.map((alloc) => ({ ...alloc }));
  const [gone] = next.splice(index, 1);
  const to = next[Math.max(0, index - 1)];
  for (const [id, count] of Object.entries(gone)) to[id] = held(to, id) + count;
  return next;
}

/** Deals the units out so each box weighs about the same, heaviest units first. */
export function splitEvenly(lines: PackLine[], boxes: number): Alloc[] {
  const allocs = Array.from({ length: Math.max(1, boxes) }, () => emptyAlloc(lines));
  const load = allocs.map(() => 0);
  const units = lines
    .flatMap((line) => Array.from({ length: line.qty }, () => line))
    .sort((a, b) => (b.tenthOz ?? 1) - (a.tenthOz ?? 1));
  for (const unit of units) {
    const lightest = load.indexOf(Math.min(...load));
    allocs[lightest][unit.id] += 1;
    load[lightest] += unit.tenthOz ?? 1;
  }
  return allocs;
}

/** How many of a line are in no box at all. */
export const notInBox = (allocs: Alloc[], line: PackLine) =>
  line.qty - allocs.reduce((sum, alloc) => sum + held(alloc, line.id), 0);

export const unitsIn = (alloc: Alloc, lines: PackLine[]) =>
  lines.reduce((sum, line) => sum + held(alloc, line.id), 0);

/** Box weights can follow their contents only when every item has a weight. */
export const weightsKnown = (lines: PackLine[]) =>
  lines.length > 0 && lines.every((line) => line.tenthOz !== null && line.tenthOz > 0);

/** What a box's contents weigh, in tenths of an ounce. Call only when `weightsKnown`. */
export const contentsTenthOz = (alloc: Alloc, lines: PackLine[]) =>
  lines.reduce((sum, line) => sum + held(alloc, line.id) * (line.tenthOz ?? 0), 0);
