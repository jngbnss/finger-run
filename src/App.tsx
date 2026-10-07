import { useCallback, useEffect, useRef, useState } from "react";
import {
  clearStoredBest,
  completedRun,
  loadBest,
  saveBestIfBetter,
} from "./game/ghost";
import {
  createRace,
  overlayLabel,
  resetRace,
  setTargetPower,
  startRace,
  stepRace,
} from "./game/raceEngine";
import type { RaceSnapshot, StoredBest } from "./game/types";
import { RaceScene } from "./scene/RaceScene";
import type { RunnerStatus } from "./scene/RunnerSlot";
import { SceneBoundary, hasWebGL } from "./scene/SceneBoundary";
import { DrawingUpload } from "./ui/DrawingUpload";
import { Hud, formatTime } from "./ui/Hud";
import { PowerControl } from "./ui/PowerControl";

function safeLocalStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

const storage = safeLocalStorage();
const initialLoad = loadBest(storage);

export function App() {
  const [race, setRace] = useState<RaceSnapshot>(() => createRace());
  const raceRef = useRef(race);
  const [best, setBest] = useState<StoredBest | null>(initialLoad.best);
  const bestRef = useRef(best);
  const [lastImproved, setLastImproved] = useState(false);
  const [notice, setNotice] = useState<string | null>(
    initialLoad.corrupt ? "Saved best run was unreadable and has been ignored." : null,
  );
  const [webgl] = useState(hasWebGL);
  const [sceneError, setSceneError] = useState<string | null>(null);
  const [sceneKey, setSceneKey] = useState(0);
  const [runnerStatus, setRunnerStatus] = useState<RunnerStatus>({ kind: "loading" });
  const [drawingUrl, setDrawingUrl] = useState<string | null>(null);
  const drawingRef = useRef<string | null>(null);

  const apply = useCallback((update: (state: RaceSnapshot) => RaceSnapshot) => {
    const prev = raceRef.current;
    const next = update(prev);
    if (next === prev) return;
    raceRef.current = next;
    setRace(next);
    if (prev.phase === "RUNNING" && next.phase === "FINISHED") {
      const result = saveBestIfBetter(storage, bestRef.current, completedRun(next));
      bestRef.current = result.best;
      setBest(result.best);
      setLastImproved(result.improved);
    }
  }, []);

  // Simulation loop lives outside the Canvas so HUD keeps running if WebGL fails.
  useEffect(() => {
    let frame = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = (now - last) / 1000;
      last = now;
      apply((state) => stepRace(state, dt));
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [apply]);

  useEffect(
    () => () => {
      if (drawingRef.current) URL.revokeObjectURL(drawingRef.current);
    },
    [],
  );

  const handleDrawing = useCallback((url: string) => {
    if (drawingRef.current) URL.revokeObjectURL(drawingRef.current);
    drawingRef.current = url;
    setDrawingUrl(url);
  }, []);

  const handleClearBest = useCallback(() => {
    clearStoredBest(storage);
    bestRef.current = null;
    setBest(null);
    setLastImproved(false);
    setNotice(null);
  }, []);

  const handleContextLost = useCallback(() => {
    setSceneError("The WebGL context was lost (GPU reset or too many 3D tabs).");
  }, []);

  const label = overlayLabel(race);

  let result: string | null = null;
  if (race.phase === "FINISHED" && race.finishTimeMs !== null) {
    result = `FINISH! ${formatTime(race.finishTimeMs)}${lastImproved ? " — NEW BEST" : ""}`;
  } else if (race.phase === "DNF") {
    result = "DNF — 60 second limit reached. Run not saved.";
  }

  let viewport;
  if (!webgl) {
    viewport = (
      <div className="scene-error">
        <h2>WebGL is not available</h2>
        <p>This browser or device cannot render 3D. The race still runs: use the HUD on the right.</p>
      </div>
    );
  } else if (sceneError) {
    viewport = (
      <div className="scene-error">
        <h2>3D view stopped</h2>
        <p>{sceneError}</p>
        <p>The race keeps running in the HUD.</p>
        <button
          type="button"
          onClick={() => {
            setSceneError(null);
            setSceneKey((k) => k + 1);
          }}
        >
          Retry 3D view
        </button>
      </div>
    );
  } else {
    viewport = (
      <SceneBoundary key={sceneKey} onError={setSceneError}>
        <RaceScene
          race={race}
          best={best}
          drawingUrl={drawingUrl}
          onRunnerStatus={setRunnerStatus}
          onContextLost={handleContextLost}
        />
      </SceneBoundary>
    );
  }

  return (
    <div className="app">
      <header>
        <h1>FINGER RUN 3D</h1>
        <p className="subtitle">POWER CONTROL PROTOTYPE</p>
      </header>
      <main>
        <div className="viewport">
          {viewport}
          {label && (
            <div key={label} className={`overlay-label${label === "GO!" ? " go" : ""}`}>
              {label}
            </div>
          )}
          {result && (
            <div className={`result ${race.phase === "DNF" ? "dnf" : ""}`}>
              {result}
              <span>Press RESET to race again{best ? " against your ghost" : ""}.</span>
            </div>
          )}
          <div className="toasts">
            {runnerStatus.kind === "loading" && webgl && !sceneError && (
              <div className="toast">Loading runner model…</div>
            )}
            {runnerStatus.kind === "fallback" && (
              <div className="toast warn">
                Using procedural runner: {runnerStatus.reason}
              </div>
            )}
            {notice && <div className="toast warn">{notice}</div>}
          </div>
        </div>
        <aside>
          <Hud race={race} />
          <PowerControl
            race={race}
            best={best}
            onPower={(p) => apply((s) => setTargetPower(s, p))}
            onStart={() => apply(startRace)}
            onReset={() => apply(resetRace)}
            onClearBest={handleClearBest}
          />
          <DrawingUpload drawingUrl={drawingUrl} onDrawing={handleDrawing} />
        </aside>
      </main>
    </div>
  );
}
