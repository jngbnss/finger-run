import { distanceToEdge } from "./inflate";
import type { Mask } from "./segment";

/**
 * Paints a plausible back view from the front drawing, in the browser (no AI):
 *  - the outline (pixels near the silhouette edge) is kept
 *  - inside the head, small features enclosed by the face colour (eyes, nose, mouth) are
 *    painted over with the head's main colour; things bordering the outline or the
 *    background (ears, bows, hair) stay
 *  - elsewhere, dark interior ink lines are filled from the neighbouring colours
 * Pixels are aligned with the front image, so seen from behind it is correctly mirrored.
 */

const OUTLINE_PX = 2;
const INK_LUMINANCE = 80;

const luminance = (r: number, g: number, b: number) => 0.299 * r + 0.587 * g + 0.114 * b;
const bucket = (r: number, g: number, b: number) => ((r >> 5) << 6) | ((g >> 5) << 3) | (b >> 5);

/** Most common (quantised) light colour in a set of pixels, as its average RGB. */
function dominantColor(rgba: Uint8ClampedArray, pixels: number[]): [number, number, number] | null {
  const counts = new Map<number, { n: number; r: number; g: number; b: number }>();
  for (const p of pixels) {
    const r = rgba[p * 4];
    const g = rgba[p * 4 + 1];
    const b = rgba[p * 4 + 2];
    if (luminance(r, g, b) < INK_LUMINANCE) continue;
    const key = bucket(r, g, b);
    const c = counts.get(key) ?? { n: 0, r: 0, g: 0, b: 0 };
    c.n++;
    c.r += r;
    c.g += g;
    c.b += b;
    counts.set(key, c);
  }
  let best: { n: number; r: number; g: number; b: number } | null = null;
  for (const c of counts.values()) if (!best || c.n > best.n) best = c;
  return best ? [Math.round(best.r / best.n), Math.round(best.g / best.n), Math.round(best.b / best.n)] : null;
}

export function makeBackView(rgba: Uint8ClampedArray, mask: Mask, neckY: number): Uint8ClampedArray {
  const { width, height, data } = mask;
  const out = new Uint8ClampedArray(rgba);
  const edge = distanceToEdge(mask);
  const n = width * height;
  const isOutline = (p: number) => edge[p] <= OUTLINE_PX;

  // --- Head: remove interior facial features. ---
  const headPixels: number[] = [];
  for (let p = 0; p < n; p++) if (data[p] && Math.floor(p / width) <= neckY) headPixels.push(p);
  const headColor = dominantColor(rgba, headPixels);
  const replaced = new Uint8Array(n);
  if (headColor) {
    const key = bucket(...headColor);
    const feature = new Uint8Array(n);
    for (const p of headPixels) {
      if (isOutline(p)) continue;
      if (bucket(rgba[p * 4], rgba[p * 4 + 1], rgba[p * 4 + 2]) !== key) feature[p] = 1;
    }
    const seen = new Uint8Array(n);
    const stack: number[] = [];
    for (const start of headPixels) {
      if (!feature[start] || seen[start]) continue;
      const component: number[] = [];
      let around = 0;
      let aroundHeadColor = 0;
      seen[start] = 1;
      stack.push(start);
      while (stack.length) {
        const p = stack.pop()!;
        component.push(p);
        const x = p % width;
        const y = (p - x) / width;
        for (const q of [x > 0 ? p - 1 : -1, x < width - 1 ? p + 1 : -1, y > 0 ? p - width : -1, y < height - 1 ? p + width : -1]) {
          if (q < 0) continue;
          if (feature[q]) {
            if (!seen[q]) {
              seen[q] = 1;
              stack.push(q);
            }
            continue;
          }
          around++;
          if (data[q] && !isOutline(q) && bucket(rgba[q * 4], rgba[q * 4 + 1], rgba[q * 4 + 2]) === key) aroundHeadColor++;
        }
      }
      // Eyes, nose, mouth: small and almost fully surrounded by the face colour.
      // Bows, ears, hair and inner outlines border the outline or the background, so they stay.
      const enclosed = around > 0 && aroundHeadColor / around >= 0.75;
      if (!enclosed || component.length > headPixels.length * 0.3) continue;
      for (const p of component) {
        out.set(headColor, p * 4);
        replaced[p] = 1;
      }
    }
  }
  // --- Everywhere: fill dark interior ink lines from neighbouring colours (multi-source BFS). ---
  const hole = new Uint8Array(n);
  const queue: number[] = [];
  for (let p = 0; p < n; p++) {
    if (!data[p]) continue;
    const dark = luminance(out[p * 4], out[p * 4 + 1], out[p * 4 + 2]) < INK_LUMINANCE;
    if (dark && !isOutline(p) && !replaced[p]) hole[p] = 1;
    else queue.push(p);
  }
  for (let head = 0; head < queue.length; head++) {
    const p = queue[head];
    const x = p % width;
    const y = (p - x) / width;
    for (const q of [x > 0 ? p - 1 : -1, x < width - 1 ? p + 1 : -1, y > 0 ? p - width : -1, y < height - 1 ? p + width : -1]) {
      if (q < 0 || !hole[q]) continue;
      hole[q] = 0;
      out[q * 4] = out[p * 4];
      out[q * 4 + 1] = out[p * 4 + 1];
      out[q * 4 + 2] = out[p * 4 + 2];
      queue.push(q);
    }
  }
  return out;
}
