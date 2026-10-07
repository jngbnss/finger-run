import type { Mask } from "./segment";

/**
 * Distance (in pixels) from each character pixel to the nearest background pixel,
 * via a two-pass chamfer transform. Used to "inflate" the flat drawing: thick in the
 * middle of the body and limbs, thin at the outline.
 */
export function distanceToEdge(mask: Mask): Float32Array {
  const { width, height, data } = mask;
  const INF = 1e9;
  const d = new Float32Array(width * height);
  for (let i = 0; i < d.length; i++) d[i] = data[i] ? INF : 0;
  const ORTH = 1;
  const DIAG = Math.SQRT2;
  const get = (x: number, y: number) => (x < 0 || y < 0 || x >= width || y >= height ? 0 : d[y * width + x]);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (!data[i]) continue;
      d[i] = Math.min(
        d[i],
        get(x - 1, y) + ORTH,
        get(x, y - 1) + ORTH,
        get(x - 1, y - 1) + DIAG,
        get(x + 1, y - 1) + DIAG,
      );
    }
  }
  for (let y = height - 1; y >= 0; y--) {
    for (let x = width - 1; x >= 0; x--) {
      const i = y * width + x;
      if (!data[i]) continue;
      d[i] = Math.min(
        d[i],
        get(x + 1, y) + ORTH,
        get(x, y + 1) + ORTH,
        get(x + 1, y + 1) + DIAG,
        get(x - 1, y + 1) + DIAG,
      );
    }
  }
  return d;
}

/**
 * Half-thickness for a point `dist` pixels inside the outline. A circular profile
 * (sqrt) gives round, plush-like limbs; `maxDist` caps how fat the torso gets.
 */
export function inflateDepth(dist: number, maxDist: number, maxDepth: number): number {
  if (dist <= 0 || maxDist <= 0) return 0;
  const t = Math.min(1, dist / maxDist);
  return maxDepth * Math.sqrt(t * (2 - t));
}
