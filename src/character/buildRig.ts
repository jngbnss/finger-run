import {
  Bone,
  BufferGeometry,
  FrontSide,
  Float32BufferAttribute,
  MeshStandardMaterial,
  Skeleton,
  SkinnedMesh,
  Uint16BufferAttribute,
  type Texture,
} from "three";
import { distanceToEdge, inflateDepth } from "./inflate";
import { maskBounds, type Mask } from "./segment";
import { BONES, skinWeights, type Joints, type Point } from "./skeleton";

/**
 * Turns a cut-out drawing into a skinned, inflated 3D mesh:
 *  - a grid over the silhouette, kept only where the character is
 *  - front and back layers pushed out by the distance to the outline, so the body
 *    and limbs get round, plush-like volume and the layers meet at the edge
 *  - every vertex bound to its two nearest stick-figure bones
 * The mesh stands on y = 0, centred on the hips, facing +Z, CHARACTER_HEIGHT_M tall.
 */

export const CHARACTER_HEIGHT_M = 1.8;
/** Thickest a body part gets (half-depth, metres). */
const MAX_HALF_DEPTH_M = 0.13;
const GRID_ROWS = 64;

/** How freely each limb may swing, 0.25 (drawn against the body) to 1 (sticks out). */
export interface LimbFreedom {
  lArm: number;
  rArm: number;
  lLeg: number;
  rLeg: number;
}

export interface CharacterRig {
  mesh: SkinnedMesh;
  bones: Record<string, Bone>;
  root: Bone;
  rootRest: { x: number; y: number };
  freedom: LimbFreedom;
  dispose(): void;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * Torso band (neck to hips) and its typical half-width, from the silhouette. Anything
 * inside it follows the spine only, so arms or clothes drawn over the body never tear it.
 */
export function torsoShape(mask: Mask, joints: Joints) {
  const top = joints.neck.y;
  const bottom = Math.max(joints.root.y, joints.lHip.y, joints.rHip.y);
  const spineX = (y: number) => {
    const t = bottom === top ? 0 : clamp((y - top) / (joints.root.y - top || 1), 0, 1);
    return joints.neck.x + (joints.root.x - joints.neck.x) * t;
  };
  const widths: number[] = [];
  for (let y = Math.ceil(top); y <= bottom; y++) {
    const yy = Math.round(y);
    if (yy < 0 || yy >= mask.height) continue;
    let x0 = Math.round(spineX(y));
    let x1 = x0;
    const at = (x: number) => x >= 0 && x < mask.width && mask.data[yy * mask.width + x] === 1;
    if (!at(x0)) continue;
    while (at(x0 - 1)) x0--;
    while (at(x1 + 1)) x1++;
    widths.push(x1 - x0 + 1);
  }
  widths.sort((a, b) => a - b);
  const halfWidth = (widths[widths.length >> 1] ?? 0) / 2 + 1;
  return {
    spineX,
    halfWidth,
    contains: (p: Point) => p.y > top && p.y < bottom && Math.abs(p.x - spineX(p.y)) <= halfWidth,
  };
}

/**
 * Arms far from the body and long legs swing fully; arms drawn against the body or
 * short legs under a dress swing a little, so chunky characters do not tear.
 */
export function limbFreedom(joints: Joints, heightPx: number, torso: ReturnType<typeof torsoShape>): LimbFreedom {
  const arm = (hand: Point) => clamp((Math.abs(hand.x - torso.spineX(hand.y)) - torso.halfWidth) / (0.15 * heightPx), 0.25, 1);
  const len = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
  const leg = (hip: Point, knee: Point, foot: Point) => clamp(((len(hip, knee) + len(knee, foot)) / heightPx - 0.1) / 0.25, 0.25, 1);
  return {
    lArm: arm(joints.lHand),
    rArm: arm(joints.rHand),
    lLeg: leg(joints.lHip, joints.lKnee, joints.lFoot),
    rLeg: leg(joints.rHip, joints.rKnee, joints.rFoot),
  };
}

/**
 * @param texture front of the drawing
 * @param backTexture painted back view (see makeBackView); defaults to the front
 */
export function buildRig(mask: Mask, joints: Joints, texture: Texture, flip = false, backTexture?: Texture): CharacterRig {
  const box = maskBounds(mask);
  if (!box) throw new Error("Empty character");
  const heightPx = box.y1 - box.y0 + 1;
  const k = CHARACTER_HEIGHT_M / heightPx;
  const sx = flip ? -1 : 1;
  const toModel = (p: Point) => ({ x: (p.x - joints.root.x) * k * sx, y: (box.y1 + 1 - p.y) * k });

  const dist = distanceToEdge(mask);
  const capPx = MAX_HALF_DEPTH_M / k / 0.85;
  const depthAt = (px: number, py: number) => {
    const x = Math.min(mask.width - 1, Math.max(0, Math.round(px)));
    const y = Math.min(mask.height - 1, Math.max(0, Math.round(py)));
    return inflateDepth(dist[y * mask.width + x], capPx, MAX_HALF_DEPTH_M);
  };

  const step = Math.max(1, Math.round(heightPx / GRID_ROWS));
  const gx0 = box.x0 - step;
  const gy0 = box.y0 - step;
  const cols = Math.ceil((box.x1 - box.x0 + 2 * step) / step) + 1;
  const rows = Math.ceil((box.y1 - box.y0 + 2 * step) / step) + 1;
  const vertexCount = cols * rows;

  const positions = new Float32Array(vertexCount * 2 * 3);
  const uvs = new Float32Array(vertexCount * 2 * 2);
  const skinIndex = new Uint16Array(vertexCount * 2 * 4);
  const skinWeight = new Float32Array(vertexCount * 2 * 4);
  const softness = heightPx * 0.015;
  const torso = torsoShape(mask, joints);

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const px = gx0 + c * step;
      const py = gy0 + r * step;
      const m = toModel({ x: px, y: py });
      const z = depthAt(px, py);
      const w = skinWeights({ x: px, y: py }, joints, softness, torso.contains);
      for (let layer = 0; layer < 2; layer++) {
        const v = layer * vertexCount + r * cols + c;
        positions.set([m.x, m.y, layer === 0 ? z : -z], v * 3);
        uvs.set([px / mask.width, 1 - py / mask.height], v * 2);
        skinIndex.set([w.index[0], w.index[1], 0, 0], v * 4);
        skinWeight.set([w.weight[0], w.weight[1], 0, 0], v * 4);
      }
    }
  }

  // Keep cells that touch the character (grown by one pixel so thin lines survive).
  const inside = (x: number, y: number) =>
    x >= 0 && y >= 0 && x < mask.width && y < mask.height && mask.data[y * mask.width + x] === 1;
  const keepCell = (c: number, r: number) => {
    const x0 = gx0 + c * step;
    const y0 = gy0 + r * step;
    for (let y = y0 - 1; y <= y0 + step; y++) for (let x = x0 - 1; x <= x0 + step; x++) if (inside(x, y)) return true;
    return false;
  };
  const frontIndices: number[] = [];
  const backIndices: number[] = [];
  for (let r = 0; r < rows - 1; r++) {
    for (let c = 0; c < cols - 1; c++) {
      if (!keepCell(c, r)) continue;
      const a = r * cols + c;
      const b = a + 1;
      const d = a + cols;
      const e = d + 1;
      // Front faces +Z; back layer reversed so it faces -Z.
      const front = sx > 0 ? [a, d, b, b, d, e] : [a, b, d, b, e, d];
      frontIndices.push(...front);
      backIndices.push(...front.map((i) => i + vertexCount).reverse());
    }
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new Float32BufferAttribute(positions, 3));
  geometry.setAttribute("uv", new Float32BufferAttribute(uvs, 2));
  geometry.setAttribute("skinIndex", new Uint16BufferAttribute(skinIndex, 4));
  geometry.setAttribute("skinWeight", new Float32BufferAttribute(skinWeight, 4));
  geometry.setIndex([...frontIndices, ...backIndices]);
  geometry.addGroup(0, frontIndices.length, 0);
  geometry.addGroup(frontIndices.length, backIndices.length, 1);
  geometry.computeVertexNormals();

  // Bones sit on their pivot joints; children are positioned relative to parents.
  const rootRest = toModel(joints.root);
  const root = new Bone();
  root.name = "root";
  root.position.set(rootRest.x, rootRest.y, 0);
  const bones: Record<string, Bone> = {};
  for (const def of BONES) {
    const bone = new Bone();
    bone.name = def.name;
    const at = toModel(joints[def.from]);
    const parentDef = def.parent ? BONES.find((b) => b.name === def.parent)! : null;
    const parentAt = parentDef ? toModel(joints[parentDef.from]) : rootRest;
    bone.position.set(at.x - parentAt.x, at.y - parentAt.y, 0);
    (def.parent ? bones[def.parent] : root).add(bone);
    bones[def.name] = bone;
  }

  // Self-lit by the drawing itself so its colours stay close to the paper original;
  // the lighting still shades the puffed-up volume.
  const makeMaterial = (map: Texture) =>
    new MeshStandardMaterial({
      map,
      emissiveMap: map,
      emissive: 0xffffff,
      emissiveIntensity: 0.55,
      alphaTest: 0.5,
      side: FrontSide,
      roughness: 0.8,
      metalness: 0,
    });
  const materials = [makeMaterial(texture), makeMaterial(backTexture ?? texture)];
  const mesh = new SkinnedMesh(geometry, materials);
  mesh.add(root);
  mesh.castShadow = true;
  mesh.frustumCulled = false;
  mesh.updateMatrixWorld(true);
  mesh.bind(new Skeleton(BONES.map((b) => bones[b.name])));

  return {
    mesh,
    bones,
    root,
    rootRest,
    freedom: limbFreedom(joints, heightPx, torso),
    dispose() {
      geometry.dispose();
      materials.forEach((m) => m.dispose());
    },
  };
}