import { Texture, Vector3 } from "three";
import { describe, expect, it } from "vitest";
import { CHARACTER_HEIGHT_M, buildRig } from "./buildRig";
import { runPose } from "./runPose";
import { maskBounds, type Mask } from "./segment";
import { BONES, distanceToSegment, guessJoints, type Point } from "./skeleton";

/** Mask of a thick stick figure, 100x120. */
function stickMask(): Mask {
  const W = 100;
  const H = 120;
  const data = new Uint8Array(W * H);
  const segs: Array<[Point, Point, number]> = [
    [{ x: 50, y: 14 }, { x: 50, y: 14 }, 9],
    [{ x: 50, y: 22 }, { x: 50, y: 66 }, 4],
    [{ x: 50, y: 32 }, { x: 18, y: 58 }, 3],
    [{ x: 50, y: 32 }, { x: 82, y: 58 }, 3],
    [{ x: 50, y: 66 }, { x: 34, y: 112 }, 3],
    [{ x: 50, y: 66 }, { x: 66, y: 112 }, 3],
  ];
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) if (segs.some(([a, b, r]) => distanceToSegment({ x, y }, a, b) <= r)) data[y * W + x] = 1;
  return { width: W, height: H, data };
}

describe("drawn character rig", () => {
  const mask = stickMask();
  const joints = guessJoints(mask);
  const rig = buildRig(mask, joints, new Texture());
  const pos = rig.mesh.geometry.getAttribute("position");

  it("is CHARACTER_HEIGHT_M tall, stands on the ground and has puffy depth", () => {
    let minY = Infinity;
    let maxY = -Infinity;
    let maxZ = 0;
    const index = rig.mesh.geometry.getIndex()!;
    for (let i = 0; i < index.count; i++) {
      const v = index.getX(i);
      minY = Math.min(minY, pos.getY(v));
      maxY = Math.max(maxY, pos.getY(v));
      maxZ = Math.max(maxZ, Math.abs(pos.getZ(v)));
    }
    expect(maxY - minY).toBeGreaterThan(CHARACTER_HEIGHT_M * 0.95);
    expect(minY).toBeLessThan(0.1);
    expect(maxZ).toBeGreaterThan(0.03);
    expect(maxZ).toBeLessThanOrEqual(0.16 + 1e-6);
    expect(index.count).toBeGreaterThan(300);
  });

  it("has one skeleton bone per stick-figure bone", () => {
    expect(rig.mesh.skeleton.bones.map((b) => b.name)).toEqual(BONES.map((b) => b.name));
  });

  it("moves the hand when the arm bone turns, but not the feet", () => {
    // Same pixel -> model mapping as buildRig.
    const box = maskBounds(mask)!;
    const k = CHARACTER_HEIGHT_M / (box.y1 - box.y0 + 1);
    const nearest = (target: Point) => {
      const tx = (target.x - joints.root.x) * k;
      const ty = (box.y1 + 1 - target.y) * k;
      let best = 0;
      let bestD = Infinity;
      for (let i = 0; i < pos.count / 2; i++) {
        const d = Math.hypot(pos.getX(i) - tx, pos.getY(i) - ty);
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      }
      return best;
    };
    const hand = nearest(joints.lHand);
    const foot = nearest(joints.rFoot);
    const skinned = (i: number) => {
      rig.mesh.updateMatrixWorld(true);
      return rig.mesh.applyBoneTransform(i, new Vector3().fromBufferAttribute(pos, i));
    };
    const handBefore = skinned(hand).clone();
    const footBefore = skinned(foot).clone();
    rig.bones.lUpperArm.rotation.z = 1.2;
    expect(skinned(hand).distanceTo(handBefore)).toBeGreaterThan(0.2);
    expect(skinned(foot).distanceTo(footBefore)).toBeLessThan(0.01);
    rig.bones.lUpperArm.rotation.z = 0;
  });
});

describe("run pose", () => {
  it("stands still at zero amount and swings limbs forward and back in opposition when running", () => {
    const still = runPose(1.3, 0);
    expect(Object.values(still.pitch).every((r) => Math.abs(r) < 1e-9)).toBe(true);
    expect(still.bob).toBe(0);
    const run = runPose(Math.PI / 2, 1);
    expect(run.pitch.lThigh).toBeCloseTo(-run.pitch.rThigh);
    // Each arm swings opposite to the leg on its side.
    expect(Math.sign(run.pitch.lThigh)).toBe(-Math.sign(run.pitch.lUpperArm));
    // The knee of the leg swinging back folds; the forward leg stays straight.
    expect(run.pitch.lThigh).toBeLessThan(0);
    expect(run.pitch.lShin).toBeGreaterThan(0);
    expect(run.pitch.rShin).toBe(0);
    // The head never tilts against the body.
    expect(run.pitch.head).toBe(0);
  });
});
