import { useState, type FormEvent } from "react";
import { normalizeNickname, normalizeRoomCode } from "../multiplayer/protocol";

interface OnlineEntryProps {
  enabled: boolean;
  busy: boolean;
  error: { code: string; message: string } | null;
  initialCode: string;
  onCreate: (nickname: string) => void;
  onJoin: (code: string, nickname: string) => void;
}

const NICK_KEY = "finger-run.nickname";

function savedNickname() {
  try {
    return localStorage.getItem(NICK_KEY) ?? "";
  } catch {
    return "";
  }
}

export function rememberNickname(name: string) {
  try {
    localStorage.setItem(NICK_KEY, name);
  } catch {
    // Not remembered.
  }
}

export function OnlineEntry({ enabled, busy, error, initialCode, onCreate, onJoin }: OnlineEntryProps) {
  const [nickname, setNickname] = useState(savedNickname);
  const [code, setCode] = useState(initialCode);
  const validName = normalizeNickname(nickname);
  const validCode = normalizeRoomCode(code);

  const join = (event: FormEvent) => {
    event.preventDefault();
    if (validName && validCode) onJoin(validCode, validName);
  };

  return (
    <section className="card online-entry" aria-labelledby="online-title">
      <h2 id="online-title">Online race (2–7 players)</h2>
      {!enabled && (
        <div className="error-box" role="alert">
          <strong>REALTIME_CONFIG_MISSING</strong>
          <p>Realtime setup required. This build has no Supabase settings, so online rooms are off. SOLO still works.</p>
        </div>
      )}
      <label className="field">
        <span>Nickname</span>
        <input
          value={nickname}
          maxLength={16}
          autoComplete="nickname"
          onChange={(e) => setNickname(e.target.value)}
          disabled={!enabled || busy}
          aria-invalid={nickname.length > 0 && !validName}
        />
      </label>
      <button
        type="button"
        className="primary wide-btn"
        disabled={!enabled || busy || !validName}
        onClick={() => validName && onCreate(validName)}
      >
        CREATE ROOM
      </button>
      <form className="join-row" onSubmit={join}>
        <label className="field">
          <span>Room code</span>
          <input
            value={code}
            maxLength={6}
            inputMode="text"
            autoCapitalize="characters"
            placeholder="ABC123"
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            disabled={!enabled || busy}
          />
        </label>
        <button type="submit" disabled={!enabled || busy || !validName || !validCode}>
          JOIN ROOM
        </button>
      </form>
      {busy && <p className="hint" role="status">Connecting…</p>}
      {error && (
        <div className="error-box" role="alert">
          <strong>{error.code}</strong>
          <p>{error.message}</p>
        </div>
      )}
    </section>
  );
}
