import { describe, expect, it } from "vitest";
import { distanceToEdge, inflateDepth } from "./inflate";
import { maskArea, maskBounds, segmentCharacter } from "./segment";
import {
  BONES,
  JOINTS,
  decodeRig,
  distanceToSegment,
  encodeRig,
  guessJoints,
  normalizeJoints,
  skinWeights,
  type Joints,
  type Point,
} from "./skeleton";

const W = 100;
const H = 120;

/** White paper with a black stick figure (and a stray dot far away). */
function stickFigure(): Uint8ClampedArray {
  const rgba = new Uint8ClampedArray(W * H * 4).fill(255);
  const ink = (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    const i = (y * W + x) * 4;
    rgba[i] = rgba[i + 1] = rgba[i + 2] = 20;
  };
  const line = (a: Point, b: Point, r = 2) => {
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) if (distanceToSegment({ x, y }, a, b) <= r) ink(x, y);
  };
  // Head: filled disc so the head has some body.
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (Math.hypot(x - 50, y - 14) <= 9) ink(x, y);
  line({ x: 50, y: 22 }, { x: 50, y: 66 }); // torso
  line({ x: 50, y: 32 }, { x: 18, y: 58 }); // arm (image left)
  line({ x: 50, y: 32 }, { x: 82, y: 58 }); // arm (image right)
  line({ x: 50, y: 66 }, { x: 34, y: 112 }); // leg (image left)
  line({ x: 50, y: 66 }, { x: 66, y: 112 }); // leg (image right)
  ink(95, 5); // stray mark
  return rgba;
}

describe("segmentation", () => {
  const mask = segmentCharacter(stickFigure(), W, H);

  it("separates the drawing from white paper", () => {
    const at = (x: number, y: number) => mask.data[y * W + x];
    expect(at(50, 14)).toBe(1); // head
    expect(at(50, 45)).toBe(1); // torso
    expect(at(18, 58)).toBe(1); // hand
    expect(at(5, 100)).toBe(0); // paper
    expect(at(30, 20)).toBe(0); // paper between head and arm
  });

  it("drops stray marks by keeping the largest part", () => {
    expect(mask.data[5 * W + 95]).toBe(0);
    const box = maskBounds(mask)!;
    expect(box.y0).toBeLessThanOrEqual(6);
    expect(box.y1).toBeGreaterThanOrEqual(112);
    expect(box.x0).toBeLessThanOrEqual(17);
    expect(box.x1).toBeGreaterThanOrEqual(83);
  });

  it("keeps enclosed paper inside the character", () => {
    // A ring drawn on paper: the inside stays part of the character.
    const rgba = new Uint8ClampedArray(40 * 40 * 4).fill(255);
    for (let y = 0; y < 40; y++)
      for (let x = 0; x < 40; x++) {
        const d = Math.hypot(x - 20, y - 20);
        if (d > 10 && d < 13) {
          const i = (y * 40 + x) * 4;
          rgba[i] = rgba[i + 1] = rgba[i + 2] = 0;
        }
      }
    const ring = segmentCharacter(rgba, 40, 40);
    expect(ring.data[20 * 40 + 20]).toBe(1);
    expect(ring.data[2 * 40 + 2]).toBe(0);
  });

  it("treats transparent pixels as background", () => {
    const rgba = new Uint8ClampedArray(20 * 20 * 4); // all transparent black
    for (let y = 5; y < 15; y++)
      for (let x = 5; x < 15; x++) {
        const i = (y * 20 + x) * 4;
        rgba[i] = 200;
        rgba[i + 3] = 255;
      }
    const m = segmentCharacter(rgba, 20, 20);
    expect(maskArea(m)).toBeGreaterThanOrEqual(100);
    expect(m.data[0]).toBe(0);
  });
});

describe("joint guessing", () => {
  const mask = segmentCharacter(stickFigure(), W, H);
  const joints = guessJoints(mask);

  it("places every joint on the drawing", () => {
    for (const name of JOINTS) {
      const p = joints[name];
      const near = [-3, -2, -1, 0, 1, 2, 3].some((dy) =>
        [-3, -2, -1, 0, 1, 2, 3].some((dx) => mask.data[(Math.round(p.y) + dy) * W + Math.round(p.x) + dx] === 1),
      );
      expect(near, name).toBe(true);
    }
  });

  it("finds head on top, hands at the sides and feet at the bottom", () => {
    expect(joints.head.y).toBeLessThan(joints.neck.y);
    // The neck sits below the head disc (head centre y=14, radius 9).
    expect(joints.neck.y).toBeGreaterThanOrEqual(22);
    expect(joints.neck.y).toBeLessThan(32);
    expect(joints.neck.y).toBeLessThan(joints.root.y);
    expect(joints.lHand.x).toBeLessThan(25);
    expect(joints.rHand.x).toBeGreaterThan(75);
    expect(joints.lFoot.y).toBeGreaterThan(105);
    expect(joints.rFoot.y).toBeGreaterThan(105);
    expect(joints.lFoot.x).toBeLessThan(50);
    expect(joints.rFoot.x).toBeGreaterThan(50);
    expect(joints.lKnee.y).toBeGreaterThan(joints.lHip.y);
    expect(joints.lKnee.y).toBeLessThan(joints.lFoot.y);
  });
});

describe("skinning weights", () => {
  const joints: Joints = {
    head: { x: 50, y: 6 },
    neck: { x: 50, y: 22 },
    root: { x: 50, y: 66 },
    lShoulder: { x: 46, y: 34 },
    lElbow: { x: 34, y: 45 },
    lHand: { x: 18, y: 58 },
    rShoulder: { x: 54, y: 34 },
    rElbow: { x: 66, y: 45 },
    rHand: { x: 82, y: 58 },
    lHip: { x: 46, y: 70 },
    lKnee: { x: 40, y: 90 },
    lFoot: { x: 34, y: 112 },
    rHip: { x: 54, y: 70 },
    rKnee: { x: 60, y: 90 },
    rFoot: { x: 66, y: 112 },
  };
  const bone = (name: string) => BONES.findIndex((b) => b.name === name);

  it("binds a point on the forearm mostly to the forearm", () => {
    const w = skinWeights({ x: 24, y: 53 }, joints, 4);
    expect(w.index[0]).toBe(bone("lForearm"));
    expect(w.weight[0]).toBeGreaterThan(0.8);
    expect(w.weight[0] + w.weight[1]).toBeCloseTo(1);
  });

  it("blends two bones at a joint", () => {
    const w = skinWeights(joints.lKnee, joints, 4);
    expect([bone("lThigh"), bone("lShin")]).toContain(w.index[0]);
    expect([bone("lThigh"), bone("lShin")]).toContain(w.index[1]);
    expect(w.weight[1]).toBeGreaterThan(0.3);
  });

  it("keeps everything above the neck rigidly on the head", () => {
    expect(skinWeights({ x: 52, y: 10 }, joints, 4)).toEqual({ index: [bone("head"), bone("head")], weight: [1, 0] });
    // A wide cheek right above the shoulder is still head, not arm.
    expect(skinWeights({ x: 40, y: 20 }, joints, 4).weight[0]).toBe(1);
    expect(skinWeights({ x: 40, y: 20 }, joints, 4).index[0]).toBe(bone("head"));
  });

  it("lets a raised arm above the neck follow the arm", () => {
    const raised = { ...joints, lElbow: { x: 34, y: 18 }, lHand: { x: 30, y: 2 } };
    expect(skinWeights({ x: 30, y: 4 }, raised, 4).index[0]).toBe(bone("lForearm"));
  });

  it("only blends bones that are connected", () => {
    const w = skinWeights({ x: 46, y: 50 }, joints, 4);
    const names = w.index.map((i) => BONES[i].name);
    if (w.weight[1] > 0) {
      const pair = names.join("|");
      expect(["spine|lUpperArm", "lUpperArm|spine", "spine|lThigh", "lThigh|spine", "spine|rThigh", "rThigh|spine", "spine|head", "head|spine", "lUpperArm|lForearm", "lForearm|lUpperArm"]).toContain(pair);
    }
  });
});

describe("rig encoding for presence", () => {
  it("round-trips joints and flip in under 400 characters", () => {
    const mask = segmentCharacter(stickFigure(), W, H);
    const norm = normalizeJoints(guessJoints(mask), W, H);
    const text = encodeRig(norm, true);
    expect(text.length).toBeLessThan(400);
    const back = decodeRig(text)!;
    expect(back.flip).toBe(true);
    for (const j of JOINTS) {
      expect(back.joints[j].x).toBeCloseTo(norm[j].x, 2);
      expect(back.joints[j].y).toBeCloseTo(norm[j].y, 2);
    }
  });

  it("rejects malformed or out-of-range data", () => {
    expect(decodeRig(null)).toBeNull();
    expect(decodeRig("1,2;3")).toBeNull();
    expect(decodeRig(JOINTS.map(() => "0.5,1.5").join(";") + ";0")).toBeNull();
    expect(decodeRig(JOINTS.map(() => "0.5,abc").join(";") + ";0")).toBeNull();
    expect(decodeRig("x".repeat(500))).toBeNull();
  });
});

describe("inflation", () => {
  it("is thickest in the middle and zero at the outline", () => {
    const mask = segmentCharacter(stickFigure(), W, H);
    const d = distanceToEdge(mask);
    expect(d[14 * W + 50]).toBeGreaterThan(d[45 * W + 50]); // head centre is wider than the torso line
    expect(d[0]).toBe(0);
    const max = 10;
    expect(inflateDepth(0, max, 0.2)).toBe(0);
    expect(inflateDepth(max, max, 0.2)).toBeCloseTo(0.2);
    expect(inflateDepth(max * 3, max, 0.2)).toBeCloseTo(0.2);
    expect(inflateDepth(2, max, 0.2)).toBeGreaterThan(inflateDepth(1, max, 0.2));
  });
});
