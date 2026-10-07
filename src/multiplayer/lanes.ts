import { MAX_PLAYERS } from "./protocol";

/** Lowest free lane 1..7, or "ROOM_FULL". Mirrors join_room() in the SQL migration. */
export function assignLane(takenLanes: number[]): number | "ROOM_FULL" {
  const taken = new Set(takenLanes);
  if (taken.size >= MAX_PLAYERS) return "ROOM_FULL";
  for (let lane = 1; lane <= MAX_PLAYERS; lane++) {
    if (!taken.has(lane)) return lane;
  }
  return "ROOM_FULL";
}

export const LANE_COLORS = [
  "#ff7a1a", // 1 orange
  "#5ee7ff", // 2 cyan
  "#b46bff", // 3 violet
  "#39ff88", // 4 green
  "#ff4d7a", // 5 pink
  "#ffe14d", // 6 yellow
  "#4d8bff", // 7 blue
];

export function laneColor(lane: number): string {
  return LANE_COLORS[(lane - 1 + LANE_COLORS.length) % LANE_COLORS.length];
}
