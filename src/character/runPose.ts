/**
 * Run cycle for the drawn character. The drawing faces the running direction, so
 * limbs swing forward and back out of the drawing's plane: every value is a rotation
 * about the drawing's horizontal axis (bone.rotation.x, radians).
 *
 * Sign convention (character front = +Z): for a bone hanging down, a negative angle
 * swings its end forward; for the spine (pointing up), a positive angle leans forward.
 * `phase` advances with the engine's animation speed; `amount` is 0 (standing) to 1.
 * `freedom` scales each limb (see limbFreedom): limbs drawn against the body swing less.
 */
export interface RunPose {
  pitch: Record<string, number>;
  /** Upward hip offset in metres. */
  bob: number;
}

const FULL = { lArm: 1, rArm: 1, lLeg: 1, rLeg: 1 };

export function runPose(
  phase: number,
  amount: number,
  freedom: { lArm: number; rArm: number; lLeg: number; rLeg: number } = FULL,
): RunPose {
  const s = Math.sin(phase);
  const c = Math.cos(phase);
  const a = Math.max(0, Math.min(1, amount));
  // About 20 degrees each way at full speed: enough to read as running without tearing.
  const legSwing = 0.35 * a;
  const armSwing = 0.35 * a;
  return {
    pitch: {
      spine: 0.08 * a,
      // The head stays level with the body so the face never shears.
      head: 0,
      lThigh: -legSwing * s * freedom.lLeg,
      rThigh: legSwing * s * freedom.rLeg,
      // A knee folds (shin swings back) while that leg travels backward.
      lShin: 0.5 * a * Math.max(0, s) * freedom.lLeg,
      rShin: 0.5 * a * Math.max(0, -s) * freedom.rLeg,
      // Arms swing opposite to the legs on the same side, elbows bent forward.
      lUpperArm: armSwing * s * freedom.lArm,
      rUpperArm: -armSwing * s * freedom.rArm,
      lForearm: -0.35 * a * freedom.lArm,
      rForearm: -0.35 * a * freedom.rArm,
    },
    bob: 0.05 * a * Math.abs(c),
  };
}
