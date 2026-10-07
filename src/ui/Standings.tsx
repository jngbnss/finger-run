import { laneColor } from "../multiplayer/lanes";
import type { RacePlayerView } from "../multiplayer/roomSession";
import { formatTime } from "./Hud";

/** Live ranking during the race. */
export function Standings({
  runners,
  raceId,
  startAt,
}: {
  runners: RacePlayerView[];
  raceId: string | null;
  startAt: number | null;
}) {
  return (
    <section
      className="card standings"
      aria-labelledby="standings-title"
      data-race-id={raceId ?? ""}
      data-start-at={startAt ?? ""}
    >
      <h2 id="standings-title">Standings</h2>
      <ol data-testid="standings">
        {runners.map((r) => (
          <li key={r.userId} className={r.isMe ? "me" : ""}>
            <span className="rank">{r.rank}</span>
            <span className="lane-dot" style={{ background: laneColor(r.lane) }} aria-hidden />
            <span className="name">
              {r.nickname}
              {r.isMe && " (you)"}
            </span>
            <span className="dist">
              {r.status === "FINISHED" && r.finishTimeMs !== null ? formatTime(r.finishTimeMs) : `${r.distanceM.toFixed(0)}m`}
            </span>
            {!r.connected && <span className="tag bad">Offline</span>}
          </li>
        ))}
      </ol>
    </section>
  );
}

interface ResultsBoardProps {
  results: RacePlayerView[];
  busy: boolean;
  onRematch: () => void;
  onLeave: () => void;
}

export function ResultsBoard({ results, busy, onRematch, onLeave }: ResultsBoardProps) {
  return (
    <section className="card results-board" aria-labelledby="results-title">
      <h2 id="results-title">Results</h2>
      <table data-testid="results">
        <thead>
          <tr>
            <th scope="col">#</th>
            <th scope="col">Player</th>
            <th scope="col">Time</th>
          </tr>
        </thead>
        <tbody>
          {results.map((r) => (
            <tr key={r.userId} className={r.isMe ? "me" : ""}>
              <td>{r.rank}</td>
              <td>
                <span className="lane-dot" style={{ background: laneColor(r.lane) }} aria-hidden /> {r.nickname}
                {r.isMe && " (you)"}
              </td>
              <td>{r.status === "FINISHED" && r.finishTimeMs !== null ? formatTime(r.finishTimeMs) : `DNF (${r.distanceM.toFixed(1)}m)`}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="buttons action-card">
        <button type="button" className="primary" onClick={onRematch} disabled={busy}>
          REMATCH
        </button>
        <button type="button" onClick={onLeave} disabled={busy}>
          LEAVE ROOM
        </button>
      </div>
    </section>
  );
}
