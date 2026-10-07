import { Component, Suspense, useEffect, useRef, type ReactNode } from "react";
import { AnimatedRunner } from "./AnimatedRunner";
import { NameTag } from "./NameTag";
import { ProceduralRunner } from "./ProceduralRunner";
import type { RunnerVisualProps } from "./runnerTypes";

export type RunnerStatus =
  | { kind: "loading" }
  | { kind: "ready" }
  | { kind: "fallback"; reason: string };

interface BoundaryProps {
  fallback: ReactNode;
  onError?: (reason: string) => void;
  children: ReactNode;
}

/** Catches GLB load failures and missing clips; renders the procedural runner instead. */
class RunnerBoundary extends Component<BoundaryProps, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    const reason = error instanceof Error ? error.message : String(error);
    this.props.onError?.(reason || "Runner model failed to load");
  }

  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

/** Calls `onMount` once when mounted, ignoring later prop identity changes. */
function OnMount({ onMount }: { onMount: () => void }) {
  const latest = useRef(onMount);
  latest.current = onMount;
  useEffect(() => latest.current(), []);
  return null;
}

interface RunnerSlotProps extends RunnerVisualProps {
  laneZ: number;
  label?: string;
  /** Highlight ring and filled name tag for the local player in online races. */
  isLocal?: boolean;
  onStatus?: (status: RunnerStatus) => void;
}

/** Outer group owns world position; GLB runner with procedural fallback inside. */
export function RunnerSlot({ laneZ, label, isLocal, onStatus, ...visual }: RunnerSlotProps) {
  const procedural = <ProceduralRunner {...visual} />;
  const color = visual.tint ?? "#ffffff";
  return (
    <group position={[visual.distanceM, 0, laneZ]}>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.012, 0]}>
        <circleGeometry args={[0.45, 24]} />
        <meshBasicMaterial color="#000000" transparent opacity={visual.ghost ? 0.15 : 0.4} depthWrite={false} />
      </mesh>
      {isLocal && (
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.015, 0]}>
          <ringGeometry args={[0.5, 0.62, 32]} />
          <meshBasicMaterial color={color} transparent opacity={0.9} depthWrite={false} />
        </mesh>
      )}
      {label && <NameTag text={label} color={color} highlight={isLocal} />}
      <RunnerBoundary
        fallback={procedural}
        onError={(reason) => onStatus?.({ kind: "fallback", reason })}
      >
        <Suspense
          fallback={
            <>
              {procedural}
              <OnMount onMount={() => onStatus?.({ kind: "loading" })} />
            </>
          }
        >
          <AnimatedRunner {...visual} />
          <OnMount onMount={() => onStatus?.({ kind: "ready" })} />
        </Suspense>
      </RunnerBoundary>
    </group>
  );
}
