/**
 * Cuts a drawn character out of its paper background. Pure: works on RGBA arrays.
 *
 * 1. Background colour = median of the border pixels (paper colour).
 * 2. Flood-fill from the border through pixels close to that colour: that is the background.
 *    Everything else is the character, including enclosed white areas (a face, a shirt).
 * 3. Keep the largest connected part and grow it by one pixel to soften the edge.
 */

export interface Mask {
  width: number;
  height: number;
  /** 1 = character, 0 = background. */
  data: Uint8Array;
}

export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export const DEFAULT_TOLERANCE = 60;

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[sorted.length >> 1] ?? 255;
}

export function backgroundColor(rgba: Uint8ClampedArray, width: number, height: number): [number, number, number] {
  const r: number[] = [];
  const g: number[] = [];
  const b: number[] = [];
  const push = (x: number, y: number) => {
    const i = (y * width + x) * 4;
    r.push(rgba[i]);
    g.push(rgba[i + 1]);
    b.push(rgba[i + 2]);
  };
  for (let x = 0; x < width; x++) {
    push(x, 0);
    push(x, height - 1);
  }
  for (let y = 0; y < height; y++) {
    push(0, y);
    push(width - 1, y);
  }
  return [median(r), median(g), median(b)];
}

export function segmentCharacter(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  tolerance = DEFAULT_TOLERANCE,
): Mask {
  const n = width * height;
  const [br, bg, bb] = backgroundColor(rgba, width, height);
  const tol2 = tolerance * tolerance;
  const isPaper = (p: number) => {
    const i = p * 4;
    // Transparent pixels in a PNG count as background too.
    if (rgba[i + 3] < 32) return true;
    const dr = rgba[i] - br;
    const dg = rgba[i + 1] - bg;
    const db = rgba[i + 2] - bb;
    return dr * dr + dg * dg + db * db <= tol2;
  };

  // Flood fill the background from every border pixel.
  const background = new Uint8Array(n);
  const stack: number[] = [];
  const seed = (p: number) => {
    if (!background[p] && isPaper(p)) {
      background[p] = 1;
      stack.push(p);
    }
  };
  for (let x = 0; x < width; x++) {
    seed(x);
    seed((height - 1) * width + x);
  }
  for (let y = 0; y < height; y++) {
    seed(y * width);
    seed(y * width + width - 1);
  }
  while (stack.length) {
    const p = stack.pop()!;
    const x = p % width;
    const y = (p - x) / width;
    if (x > 0) seed(p - 1);
    if (x < width - 1) seed(p + 1);
    if (y > 0) seed(p - width);
    if (y < height - 1) seed(p + width);
  }

  const fg = new Uint8Array(n);
  for (let p = 0; p < n; p++) fg[p] = background[p] ? 0 : 1;
  return dilate(largestComponent({ width, height, data: fg }), 1);
}

/** Keeps only the biggest 8-connected region (drops specks and stray marks). */
export function largestComponent(mask: Mask): Mask {
  const { width, height, data } = mask;
  const label = new Int32Array(width * height);
  let best = 0;
  let bestSize = 0;
  let next = 1;
  const stack: number[] = [];
  for (let start = 0; start < data.length; start++) {
    if (!data[start] || label[start]) continue;
    const id = next++;
    let size = 0;
    label[start] = id;
    stack.push(start);
    while (stack.length) {
      const p = stack.pop()!;
      size++;
      const x = p % width;
      const y = (p - x) / width;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          const q = ny * width + nx;
          if (data[q] && !label[q]) {
            label[q] = id;
            stack.push(q);
          }
        }
      }
    }
    if (size > bestSize) {
      bestSize = size;
      best = id;
    }
  }
  const out = new Uint8Array(data.length);
  for (let p = 0; p < data.length; p++) out[p] = label[p] === best && best !== 0 ? 1 : 0;
  return { width, height, data: out };
}

export function dilate(mask: Mask, radius: number): Mask {
  const { width, height, data } = mask;
  const out = new Uint8Array(data.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!data[y * width + x]) continue;
      for (let dy = -radius; dy <= radius; dy++) {
        for (let dx = -radius; dx <= radius; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx >= 0 && ny >= 0 && nx < width && ny < height) out[ny * width + nx] = 1;
        }
      }
    }
  }
  return { width, height, data: out };
}

export function maskBounds(mask: Mask): Box | null {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (let y = 0; y < mask.height; y++) {
    for (let x = 0; x < mask.width; x++) {
      if (!mask.data[y * mask.width + x]) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  return Number.isFinite(x0) ? { x0, y0, x1, y1 } : null;
}

export function maskArea(mask: Mask): number {
  let n = 0;
  for (const v of mask.data) n += v;
  return n;
}
