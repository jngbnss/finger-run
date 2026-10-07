import { useEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import {
  CanvasTexture,
  NearestFilter,
  RepeatWrapping,
  SRGBColorSpace,
  MeshBasicMaterial,
  type Group,
} from "three";
import { MAX_SPEED_MPS } from "../game/powerCurve";
import { RACE_DISTANCE_M } from "../game/raceEngine";

const TRACK_HALF_WIDTH = 2.5;
const LANE_LINES_Z = [-2, 0, 2];
const MARKERS_M = [10, 20, 30, 40, 50, 60, 70, 80, 90];

function labelTexture(text: string): CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = 128;
  canvas.height = 64;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#ffe14d";
  ctx.font = "bold 40px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, 64, 34);
  const t = new CanvasTexture(canvas);
  t.colorSpace = SRGBColorSpace;
  return t;
}

function checkerTexture(): CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = 2;
  canvas.height = 2;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, 2, 2);
  ctx.fillStyle = "#111111";
  ctx.fillRect(0, 0, 1, 1);
  ctx.fillRect(1, 1, 1, 1);
  const t = new CanvasTexture(canvas);
  t.magFilter = NearestFilter;
  t.minFilter = NearestFilter;
  t.wrapS = t.wrapT = RepeatWrapping;
  t.repeat.set(2, 10);
  t.colorSpace = SRGBColorSpace;
  return t;
}

export function Track() {
  const labels = useMemo(() => MARKERS_M.map((m) => labelTexture(`${m}m`)), []);
  const checker = useMemo(checkerTexture, []);
  useEffect(
    () => () => {
      labels.forEach((t) => t.dispose());
      checker.dispose();
    },
    [labels, checker],
  );

  const length = RACE_DISTANCE_M + 40;
  const centerX = RACE_DISTANCE_M / 2 + 5;

  return (
    <group>
      {/* infield */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[centerX, -0.01, 0]}>
        <planeGeometry args={[length + 200, 200]} />
        <meshStandardMaterial color="#0d1118" roughness={1} />
      </mesh>
      {/* track surface */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[centerX, 0, 0]}>
        <planeGeometry args={[length, TRACK_HALF_WIDTH * 2]} />
        <meshStandardMaterial color="#2a1f2e" roughness={0.9} />
      </mesh>
      {/* lane lines */}
      {LANE_LINES_Z.map((z) => (
        <mesh key={z} rotation={[-Math.PI / 2, 0, 0]} position={[centerX, 0.005, z]}>
          <planeGeometry args={[length, 0.06]} />
          <meshBasicMaterial color="#e8f0ff" />
        </mesh>
      ))}
      {/* start line */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.006, 0]}>
        <planeGeometry args={[0.2, TRACK_HALF_WIDTH * 2]} />
        <meshBasicMaterial color="#39ff88" />
      </mesh>
      {/* finish line */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[RACE_DISTANCE_M, 0.006, 0]}>
        <planeGeometry args={[1, TRACK_HALF_WIDTH * 2]} />
        <meshBasicMaterial map={checker} />
      </mesh>
      {/* start posts */}
      {[-2.75, 2.75].map((z) => (
        <mesh key={z} position={[0, 0.6, z]}>
          <boxGeometry args={[0.15, 1.2, 0.15]} />
          <meshStandardMaterial color="#39ff88" emissive="#39ff88" emissiveIntensity={0.6} />
        </mesh>
      ))}
      {/* distance markers */}
      {MARKERS_M.map((m, i) => (
        <group key={m} position={[m, 0, 0]}>
          <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.004, 0]}>
            <planeGeometry args={[0.05, TRACK_HALF_WIDTH * 2]} />
            <meshBasicMaterial color="#e8f0ff" transparent opacity={0.25} />
          </mesh>
          <mesh position={[0, 0.35, -3.1]}>
            <boxGeometry args={[0.12, 0.7, 0.12]} />
            <meshStandardMaterial color="#ffe14d" emissive="#ffe14d" emissiveIntensity={0.5} />
          </mesh>
          <sprite position={[0, 1.05, -3.1]} scale={[1.2, 0.6, 1]}>
            <spriteMaterial map={labels[i]} transparent />
          </sprite>
        </group>
      ))}
    </group>
  );
}

const SPEED_LINE_COUNT = 28;
const SPEED_LINE_SPAN = 24;

/** Streaks that rush past the player; visible only at high speed. */
export function SpeedLines({ distanceM, speedMps }: { distanceM: number; speedMps: number }) {
  const group = useRef<Group>(null);
  const material = useMemo(
    () => new MeshBasicMaterial({ color: "#ffffff", transparent: true, opacity: 0, depthWrite: false }),
    [],
  );
  useEffect(() => () => material.dispose(), [material]);
  const offset = useRef(0);
  const seeds = useMemo(
    () =>
      Array.from({ length: SPEED_LINE_COUNT }, (_, i) => {
        const r = (n: number) => {
          const v = Math.sin((i + 1) * 12.9898 + n * 78.233) * 43758.5453;
          return v - Math.floor(v);
        };
        return { x: r(1) * SPEED_LINE_SPAN, y: 0.2 + r(2) * 2.6, z: -3.2 + r(3) * 6.4 };
      }),
    [],
  );

  useFrame((_, delta) => {
    const intensity = Math.min(1, Math.max(0, (speedMps / MAX_SPEED_MPS - 0.45) / 0.55));
    if (!group.current) return;
    group.current.visible = intensity > 0;
    material.opacity = intensity * 0.45;
    offset.current += Math.min(delta, 0.05) * speedMps * 1.5;
    group.current.children.forEach((child, i) => {
      const seed = seeds[i];
      const along = (seed.x + offset.current) % SPEED_LINE_SPAN;
      child.position.set(distanceM + 14 - along, seed.y, seed.z);
    });
  });

  return (
    <group ref={group} visible={false}>
      {seeds.map((_, i) => (
        <mesh key={i} material={material}>
          <boxGeometry args={[1.6, 0.02, 0.02]} />
        </mesh>
      ))}
    </group>
  );
}
