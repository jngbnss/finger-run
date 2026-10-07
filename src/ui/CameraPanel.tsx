import { useEffect, useRef } from "react";
import type { HandPowerController, HandView } from "../input/hand/handPowerController";

const STATUS_TEXT: Record<HandView["status"], string> = {
  OFF: "Camera off",
  STARTING: "Opening camera…",
  LOADING_MODEL: "Loading hand model…",
  CALIBRATING: "Calibrating",
  RUNNING: "Tracking",
  PAUSED: "Paused (page was hidden)",
  ERROR: "Camera error",
};

interface CameraPanelProps {
  view: HandView;
  controller: HandPowerController;
  onUseSlider: () => void;
}

export function CameraPanel({ view, controller, onUseSlider }: CameraPanelProps) {
  const video = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const el = video.current;
    if (!el) return;
    el.srcObject = view.stream;
    if (view.stream) void el.play().catch(() => {});
  }, [view.stream]);

  const active = view.status === "RUNNING" || view.status === "CALIBRATING";
  const busy = view.status === "STARTING" || view.status === "LOADING_MODEL";
  const { reading } = view;

  let calibrationText = view.calibration.usedDefaults ? "Default range" : "Calibrated";
  if (view.status === "CALIBRATING") {
    calibrationText =
      view.calibrationPhase === "SHAKE" ? "Now wiggle your index finger as fast as you can!" : "Hold your hand still and relaxed…";
  }

  return (
    <div className="camera-panel">
      <div className="camera-preview" aria-hidden={!view.stream}>
        {/* Mirrored for display only; landmark math uses the unmirrored frame. */}
        <div className="mirror">
          <video ref={video} muted playsInline autoPlay aria-label="Camera preview (mirrored)" />
          {reading.tip && (
            <span className="tip-dot" style={{ left: `${reading.tip.x * 100}%`, top: `${reading.tip.y * 100}%` }} />
          )}
        </div>
        {!view.stream && <span className="preview-empty">{STATUS_TEXT[view.status]}</span>}
      </div>

      <dl className="camera-stats" aria-live="polite">
        <div>
          <dt>Status</dt>
          <dd data-testid="camera-status">{STATUS_TEXT[view.status]}</dd>
        </div>
        <div>
          <dt>Hand</dt>
          <dd>{active ? (reading.handVisible ? "Detected" : "Not visible") : "—"}</dd>
        </div>
        <div>
          <dt>Finger speed</dt>
          <dd>{reading.rawSpeed.toFixed(1)}</dd>
        </div>
        <div>
          <dt>Camera power</dt>
          <dd data-testid="camera-power">{Math.round(controller.power())}</dd>
        </div>
        <div className="wide">
          <dt>Calibration</dt>
          <dd>{calibrationText}</dd>
        </div>
      </dl>

      {view.handLost && (
        <p className="warn" role="status">
          HAND_NOT_VISIBLE: Show one hand to the camera with the index finger visible.
        </p>
      )}

      {view.error && (
        <div className="error-box" role="alert">
          <strong>{view.error.code}</strong>
          <p>{view.error.message}</p>
        </div>
      )}

      <div className="buttons">
        {!active ? (
          <button type="button" className="primary" onClick={() => void controller.enable()} disabled={busy}>
            {view.status === "ERROR" || view.status === "PAUSED" ? "RETRY CAMERA" : "ENABLE CAMERA"}
          </button>
        ) : (
          <button type="button" onClick={() => controller.stop()}>
            STOP CAMERA
          </button>
        )}
        {active ? (
          <button type="button" onClick={() => controller.recalibrate()} disabled={view.status === "CALIBRATING"}>
            RECALIBRATE
          </button>
        ) : (
          <button type="button" onClick={onUseSlider}>
            USE SLIDER
          </button>
        )}
      </div>
      <p className="hint privacy">
        Video and hand points stay on this device. Nothing from the camera is uploaded or saved. (The hand model itself is
        downloaded from Google's CDN.)
      </p>
    </div>
  );
}
