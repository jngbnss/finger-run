import {
  Bone,
  BufferGeometry,
  DoubleSide,
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
const MAX_HALF_DEPTH_M = 0.16;
const GRID_ROWS = 64;

export interface CharacterRig {
  mesh: SkinnedMesh;
  bones: Record<string, Bone>;
  root: Bone;
  rootRest: { x: number; y: number };
  dispose(): void;
}

export function buildRig(mask: Mask, joints: Joints, texture: Texture, flip = false): CharacterRig {
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
  const softness = heightPx * 0.03;

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const px = gx0 + c * step;
      const py = gy0 + r * step;
      const m = toModel({ x: px, y: py });
      const z = depthAt(px, py);
      const w = skinWeights({ x: px, y: py }, joints, softness);
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
  const indices: number[] = [];
  for (let r = 0; r < rows - 1; r++) {
    for (let c = 0; c < cols - 1; c++) {
      if (!keepCell(c, r)) continue;
      const a = r * cols + c;
      const b = a + 1;
      const d = a + cols;
      const e = d + 1;
      // Front faces +Z; back layer reversed so it faces -Z.
      const front = sx > 0 ? [a, d, b, b, d, e] : [a, b, d, b, e, d];
      indices.push(...front);
      indices.push(...front.map((i) => i + vertexCount).reverse());
    }
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new Float32BufferAttribute(positions, 3));
  geometry.setAttribute("uv", new Float32BufferAttribute(uvs, 2));
  geometry.setAttribute("skinIndex", new Uint16BufferAttribute(skinIndex, 4));
  geometry.setAttribute("skinWeight", new Float32BufferAttribute(skinWeight, 4));
  geometry.setIndex(indices);
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
  const material = new MeshStandardMaterial({
    map: texture,
    emissiveMap: texture,
    emissive: 0xffffff,
    emissiveIntensity: 0.55,
    alphaTest: 0.5,
    side: DoubleSide,
    roughness: 0.8,
    metalness: 0,
  });
  const mesh = new SkinnedMesh(geometry, material);
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
    dispose() {
      geometry.dispose();
      material.dispose();
    },
  };
}
