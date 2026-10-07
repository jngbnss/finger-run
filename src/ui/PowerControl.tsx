import type { RaceSnapshot, StoredBest } from "../game/types";
import { formatTime } from "./Hud";

interface PowerControlProps {
  race: RaceSnapshot;
  best: StoredBest | null;
  onStart: () => void;
  onReset: () => void;
  onClearBest: () => void;
}

/** Solo race controls: START, RESET and the best time. */
export function PowerControl({ race, best, onStart, onReset, onClearBest }: PowerControlProps) {
  return (
    <section className="card controls action-card" aria-label="Race controls">
      <div className="buttons">
        <button type="button" className="primary" onClick={onStart} disabled={race.phase !== "IDLE"}>
          START
        </button>
        <button type="button" onClick={onReset} disabled={race.phase === "IDLE"}>
          RESET
        </button>
      </div>
      <div className="best">
        <span>
          Best: <strong>{best ? formatTime(best.timeMs) : "—"}</strong>
          {best && <span className="ghost-tag">ghost on</span>}
        </span>
        <button type="button" className="link" onClick={onClearBest} disabled={!best}>
          Clear best
        </button>
      </div>
    </section>
  );
}
