import { useState } from "react";
import { OnlineGame } from "./OnlineGame";
import { SoloGame } from "./SoloGame";
import { normalizeRoomCode } from "./multiplayer/protocol";
import { useDrawing } from "./skin/useDrawing";

type Mode = "SOLO" | "ONLINE";

function roomFromUrl(): string | null {
  try {
    return normalizeRoomCode(new URL(location.href).searchParams.get("room") ?? "");
  } catch {
    return null;
  }
}

export function App() {
  const [linkCode] = useState(roomFromUrl);
  // A shared ?room= link goes straight to ONLINE; otherwise pick a mode first.
  const [mode, setMode] = useState<Mode | null>(linkCode ? "ONLINE" : null);
  const drawing = useDrawing();

  return (
    <div className="app">
      <header>
        <div className="title">
          <h1>FINGER RUN 3D</h1>
          <p className="subtitle">POWER CONTROL PROTOTYPE</p>
        </div>
        {mode && (
          <nav className="mode-tabs" aria-label="Game mode">
            {(["SOLO", "ONLINE"] as const).map((m) => (
              <button key={m} type="button" aria-pressed={mode === m} className={mode === m ? "on" : ""} onClick={() => setMode(m)}>
                {m}
              </button>
            ))}
          </nav>
        )}
      </header>
      {mode === null && (
        <main className="mode-select">
          <h2>Choose a mode</h2>
          <div className="mode-cards">
            <button type="button" className="mode-card" onClick={() => setMode("SOLO")}>
              <strong>SOLO</strong>
              <span>Race 500m against your best ghost. Control power with your index finger on camera, or a slider.</span>
            </button>
            <button type="button" className="mode-card" onClick={() => setMode("ONLINE")}>
              <strong>ONLINE</strong>
              <span>Create a room, share the code, and race 2 to 7 friends live.</span>
            </button>
          </div>
        </main>
      )}
      {mode === "SOLO" && <SoloGame drawing={drawing} />}
      {mode === "ONLINE" && <OnlineGame initialCode={linkCode ?? ""} drawing={drawing} />}
    </div>
  );
}
