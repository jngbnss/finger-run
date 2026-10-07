import { Canvas, useFrame } from "@react-three/fiber";
import { FinishFlag } from "./FinishFlag";
import { RunnerSlot, type RunnerStatus } from "./RunnerSlot";
import { SpeedLines, Track, laneZ, trackHalfWidth } from "./Track";

export interface SceneRunner {
  id: string;
  lane: number;
  distanceM: number;
  speedMps: number;
  smoothedPower: number;
  animationScale: number;
  running: boolean;
  tint?: string;
  label?: string;
  isLocal?: boolean;
  ghost?: boolean;
}

interface RaceSceneProps {
  laneCount: number;
  laneWidth: number;
  runners: SceneRunner[];
  /** The camera follows this distance (the local player). */
  focusDistanceM: number;
  /** Local player's speed, for speed lines. */
  focusSpeedMps: number;
  drawingUrl: string | null;
  reducedMotion?: boolean;
  /** Receives load status of the local (non-ghost) runner model. */
  onRunnerStatus: (status: RunnerStatus) => void;
  onContextLost: () => void;
}

/** Chase camera behind and beside the player; pulls back for wider tracks. */
function CameraRig({ distanceM, halfWidth }: { distanceM: number; halfWidth: number }) {
  useFrame(({ camera }) => {
    const extra = halfWidth - 2.5;
    camera.position.set(distanceM - 7 - extra * 0.4, 3.4 + extra * 0.55, -(halfWidth + 3));
    camera.lookAt(distanceM + 6, 0.9, 0);
  });
  return null;
}

export function RaceScene({
  laneCount,
  laneWidth,
  runners,
  focusDistanceM,
  focusSpeedMps,
  drawingUrl,
  reducedMotion,
  onRunnerStatus,
  onContextLost,
}: RaceSceneProps) {
  const halfWidth = trackHalfWidth(laneCount, laneWidth);
  return (
    <Canvas
      dpr={[1, 2]}
      camera={{ fov: 55, near: 0.1, far: 400, position: [-7, 3.4, -(halfWidth + 3)] }}
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

      <CameraRig distanceM={focusDistanceM} halfWidth={halfWidth} />
      <Track laneCount={laneCount} laneWidth={laneWidth} />
      <FinishFlag drawingUrl={drawingUrl} halfWidth={halfWidth} />
      {!reducedMotion && <SpeedLines distanceM={focusDistanceM} speedMps={focusSpeedMps} halfWidth={halfWidth} />}

      {runners.map((r) => (
        <RunnerSlot
          key={r.id}
          laneZ={laneZ(r.lane, laneCount, laneWidth)}
          distanceM={r.distanceM}
          speedMps={r.speedMps}
          smoothedPower={r.smoothedPower}
          animationScale={r.animationScale}
          running={r.running}
          ghost={r.ghost}
          tint={r.tint}
          label={r.label}
          isLocal={r.isLocal}
          onStatus={r.ghost || (r.isLocal === false) ? undefined : onRunnerStatus}
        />
      ))}
    </Canvas>
  );
}
