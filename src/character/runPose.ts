/**
 * Run cycle for the drawn character. The drawing faces the running direction, so
 * limbs swing forward and back out of the drawing's plane: every value is a rotation
 * about the drawing's horizontal axis (bone.rotation.x, radians).
 *
 * Sign convention (character front = +Z): for a bone hanging down, a negative angle
 * swings its end forward; for the spine (pointing up), a positive angle leans forward.
 * `phase` advances with the engine's animation speed; `amount` is 0 (standing) to 1.
 */
export interface RunPose {
  pitch: Record<string, number>;
  /** Upward hip offset in metres. */
  bob: number;
}

export function runPose(phase: number, amount: number): RunPose {
  const s = Math.sin(phase);
  const c = Math.cos(phase);
  const a = Math.max(0, Math.min(1, amount));
  const legSwing = 0.6 * a;
  const armSwing = 0.65 * a;
  return {
    pitch: {
      spine: 0.15 * a,
      // The head stays level with the body so the face never shears.
      head: 0,
      lThigh: -legSwing * s,
      rThigh: legSwing * s,
      // A knee folds (shin swings back) while that leg travels backward.
      lShin: 1.0 * a * Math.max(0, s),
      rShin: 1.0 * a * Math.max(0, -s),
      // Arms swing opposite to the legs on the same side, elbows bent forward.
      lUpperArm: armSwing * s,
      rUpperArm: -armSwing * s,
      lForearm: -0.8 * a,
      rForearm: -0.8 * a,
    },
    bob: 0.05 * a * Math.abs(c),
  };
}
