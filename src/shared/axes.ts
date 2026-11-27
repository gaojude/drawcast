import { widthEm } from "./text.ts";
import type { ElementSpec } from "./types.ts";

// Real image filenames cannot contain NUL. Chart ids and filenames can otherwise coincide.
export const axesImageKey = (id: string) => `\0axes/${id}`;

interface Label { x: number; y: number; w: number; h: number; text: string }

/** Coordinates are relative to the top left of the plot area. Labels extend beyond that area. */
export function axesLayout(spec: ElementSpec) {
  const w = spec.width!, h = spec.height!, size = spec.fontSize ?? 18;
  const lineHeight = size * 1.25, tick = 5, gap = 5;
  const [xmin, xmax] = spec.domain!, [ymin, ymax] = spec.range!;
  const paths = [`M0 0V${h}H${w}`];
  const labels: Label[] = [];
  const xTickTop = h + gap + Math.max(tick, spec.yTicks?.includes(ymin) ? lineHeight / 2 : 0);
  function label(text: string, anchorX: number, top: number, align: number) {
    const width = widthEm(text) * size;
    const box = { x: anchorX - align * width, y: top, w: width, h: lineHeight, text };
    labels.push(box);
  }
  for (const value of spec.xTicks ?? []) {
    const x = (value - xmin) / (xmax - xmin) * w;
    paths.push(`M${x} ${h}v${tick}`);
    label(String(value), x, xTickTop, 0.5);
  }
  for (const value of spec.yTicks ?? []) {
    const y = h - (value - ymin) / (ymax - ymin) * h;
    paths.push(`M0 ${y}h${-tick}`);
    label(String(value), -tick - gap, y - lineHeight / 2, 1);
  }
  if (spec.xLabel) label(spec.xLabel, w / 2, (spec.xTicks?.length ? xTickTop + lineHeight : h) + gap, 0.5);
  if (spec.yLabel) label(spec.yLabel, 0, -gap - 1.5 * lineHeight, 0);

  const pad = (spec.strokeWidth ?? 2) / 2 + 1;
  let left = -pad, right = w + pad, top = -pad, bottom = h + pad;
  for (const box of labels) {
    left = Math.min(left, box.x - pad);
    right = Math.max(right, box.x + box.w + pad);
    top = Math.min(top, box.y - pad);
    bottom = Math.max(bottom, box.y + box.h + pad);
  }
  return { left, top, width: right - left, height: bottom - top, size, labels, paths };
}

const escapeText = (s: string) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

export function axesSvg(spec: ElementSpec): string {
  const { left, top, width, height, size, labels, paths } = axesLayout(spec);
  const color = spec.strokeColor ?? "#495057";
  const text = labels.map((l) => `<text x="${l.x}" y="${l.y + size}" textLength="${l.w}" lengthAdjust="spacingAndGlyphs">${escapeText(l.text)}</text>`).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width * 2}" height="${height * 2}" viewBox="${left} ${top} ${width} ${height}"><path d="${paths.join("")}" stroke="${color}" stroke-width="${spec.strokeWidth ?? 2}" fill="none"/><g font-family="sans-serif" font-size="${size}" fill="${color}">${text}</g></svg>`;
}
