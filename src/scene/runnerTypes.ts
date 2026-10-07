export interface RunnerVisualProps {
  distanceM: number;
  speedMps: number;
  smoothedPower: number;
  animationScale: number;
  running: boolean;
  ghost?: boolean;
  /** Body colour; lane colour in online races. */
  tint?: string;
}

export const PLAYER_COLOR = "#ff7a1a";
export const GHOST_COLOR = "#5ee7ff";
export const GHOST_OPACITY = 0.35;
export const PLAYER_LANE_Z = -1;
export const GHOST_LANE_Z = 1;
