import { Canvas, useFrame } from "@react-three/fiber";
import type { RaceSnapshot, StoredBest } from "../game/types";
import { FinishFlag } from "./FinishFlag";
import { GhostRunner } from "./GhostRunner";
import { RunnerSlot, type RunnerStatus } from "./RunnerSlot";
import { PLAYER_LANE_Z } from "./runnerTypes";
import { SpeedLines, Track } from "./Track";

interface RaceSceneProps {
  race: RaceSnapshot;
  best: StoredBest | null;
  drawingUrl: string | null;
  onRunnerStatus: (status: RunnerStatus) => void;
  onContextLost: () => void;
}

/** Chase camera behind and beside the player. */
function CameraRig({ distanceM }: { distanceM: number }) {
  useFrame(({ camera }) => {
    camera.position.set(distanceM - 7, 3.4, -5.5);
    camera.lookAt(distanceM + 6, 0.9, 0);
  });
  return null;
}

export function RaceScene({ race, best, drawingUrl, onRunnerStatus, onContextLost }: RaceSceneProps) {
  const raceStarted = race.phase !== "IDLE" && race.phase !== "COUNTDOWN";
  return (
    <Canvas
      dpr={[1, 2]}
      camera={{ fov: 55, near: 0.1, far: 400, position: [-7, 3.4, -5.5] }}
      onCreated={({ gl }) => {
        gl.domElement.addEventListener("webglcontextlost", (event) => {
          event.preventDefault();
          onContextLost();
        });
      }}
    >
      <color attach="background" args={["#0b0e14"]} />
      <fog attach="fog" args={["#0b0e14", 30, 90]} />
      <ambientLight intensity={0.7} />
      <hemisphereLight args={["#9fb4ff", "#1a1020", 0.6]} />
      <directionalLight position={[20, 30, -15]} intensity={1.6} />

      <CameraRig distanceM={race.distanceM} />
      <Track />
      <FinishFlag drawingUrl={drawingUrl} />
      <SpeedLines distanceM={race.distanceM} speedMps={race.phase === "RUNNING" ? race.speedMps : 0} />

      <RunnerSlot
        laneZ={PLAYER_LANE_Z}
        distanceM={race.distanceM}
        speedMps={race.speedMps}
        smoothedPower={race.smoothedPower}
        animationScale={race.animationScale}
        running={race.phase === "RUNNING"}
        onStatus={onRunnerStatus}
      />
      {best && (
        <GhostRunner
          best={best}
          elapsedMs={raceStarted ? race.elapsedS * 1000 : 0}
          racing={race.phase === "RUNNING"}
        />
      )}
    </Canvas>
  );
}
