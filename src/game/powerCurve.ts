export const MAX_SPEED_MPS = 9;
export const DEAD_ZONE = 5;

export function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min;
  return Math.min(max, Math.max(min, value));
}

export function clampPower(power: number): number {
  return clamp(power, 0, 100);
}

/** Exponential smoothing toward target; attack is faster than release. */
export function smoothPower(smoothed: number, target: number, dt: number): number {
  const tau = target > smoothed ? 0.08 : 0.18;
  return smoothed + (target - smoothed) * (1 - Math.exp(-dt / tau));
}

export function effectivePower(smoothedPower: number): number {
  return smoothedPower < DEAD_ZONE ? 0 : (smoothedPower - DEAD_ZONE) / (100 - DEAD_ZONE);
}

export function speedFromPower(smoothedPower: number): number {
  return MAX_SPEED_MPS * effectivePower(smoothedPower) ** 1.4;
}

export function animationScaleFromPower(smoothedPower: number): number {
  const effective = effectivePower(smoothedPower);
  return effective === 0 ? 0 : 0.6 + 1.8 * effective;
}
