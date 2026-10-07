import { RACE_DISTANCE_M } from "../game/raceEngine";
import type { RaceSnapshot } from "../game/types";

export function formatTime(ms: number): string {
  return `${(ms / 1000).toFixed(2)}s`;
}

const PHASE_LABEL: Record<RaceSnapshot["phase"], string> = {
  IDLE: "READY",
  COUNTDOWN: "COUNTDOWN",
  RUNNING: "RUNNING",
  FINISHED: "FINISHED",
  DNF: "DNF",
};

export function Hud({ race }: { race: RaceSnapshot }) {
  const stats: Array<[string, string]> = [
    ["Power", `${race.smoothedPower.toFixed(0)} / ${race.targetPower.toFixed(0)}`],
    ["Speed", `${race.speedMps.toFixed(1)} m/s`],
    ["Distance", `${race.distanceM.toFixed(1)} / ${RACE_DISTANCE_M} m`],
    ["Time", formatTime(race.elapsedS * 1000)],
    ["Anim speed", `${race.animationScale.toFixed(2)}×`],
  ];
  return (
    <section className="card hud" aria-live="off">
      <div className={`phase phase-${race.phase.toLowerCase()}`}>{PHASE_LABEL[race.phase]}</div>
      <dl>
        {stats.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      <div className="progress" aria-hidden>
        <div style={{ width: `${(race.distanceM / RACE_DISTANCE_M) * 100}%` }} />
      </div>
    </section>
  );
}
