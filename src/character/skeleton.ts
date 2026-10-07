import { maskBounds, type Mask } from "./segment";

/**
 * Stick-figure skeleton for a drawn character. Pure math, no three.js.
 * "l"/"r" mean the image's left/right side (the character's right/left).
 */

export const JOINTS = [
  "head",
  "neck",
  "root",
  "lShoulder",
  "lElbow",
  "lHand",
  "rShoulder",
  "rElbow",
  "rHand",
  "lHip",
  "lKnee",
  "lFoot",
  "rHip",
  "rKnee",
  "rFoot",
] as const;

export type JointName = (typeof JOINTS)[number];

export interface Point {
  x: number;
  y: number;
}

/** Joint positions in image pixels (or normalized 0..1, depending on context). */
export type Joints = Record<JointName, Point>;

export interface BoneDef {
  name: string;
  /** Joint the bone pivots around. */
  from: JointName;
  /** Joint at the far end. */
  to: JointName;
  parent: string | null;
}

/** Bone order is also the skin index order. */
export const BONES: BoneDef[] = [
  { name: "spine", from: "root", to: "neck", parent: null },
  { name: "head", from: "neck", to: "head", parent: "spine" },
  { name: "lUpperArm", from: "lShoulder", to: "lElbow", parent: "spine" },
  { name: "lForearm", from: "lElbow", to: "lHand", parent: "lUpperArm" },
  { name: "rUpperArm", from: "rShoulder", to: "rElbow", parent: "spine" },
  { name: "rForearm", from: "rElbow", to: "rHand", parent: "rUpperArm" },
  { name: "lThigh", from: "lHip", to: "lKnee", parent: null },
  { name: "lShin", from: "lKnee", to: "lFoot", parent: "lThigh" },
  { name: "rThigh", from: "rHip", to: "rKnee", parent: null },
  { name: "rShin", from: "rKnee", to: "rFoot", parent: "rThigh" },
];

export const JOINT_LABELS: Record<JointName, string> = {
  head: "Head",
  neck: "Neck",
  root: "Hips",
  lShoulder: "Shoulder",
  lElbow: "Elbow",
  lHand: "Hand",
  rShoulder: "Shoulder",
  rElbow: "Elbow",
  rHand: "Hand",
  lHip: "Hip",
  lKnee: "Knee",
  lFoot: "Foot",
  rHip: "Hip",
  rKnee: "Knee",
  rFoot: "Foot",
};

/** Nearest character pixel to a point (searches outward up to `radius`). */
export function snapToMask(mask: Mask, p: Point, radius = 40): Point {
  const px = Math.round(p.x);
  const py = Math.round(p.y);
  let best: Point | null = null;
  let bestD = Infinity;
  for (let dy = -radius; dy <= radius; dy++) {
    const y = py + dy;
    if (y < 0 || y >= mask.height) continue;
    for (let dx = -radius; dx <= radius; dx++) {
      const x = px + dx;
      if (x < 0 || x >= mask.width || !mask.data[y * mask.width + x]) continue;
      const d = dx * dx + dy * dy;
      if (d < bestD) {
        bestD = d;
        best = { x, y };
      }
    }
  }
  return best ?? { x: p.x, y: p.y };
}

/**
 * First guess of the joints from the silhouette: head at the top, hands at the
 * widest points of the upper body, feet at the lowest points on each side, and the
 * rest in proportion. The player then drags them into place.
 */
export function guessJoints(mask: Mask): Joints {
  const box = maskBounds(mask) ?? { x0: 0, y0: 0, x1: mask.width - 1, y1: mask.height - 1 };
  const w = box.x1 - box.x0 + 1;
  const h = box.y1 - box.y0 + 1;
  const at = (x: number, y: number) => mask.data[y * mask.width + x] === 1;

  // Head: centre of the top rows.
  let sum = 0;
  let count = 0;
  for (let y = box.y0; y <= box.y0 + Math.max(1, Math.round(h * 0.04)); y++) {
    for (let x = box.x0; x <= box.x1; x++) {
      if (at(x, y)) {
        sum += x;
        count++;
      }
    }
  }
  const cx = count ? sum / count : box.x0 + w / 2;

  // Hands: left- and right-most points between 15% and 75% of the height.
  let lHand: Point = { x: box.x0, y: box.y0 + h * 0.5 };
  let rHand: Point = { x: box.x1, y: box.y0 + h * 0.5 };
  let minX = Infinity;
  let maxX = -Infinity;
  for (let y = Math.round(box.y0 + h * 0.15); y <= box.y0 + h * 0.75; y++) {
    for (let x = box.x0; x <= box.x1; x++) {
      if (!at(x, y)) continue;
      if (x < minX) {
        minX = x;
        lHand = { x, y };
      }
      if (x > maxX) {
        maxX = x;
        rHand = { x, y };
      }
    }
  }

  // Feet: lowest point on each side of the centre line in the bottom 15%.
  let lFoot: Point | null = null;
  let rFoot: Point | null = null;
  for (let y = box.y1; y >= box.y0 + h * 0.85; y--) {
    for (let x = box.x0; x <= box.x1; x++) {
      if (!at(x, y)) continue;
      if (x < cx && !lFoot) lFoot = { x, y };
      if (x >= cx && !rFoot) rFoot = { x, y };
    }
    if (lFoot && rFoot) break;
  }
  lFoot ??= { x: cx - w * 0.12, y: box.y1 };
  rFoot ??= { x: cx + w * 0.12, y: box.y1 };

  const head = { x: cx, y: box.y0 + h * 0.06 };
  const neck = { x: cx, y: box.y0 + h * 0.22 };
  const root = { x: cx, y: box.y0 + h * 0.55 };
  const shoulderY = box.y0 + h * 0.26;
  const lShoulder = { x: cx + (lHand.x - cx) * 0.3, y: shoulderY };
  const rShoulder = { x: cx + (rHand.x - cx) * 0.3, y: shoulderY };
  const hipY = box.y0 + h * 0.58;
  const lHip = { x: cx + (lFoot.x - cx) * 0.45, y: hipY };
  const rHip = { x: cx + (rFoot.x - cx) * 0.45, y: hipY };
  const mid = (a: Point, b: Point) => snapToMask(mask, { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, Math.round(w / 4));

  return {
    head: snapToMask(mask, head),
    neck: snapToMask(mask, neck),
    root: snapToMask(mask, root),
    lShoulder: snapToMask(mask, lShoulder),
    lElbow: mid(lShoulder, lHand),
    lHand,
    rShoulder: snapToMask(mask, rShoulder),
    rElbow: mid(rShoulder, rHand),
    rHand,
    lHip: snapToMask(mask, lHip),
    lKnee: mid(lHip, lFoot),
    lFoot,
    rHip: snapToMask(mask, rHip),
    rKnee: mid(rHip, rFoot),
    rFoot,
  };
}

export function distanceToSegment(p: Point, a: Point, b: Point): number {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const len2 = abx * abx + aby * aby;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * abx + (p.y - a.y) * aby) / len2));
  return Math.hypot(p.x - (a.x + abx * t), p.y - (a.y + aby * t));
}

/**
 * Linear-blend-skinning weights for one point: the two nearest bones, weighted by
 * inverse squared distance so joints bend smoothly.
 */
export function skinWeights(p: Point, joints: Joints, softness: number): { index: [number, number]; weight: [number, number] } {
  let i1 = 0;
  let i2 = 0;
  let d1 = Infinity;
  let d2 = Infinity;
  BONES.forEach((bone, i) => {
    const d = distanceToSegment(p, joints[bone.from], joints[bone.to]);
    if (d < d1) {
      i2 = i1;
      d2 = d1;
      i1 = i;
      d1 = d;
    } else if (d < d2) {
      i2 = i;
      d2 = d;
    }
  });
  const e = softness * softness;
  const w1 = 1 / (d1 * d1 + e);
  const w2 = Number.isFinite(d2) ? 1 / (d2 * d2 + e) : 0;
  const total = w1 + w2;
  return { index: [i1, i2], weight: [w1 / total, w2 / total] };
}

/** Joints <-> compact string for presence ("x,y" pairs in 0..1, 3 decimals, then flip flag). */
export function encodeRig(joints: Joints, flip: boolean): string {
  return JOINTS.map((j) => `${joints[j].x.toFixed(3)},${joints[j].y.toFixed(3)}`).join(";") + `;${flip ? 1 : 0}`;
}

export function decodeRig(text: unknown): { joints: Joints; flip: boolean } | null {
  if (typeof text !== "string" || text.length > 400) return null;
  const parts = text.split(";");
  if (parts.length !== JOINTS.length + 1) return null;
  const joints = {} as Joints;
  for (let i = 0; i < JOINTS.length; i++) {
    const [x, y] = parts[i].split(",").map(Number);
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 1 || y < 0 || y > 1) return null;
    joints[JOINTS[i]] = { x, y };
  }
  return { joints, flip: parts[JOINTS.length] === "1" };
}

export function normalizeJoints(joints: Joints, width: number, height: number): Joints {
  const out = {} as Joints;
  for (const j of JOINTS) out[j] = { x: joints[j].x / width, y: joints[j].y / height };
  return out;
}

export function denormalizeJoints(joints: Joints, width: number, height: number): Joints {
  const out = {} as Joints;
  for (const j of JOINTS) out[j] = { x: joints[j].x * width, y: joints[j].y * height };
  return out;
}
