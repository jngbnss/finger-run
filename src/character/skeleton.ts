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

/** Which side of the picture a joint is on. "root" is the hip centre, not a right-side joint. */
export function jointSide(j: JointName): "center" | "pictureLeft" | "pictureRight" {
  if (j === "head" || j === "neck" || j === "root") return "center";
  return j.startsWith("l") ? "pictureLeft" : "pictureRight";
}

/**
 * Names from the character's point of view, assuming the drawing faces the viewer:
 * the limb on the picture's left is the character's right.
 */
export const JOINT_LABELS: Record<JointName, string> = {
  head: "Head (top)",
  neck: "Neck",
  root: "Hips (centre)",
  lShoulder: "Right shoulder",
  lElbow: "Right elbow",
  lHand: "Right hand",
  rShoulder: "Left shoulder",
  rElbow: "Left elbow",
  rHand: "Left hand",
  lHip: "Right hip",
  lKnee: "Right knee",
  lFoot: "Right foot",
  rHip: "Left hip",
  rKnee: "Left knee",
  rFoot: "Left foot",
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

  // Neck: the first clearly narrow row below the head blob.
  const runWidth = (y: number) => {
    const yy = Math.round(y);
    let x0 = Math.round(cx);
    let x1 = Math.round(cx);
    if (!at(x0, yy)) return 0;
    while (x0 > box.x0 && at(x0 - 1, yy)) x0--;
    while (x1 < box.x1 && at(x1 + 1, yy)) x1++;
    return x1 - x0 + 1;
  };
  let headWidth = 0;
  let neckY = box.y0 + h * 0.22;
  for (let y = box.y0; y <= box.y0 + h * 0.45; y++) {
    const width = runWidth(y);
    headWidth = Math.max(headWidth, width);
    if (y > box.y0 + h * 0.08 && width > 0 && width < headWidth * 0.6) {
      neckY = y;
      break;
    }
  }
  const head = { x: cx, y: box.y0 + (neckY - box.y0) * 0.3 };
  const neck = { x: cx, y: neckY };
  const root = { x: cx, y: Math.max(neckY + h * 0.2, box.y0 + h * 0.55) };
  const shoulderY = neckY + h * 0.05;
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

/** Bones that meet at a joint (or both sit on the torso) and may blend. */
const ADJACENT = new Set(
  [
    ["spine", "head"],
    ["spine", "lUpperArm"],
    ["spine", "rUpperArm"],
    ["spine", "lThigh"],
    ["spine", "rThigh"],
    ["lThigh", "rThigh"],
    ["lUpperArm", "lForearm"],
    ["rUpperArm", "rForearm"],
    ["lThigh", "lShin"],
    ["rThigh", "rShin"],
  ].flatMap(([a, b]) => [`${a}|${b}`, `${b}|${a}`]),
);

const HEAD = BONES.findIndex((b) => b.name === "head");
const SPINE = BONES.findIndex((b) => b.name === "spine");

/**
 * Linear-blend-skinning weights for one point.
 * - Everything above the neck belongs rigidly to the head (so the face never warps),
 *   unless it is clearly part of an arm raised above the neck.
 * - Elsewhere: the nearest bone, blended with its nearest *connected* bone by inverse
 *   squared distance, so joints bend smoothly but a cheek never follows an arm.
 */
export function skinWeights(
  p: Point,
  joints: Joints,
  softness: number,
  /** Pixels of the torso body (between shoulders and hips); they follow only the spine. */
  isTorso: (p: Point) => boolean = () => false,
): { index: [number, number]; weight: [number, number] } {
  const dist = BONES.map((b) => distanceToSegment(p, joints[b.from], joints[b.to]));
  const aboveNeck = p.y <= joints.neck.y;
  // Above the neck only the head competes, plus an arm whose hand is raised above the top of the head.
  const raisedArm = (i: number) => {
    const name = BONES[i].name;
    if (!/arm/i.test(name)) return false;
    const hand = name.startsWith("l") ? joints.lHand : joints.rHand;
    return hand.y < joints.head.y;
  };
  const allowed = (i: number) => !aboveNeck || i === HEAD || raisedArm(i);
  let i1 = HEAD;
  dist.forEach((d, i) => {
    if (allowed(i) && d < dist[i1]) i1 = i;
  });
  if (i1 === HEAD && aboveNeck) return { index: [HEAD, HEAD], weight: [1, 0] };
  // Arms or clothes drawn over the body stay with the body instead of tearing it.
  if (!aboveNeck && isTorso(p) && dist[i1] > softness) return { index: [SPINE, SPINE], weight: [1, 0] };

  let i2 = -1;
  dist.forEach((d, i) => {
    if (i !== i1 && ADJACENT.has(`${BONES[i1].name}|${BONES[i].name}`) && (i2 < 0 || d < dist[i2])) i2 = i;
  });
  if (i2 < 0) return { index: [i1, i1], weight: [1, 0] };
  const e = softness * softness;
  const w1 = 1 / (dist[i1] * dist[i1] + e);
  const w2 = 1 / (dist[i2] * dist[i2] + e);
  return { index: [i1, i2], weight: [w1 / (w1 + w2), w2 / (w1 + w2)] };
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
