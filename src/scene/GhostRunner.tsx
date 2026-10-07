import { ghostAt } from "../game/ghost";
import { animationScaleFromPower, speedFromPower } from "../game/powerCurve";
import type { StoredBest } from "../game/types";
import type { SceneRunner } from "./RaceScene";

/** The best solo run replayed in lane 2; pauses after its final sample. */
export function ghostRunner(best: StoredBest, elapsedMs: number, racing: boolean): SceneRunner {
  const pose = ghostAt(best, elapsedMs);
  const active = racing && !pose.done;
  return {
    id: "ghost",
    lane: 2,
    distanceM: pose.distanceM,
    smoothedPower: pose.smoothedPower,
    speedMps: active ? speedFromPower(pose.smoothedPower) : 0,
    animationScale: active ? animationScaleFromPower(pose.smoothedPower) : 0,
    running: active,
    ghost: true,
  };
}
