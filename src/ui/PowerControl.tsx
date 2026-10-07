import type { CSSProperties } from "react";
import type { RaceSnapshot, StoredBest } from "../game/types";
import { formatTime } from "./Hud";

interface PowerControlProps {
  race: RaceSnapshot;
  best: StoredBest | null;
  onPower: (power: number) => void;
  onStart: () => void;
  onReset: () => void;
  onClearBest: () => void;
}

export function PowerControl({ race, best, onPower, onStart, onReset, onClearBest }: PowerControlProps) {
  return (
    <section className="card controls">
      <label className="power" htmlFor="power">
        <span>POWER</span>
        <output htmlFor="power">{race.targetPower}</output>
      </label>
      <input
        id="power"
        type="range"
        min={0}
        max={100}
        step={1}
        value={race.targetPower}
        onChange={(e) => onPower(Number(e.target.value))}
        style={{ "--fill": `${race.targetPower}%` } as CSSProperties}
      />
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
