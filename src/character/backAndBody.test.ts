import { describe, expect, it } from "vitest";
import { makeBackView } from "./backView";
import { limbFreedom, torsoShape } from "./buildRig";
import type { Mask } from "./segment";
import { BONES, JOINT_LABELS, jointSide, skinWeights, type Joints } from "./skeleton";

describe("painted back view", () => {
  // A yellow head with a black outline, two black eyes, a pink nose, and a pink bow
  // sticking out of the top-left of the silhouette.
  const W = 70;
  const H = 70;
  const mask: Mask = { width: W, height: H, data: new Uint8Array(W * H) };
  const rgba = new Uint8ClampedArray(W * H * 4);
  const paint = (x: number, y: number, c: number[]) => rgba.set([...c, 255], (y * W + x) * 4);
  const BLACK = [20, 20, 20];
  const YELLOW = [250, 215, 40];
  const PINK = [240, 80, 160];
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const head = Math.hypot(x - 38, y - 38) <= 26;
      const bow = Math.hypot(x - 16, y - 16) <= 10;
      if (!head && !bow) continue;
      mask.data[y * W + x] = 1;
      const edgeOfHead = head && Math.hypot(x - 38, y - 38) > 23;
      paint(x, y, bow ? PINK : edgeOfHead ? BLACK : YELLOW);
    }
  for (const [ex, ey] of [
    [30, 34],
    [46, 34],
  ])
    for (let y = ey - 2; y <= ey + 2; y++) for (let x = ex - 2; x <= ex + 2; x++) paint(x, y, BLACK);
  for (let y = 41; y <= 43; y++) for (let x = 37; x <= 39; x++) paint(x, y, PINK);

  const back = makeBackView(rgba, mask, H);
  const px = (x: number, y: number) => [...back.slice((y * W + x) * 4, (y * W + x) * 4 + 3)];

  it("paints over eyes and nose with the face colour", () => {
    expect(px(30, 34)).toEqual(YELLOW);
    expect(px(46, 34)).toEqual(YELLOW);
    expect(px(38, 42)).toEqual(YELLOW);
  });

  it("keeps the bow and the outline", () => {
    expect(px(14, 14)).toEqual(PINK);
    expect(px(38, 13)).toEqual(BLACK);
  });

  it("does not touch the background", () => {
    expect(back[3]).toBe(0);
  });
});

describe("chunky characters", () => {
  // Kitty-like: wide body (x 20..80) from y 40 to 90, short legs, arms drawn on the body.
  const W = 100;
  const H = 120;
  const mask: Mask = { width: W, height: H, data: new Uint8Array(W * H) };
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const head = Math.hypot(x - 50, y - 20) <= 20;
      const body = x >= 20 && x <= 80 && y >= 40 && y <= 95;
      const legs = (x >= 30 && x <= 42 && y > 95 && y < 118) || (x >= 58 && x <= 70 && y > 95 && y < 118);
      if (head || body || legs) mask.data[y * W + x] = 1;
    }
  const joints: Joints = {
    head: { x: 50, y: 4 },
    neck: { x: 50, y: 40 },
    root: { x: 50, y: 85 },
    lShoulder: { x: 30, y: 45 },
    lElbow: { x: 26, y: 60 },
    lHand: { x: 30, y: 72 },
    rShoulder: { x: 70, y: 45 },
    rElbow: { x: 74, y: 60 },
    rHand: { x: 70, y: 72 },
    lHip: { x: 38, y: 92 },
    lKnee: { x: 36, y: 104 },
    lFoot: { x: 36, y: 117 },
    rHip: { x: 62, y: 92 },
    rKnee: { x: 64, y: 104 },
    rFoot: { x: 64, y: 117 },
  };
  const torso = torsoShape(mask, joints);

  it("finds the body width", () => {
    expect(torso.halfWidth).toBeGreaterThan(25);
    expect(torso.contains({ x: 40, y: 60 })).toBe(true);
    expect(torso.contains({ x: 50, y: 20 })).toBe(false);
  });

  it("keeps body pixels on the spine even next to an arm drawn over it", () => {
    const spine = BONES.findIndex((b) => b.name === "spine");
    const w = skinWeights({ x: 36, y: 64 }, joints, 2, torso.contains);
    expect(w).toEqual({ index: [spine, spine], weight: [1, 0] });
  });

  it("swings arms against the body and short legs only a little", () => {
    const f = limbFreedom(joints, 118, torso);
    expect(f.lArm).toBe(0.25);
    expect(f.rArm).toBe(0.25);
    expect(f.lLeg).toBeLessThan(0.5);
  });

  it("lets a stick figure swing fully", () => {
    const thin: Mask = { width: W, height: H, data: new Uint8Array(W * H) };
    for (let y = 40; y < 90; y++) thin.data[y * W + 50] = 1;
    const stick: Joints = {
      ...joints,
      lHand: { x: 5, y: 60 },
      rHand: { x: 95, y: 60 },
      lHip: { x: 48, y: 88 },
      lKnee: { x: 40, y: 100 },
      lFoot: { x: 30, y: 117 },
    };
    const f = limbFreedom(stick, 118, torsoShape(thin, stick));
    expect(f.lArm).toBe(1);
    expect(f.rArm).toBe(1);
  });
});

describe("joint names", () => {
  it("colours the hip centre as the middle, not the right side", () => {
    expect(jointSide("root")).toBe("center");
    expect(jointSide("lHand")).toBe("pictureLeft");
    expect(jointSide("rKnee")).toBe("pictureRight");
  });

  it("names limbs from the character's point of view", () => {
    expect(JOINT_LABELS.lHand).toBe("Right hand");
    expect(JOINT_LABELS.rFoot).toBe("Left foot");
  });
});
