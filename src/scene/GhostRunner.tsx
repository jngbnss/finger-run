import { ghostAt } from "../game/ghost";
import { animationScaleFromPower, speedFromPower } from "../game/powerCurve";
import type { StoredBest } from "../game/types";
import { RunnerSlot } from "./RunnerSlot";
import { GHOST_LANE_Z } from "./runnerTypes";

interface GhostRunnerProps {
  best: StoredBest;
  elapsedMs: number;
  racing: boolean;
}

/** Replays the best run in the next lane; pauses after its final sample. */
export function GhostRunner({ best, elapsedMs, racing }: GhostRunnerProps) {
  const pose = ghostAt(best, elapsedMs);
  const active = racing && !pose.done;
  return (
    <RunnerSlot
      laneZ={GHOST_LANE_Z}
      distanceM={pose.distanceM}
      smoothedPower={pose.smoothedPower}
      speedMps={active ? speedFromPower(pose.smoothedPower) : 0}
      animationScale={active ? animationScaleFromPower(pose.smoothedPower) : 0}
      running={active}
      ghost
    />
  );
}
