/**
 * Run cycle for the drawn character, as Z rotations (radians) in the drawing's plane.
 * The character runs toward image-right: legs and arms swing forward/back in
 * opposition, knees fold on the back swing, the body leans and bobs.
 * `phase` advances with the engine's animation speed; `amount` is 0 (standing) to 1.
 */
export interface RunPose {
  rotations: Record<string, number>;
  /** Upward hip offset in metres. */
  bob: number;
}

export function runPose(phase: number, amount: number): RunPose {
  const s = Math.sin(phase);
  const c = Math.cos(phase);
  const a = Math.max(0, Math.min(1, amount));
  const legSwing = 0.42 * a;
  const armSwing = 0.6 * a;
  // A bone pointing down swings forward (+x) with positive rotation.
  return {
    rotations: {
      spine: -0.12 * a,
      head: 0.08 * a,
      lThigh: legSwing * s,
      rThigh: -legSwing * s,
      // Knee folds (shin swings back) while that leg travels backward.
      lShin: -0.75 * a * Math.max(0, -c),
      rShin: -0.75 * a * Math.max(0, c),
      lUpperArm: -armSwing * s,
      rUpperArm: armSwing * s,
      lForearm: 0.7 * a,
      rForearm: 0.7 * a,
    },
    bob: 0.05 * a * Math.abs(c),
  };
}
