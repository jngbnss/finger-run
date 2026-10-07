import { useState } from "react";
import { laneColor } from "../multiplayer/lanes";
import { MAX_PLAYERS, MIN_PLAYERS } from "../multiplayer/protocol";
import type { SessionView } from "../multiplayer/roomSession";

interface LobbyProps {
  view: SessionView;
  shareUrl: string;
  busy: boolean;
  onReady: (ready: boolean) => void;
  onStart: () => void;
  onLeave: () => void;
}

export function Lobby({ view, shareUrl, busy, onReady, onStart, onLeave }: LobbyProps) {
  const [copied, setCopied] = useState(false);
  const me = view.players.find((p) => p.isMe);
  const allReady = view.players.every((p) => p.ready);
  let startHint = "";
  if (view.players.length < MIN_PLAYERS) startHint = `Waiting for players (${view.players.length}/${MAX_PLAYERS}, need ${MIN_PLAYERS}+)`;
  else if (!allReady) startHint = "Waiting for everyone to press READY";

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };

  return (
    <section className="card lobby" aria-labelledby="lobby-title">
      <h2 id="lobby-title">
        Room <span className="room-code" data-testid="room-code">{view.code}</span>
      </h2>
      <div className="share">
        <input readOnly value={shareUrl} aria-label="Share link" onFocus={(e) => e.target.select()} />
        <button type="button" onClick={copy}>
          {copied ? "COPIED" : "COPY LINK"}
        </button>
      </div>

      <ul className="player-list" aria-label={`Players ${view.players.length} of ${MAX_PLAYERS}`} data-testid="player-list">
        {view.players.map((p) => (
          <li key={p.userId} className={p.isMe ? "me" : ""}>
            <span className="lane-dot" style={{ background: laneColor(p.lane) }} aria-hidden />
            <span className="lane-no">Lane {p.lane}</span>
            <span className="name">
              {p.nickname}
              {p.isMe && " (you)"}
              {p.isHost && <span className="badge">HOST</span>}
            </span>
            <span className={`tag ${p.connected ? "ok" : "bad"}`}>{p.connected ? "Online" : "Offline"}</span>
            <span className={`tag ${p.cameraReady ? "ok" : ""}`}>{p.cameraReady ? "Camera ready" : "No camera"}</span>
            <span className={`tag ${p.ready ? "ok" : ""}`} data-testid="ready-tag">
              {p.ready ? "READY" : "Not ready"}
            </span>
          </li>
        ))}
      </ul>

      <div className="buttons action-card">
        <button
          type="button"
          className={me?.ready ? "" : "primary"}
          onClick={() => onReady(!me?.ready)}
          disabled={busy}
          aria-pressed={me?.ready ?? false}
        >
          {me?.ready ? "NOT READY" : "READY"}
        </button>
        {view.isHost ? (
          <button type="button" className="primary" onClick={onStart} disabled={busy || !view.canStart}>
            START RACE
          </button>
        ) : (
          <button type="button" onClick={onLeave} disabled={busy}>
            LEAVE ROOM
          </button>
        )}
      </div>
      {view.isHost && (
        <>
          <p className="hint" role="status">
            {startHint || "Everyone is ready. Start when you like."}
          </p>
          <button type="button" className="link" onClick={onLeave} disabled={busy}>
            Leave room
          </button>
        </>
      )}
      {!view.isHost && <p className="hint">The host starts the race when everyone is READY.</p>}
    </section>
  );
}
