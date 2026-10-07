import { useCallback, useState, type ReactNode } from "react";
import { SceneBoundary, hasWebGL } from "../scene/SceneBoundary";

interface GameViewportProps {
  /** Renders the <Canvas>; receives the context-lost handler. */
  scene: (onContextLost: () => void) => ReactNode;
  /** Overlays drawn above the canvas (countdown, results, banners). */
  children?: ReactNode;
}

/**
 * Checks WebGL before mounting the canvas, catches scene errors, and handles
 * context loss. HUD and controls live outside this component and keep working.
 */
export function GameViewport({ scene, children }: GameViewportProps) {
  const [webgl] = useState(hasWebGL);
  const [sceneError, setSceneError] = useState<string | null>(null);
  const [sceneKey, setSceneKey] = useState(0);
  const onContextLost = useCallback(
    () => setSceneError("The WebGL context was lost (GPU reset or too many 3D tabs)."),
    [],
  );

  let content: ReactNode;
  if (!webgl) {
    content = (
      <div className="scene-error" role="alert">
        <h2>WebGL is not available</h2>
        <p>This browser or device cannot render 3D. The race still runs: follow it in the panel.</p>
      </div>
    );
  } else if (sceneError) {
    content = (
      <div className="scene-error" role="alert">
        <h2>3D view stopped</h2>
        <p>{sceneError}</p>
        <p>The race keeps running in the panel.</p>
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
    content = (
      <SceneBoundary key={sceneKey} onError={setSceneError}>
        {scene(onContextLost)}
      </SceneBoundary>
    );
  }

  return (
    <div className="viewport">
      {content}
      {children}
    </div>
  );
}

export function useWebGLAvailable() {
  const [webgl] = useState(hasWebGL);
  return webgl;
}
