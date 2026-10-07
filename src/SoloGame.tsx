import { useCallback, useEffect, useRef, useState } from "react";
import { clearStoredBest, completedRun, loadBest, saveBestIfBetter } from "./game/ghost";
import { TIMEOUT_S, createRace, overlayLabel, resetRace, setTargetPower, startRace, stepRace } from "./game/raceEngine";
import type { RaceSnapshot, StoredBest } from "./game/types";
import { useInputPower } from "./input/useInputPower";
import { ghostRunner } from "./scene/GhostRunner";
import { RaceScene, type SceneRunner } from "./scene/RaceScene";
import type { RunnerStatus } from "./scene/RunnerSlot";
import { PLAYER_COLOR } from "./scene/runnerTypes";
import type { DrawingState } from "./skin/useDrawing";
import { DrawingUpload } from "./ui/DrawingUpload";
import { GameViewport, useWebGLAvailable } from "./ui/GameViewport";
import { Hud, formatTime } from "./ui/Hud";
import { InputPanel } from "./ui/InputPanel";
import { PowerControl } from "./ui/PowerControl";
import { useReducedMotion } from "./ui/useReducedMotion";

function safeLocalStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

const storage = safeLocalStorage();

export function SoloGame({ drawing }: { drawing: DrawingState }) {
  const drawingUrl = drawing.url;
  const [initialLoad] = useState(() => loadBest(storage));
  const [race, setRace] = useState<RaceSnapshot>(() => createRace());
  const raceRef = useRef(race);
  const [best, setBest] = useState<StoredBest | null>(initialLoad.best);
  const bestRef = useRef(best);
  const [lastImproved, setLastImproved] = useState(false);
  const [notice, setNotice] = useState<string | null>(
    initialLoad.corrupt ? "Saved best run was unreadable and has been ignored." : null,
  );
  const [runnerStatus, setRunnerStatus] = useState<RunnerStatus>({ kind: "loading" });
  const input = useInputPower();
  const sourceRef = useRef(input.source);
  sourceRef.current = input.source;
  const webgl = useWebGLAvailable();
  const reducedMotion = useReducedMotion();

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

  // Simulation loop outside the Canvas so the HUD keeps running if WebGL fails.
  useEffect(() => {
    let frame = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = (now - last) / 1000;
      last = now;
      const power = Math.round(sourceRef.current.read() * 10) / 10;
      apply((state) => stepRace(setTargetPower(state, power), dt));
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [apply]);

  const handleClearBest = useCallback(() => {
    clearStoredBest(storage);
    bestRef.current = null;
    setBest(null);
    setLastImproved(false);
    setNotice(null);
  }, []);

  const label = overlayLabel(race);
  let result: string | null = null;
  if (race.phase === "FINISHED" && race.finishTimeMs !== null) {
    result = `FINISH! ${formatTime(race.finishTimeMs)}${lastImproved ? " — NEW BEST" : ""}`;
  } else if (race.phase === "DNF") {
    result = `DNF — ${TIMEOUT_S} second limit reached. Run not saved.`;
  }

  const raceStarted = race.phase !== "IDLE" && race.phase !== "COUNTDOWN";
  const runners: SceneRunner[] = [
    {
      id: "player",
      lane: 1,
      distanceM: race.distanceM,
      speedMps: race.speedMps,
      smoothedPower: race.smoothedPower,
      animationScale: race.animationScale,
      running: race.phase === "RUNNING",
      tint: PLAYER_COLOR,
      skinUrl: drawing.skinOn ? drawing.skin?.url : null,
    },
  ];
  if (best) runners.push(ghostRunner(best, raceStarted ? race.elapsedS * 1000 : 0, race.phase === "RUNNING"));

  return (
    <main>
      <GameViewport
        scene={(onContextLost) => (
          <RaceScene
            laneCount={2}
            laneWidth={2}
            runners={runners}
            focusDistanceM={race.distanceM}
            focusSpeedMps={race.phase === "RUNNING" ? race.speedMps : 0}
            drawingUrl={drawingUrl}
            reducedMotion={reducedMotion}
            onRunnerStatus={setRunnerStatus}
            onContextLost={onContextLost}
          />
        )}
      >
        {label && (
          <div key={label} className={`overlay-label${label === "GO!" ? " go" : ""}`} aria-hidden>
            {label}
          </div>
        )}
        <p className="sr-only" aria-live="assertive">
          {label ?? ""}
        </p>
        {result && (
          <div className={`result ${race.phase === "DNF" ? "dnf" : ""}`} role="status">
            {result}
            <span>Press RESET to race again{best ? " against your ghost" : ""}.</span>
          </div>
        )}
        <div className="toasts">
          {runnerStatus.kind === "loading" && webgl && <div className="toast">Loading runner model…</div>}
          {runnerStatus.kind === "fallback" && (
            <div className="toast warn">Using procedural runner: {runnerStatus.reason}</div>
          )}
          {notice && <div className="toast warn">{notice}</div>}
        </div>
      </GameViewport>
      <aside>
        <Hud race={race} />
        <PowerControl
          race={race}
          best={best}
          onStart={() => apply(startRace)}
          onReset={() => apply(resetRace)}
          onClearBest={handleClearBest}
        />
        <InputPanel
          mode={input.mode}
          onMode={input.setMode}
          hand={input.hand}
          slider={input.slider}
          onSlider={input.setSlider}
        />
        <DrawingUpload
          drawingUrl={drawingUrl}
          onDrawing={drawing.setUrl}
          skinOn={drawing.skinOn}
          onSkinOn={drawing.setSkinOn}
          skinLabel="Wear it on my runner (stays on this device)"
        />
      </aside>
    </main>
  );
}
