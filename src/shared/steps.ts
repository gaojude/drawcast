/** Steps on one contact sheet: three across and four down still reads at the size an agent is shown a picture. */
export const SHEET_COLUMNS = 3;
export const SHEET_STEPS = 12;
export const SHEET_TILE = 512;
export const sheetPage = (output: string, i: number) => output.replace(/(\.png)?$/i, `-${i + 1}.png`);

/** Parses `--step`: a number, a list such as `2,5,9`, a range such as `3-6`, or `all`. */
export function parseSteps(value: string, count: number): number[] {
  if (value.trim() === "all") return Array.from({ length: count }, (_, i) => i + 1);
  // PowerShell hands `--step 4,7` over as "4 7", so spaces separate as well as commas
  const parts = value.trim().split(/\s*,\s*|\s+/);
  const steps = new Set<number>();
  for (const part of parts) {
    const match = /^(\d+)(?:-(\d+))?$/.exec(part);
    const first = Number(match?.[1]);
    const last = Number(match?.[2] ?? first);
    if (!match || first < 1 || last < first || last > count) throw new Error(`--step must select steps 1 to ${count}, for example 2,5 or 3-6, or "all" (got "${value}").`);
    for (let s = first; s <= last; s++) steps.add(s);
  }
  return [...steps];
}
