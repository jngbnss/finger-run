import type { ErrorCode } from "../../multiplayer/protocol";
import {
  CalibrationSession,
  DEFAULT_CALIBRATION,
  FingerPowerSignal,
  HAND_LOSS_DECAY_MS,
  type Calibration,
  type SignalReading,
} from "./fingerSignal";
import { isModelLoadError, type HandTrackingSource, type InferenceMode } from "./handTracking";

export type CameraStatus = "OFF" | "STARTING" | "LOADING_MODEL" | "CALIBRATING" | "RUNNING" | "PAUSED" | "ERROR";

export interface CameraError {
  code: ErrorCode;
  message: string;
}

export interface HandView {
  status: CameraStatus;
  error: CameraError | null;
  stream: MediaStream | null;
  mode: InferenceMode | null;
  reading: SignalReading;
  calibrationPhase: "REST" | "SHAKE" | null;
  calibration: Calibration;
  /** Hand missing for over a second while running. */
  handLost: boolean;
}

const CALIBRATION_KEY = "finger-run.calibration.v1";
const UI_INTERVAL_MS = 1000 / 15;
const HAND_LOST_NOTICE_MS = 1000;

const EMPTY_READING: SignalReading = { power: 0, rawSpeed: 0, smoothedSpeed: 0, handVisible: false, tip: null };

function loadCalibration(): Calibration | null {
  try {
    const raw = JSON.parse(localStorage.getItem(CALIBRATION_KEY) ?? "null");
    if (raw && Number.isFinite(raw.deadZone) && Number.isFinite(raw.maxSpeed) && raw.maxSpeed > raw.deadZone) {
      return { deadZone: raw.deadZone, maxSpeed: raw.maxSpeed, usedDefaults: Boolean(raw.usedDefaults) };
    }
  } catch {
    // Unavailable or corrupt: calibrate again.
  }
  return null;
}

function saveCalibration(cal: Calibration) {
  try {
    localStorage.setItem(CALIBRATION_KEY, JSON.stringify(cal));
  } catch {
    // Not persisted; calibration stays for this session.
  }
}

export function describeCameraError(error: unknown): CameraError {
  if (isModelLoadError(error)) {
    return {
      code: "HAND_MODEL_LOAD_FAILED",
      message: "The hand-tracking model could not be loaded. Check your connection and retry, or use the slider.",
    };
  }
  const name = error instanceof DOMException || error instanceof Error ? error.name : "";
  switch (name) {
    case "NotAllowedError":
    case "PermissionDeniedError":
    case "SecurityError":
      return {
        code: "CAMERA_PERMISSION_DENIED",
        message: "Camera permission was denied. Allow camera access in the browser's site settings and retry, or use the slider.",
      };
    case "NotFoundError":
    case "NotSupportedError":
    case "DevicesNotFoundError":
    case "OverconstrainedError":
      return { code: "CAMERA_NOT_FOUND", message: "No camera was found on this device. Use the slider instead." };
    case "NotReadableError":
    case "TrackStartError":
    case "AbortError":
      return {
        code: "CAMERA_NOT_FOUND",
        message: "The camera is busy or unavailable. Close other apps using it and retry, or use the slider.",
      };
    default:
      return {
        code: "CAMERA_NOT_FOUND",
        message: `The camera could not start (${error instanceof Error ? error.message : String(error)}).`,
      };
  }
}

/**
 * Camera lifecycle + inference loop + power signal. Framework free.
 * Camera is opened only from enable(), which must follow a user click.
 */
export class HandPowerController {
  private status: CameraStatus = "OFF";
  private error: CameraError | null = null;
  private stream: MediaStream | null = null;
  private mode: InferenceMode | null = null;
  private signal: FingerPowerSignal;
  private reading: SignalReading = EMPTY_READING;
  private calibrator: CalibrationSession | null = null;
  private calibrationPhase: "REST" | "SHAKE" | null = null;
  private generation = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastUiAt = 0;
  private lastHandAt = 0;
  private stoppedAt: number | null = null;
  private powerAtStop = 0;
  private listeners = new Set<(view: HandView) => void>();
  private view: HandView;

  constructor(
    private readonly createSource: () => HandTrackingSource,
    private readonly now: () => number = () => performance.now(),
  ) {
    this.signal = new FingerPowerSignal(loadCalibration() ?? DEFAULT_CALIBRATION);
    this.view = this.buildView();
  }

  private source: HandTrackingSource | null = null;

  getView(): HandView {
    return this.view;
  }

  subscribe(listener: (view: HandView) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Current power 0..100. Decays to 0 over 500ms after the camera stops or fails. */
  power(): number {
    if (this.status === "RUNNING") return this.reading.power;
    if (this.stoppedAt === null) return 0;
    const k = Math.max(0, 1 - (this.now() - this.stoppedAt) / HAND_LOSS_DECAY_MS);
    return this.powerAtStop * k;
  }

  get running() {
    return this.status === "RUNNING";
  }

  async enable(options: { recalibrate?: boolean } = {}) {
    if (this.status === "STARTING" || this.status === "LOADING_MODEL") return;
    this.halt();
    const generation = ++this.generation;
    this.error = null;

    if (typeof window !== "undefined" && !window.isSecureContext) {
      this.fail({
        code: "CAMERA_INSECURE_CONTEXT",
        message: `Camera needs HTTPS or localhost. This page is served over ${location.protocol}. Open the https:// GitHub Pages link or run the dev server on localhost.`,
      });
      return;
    }

    const source = this.createSource();
    this.source = source;
    this.setStatus("STARTING");
    try {
      this.stream = await source.start(() => {
        if (generation === this.generation) {
          this.fail({ code: "CAMERA_STREAM_ENDED", message: "The camera stream stopped (unplugged or taken by another app). Retry or use the slider." });
        }
      });
      if (generation !== this.generation) return source.stop();
      this.setStatus("LOADING_MODEL");
      this.mode = await source.loadModel();
      if (generation !== this.generation) return source.stop();
    } catch (error) {
      if (generation !== this.generation) return;
      this.fail(describeCameraError(error));
      return;
    }

    this.signal.reset();
    this.lastHandAt = this.now();
    if (options.recalibrate || loadCalibration() === null) {
      this.calibrator = new CalibrationSession();
      this.setStatus("CALIBRATING");
    } else {
      this.setStatus("RUNNING");
    }
    this.loop(generation);
  }

  recalibrate() {
    if (this.status !== "RUNNING" && this.status !== "CALIBRATING") return;
    this.calibrator = new CalibrationSession();
    this.setStatus("CALIBRATING");
  }

  /** Stops camera and inference. `paused` marks a page-hide stop that needs an explicit restart. */
  stop(paused = false) {
    this.halt();
    this.generation++;
    this.setStatus(paused ? "PAUSED" : "OFF");
  }

  dispose() {
    this.stop();
    this.listeners.clear();
  }

  private halt() {
    if (this.status === "RUNNING") {
      this.stoppedAt = this.now();
      this.powerAtStop = this.reading.power;
    }
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.source?.stop();
    this.source = null;
    this.stream = null;
    this.calibrator = null;
    this.calibrationPhase = null;
    this.reading = EMPTY_READING;
  }

  private fail(error: CameraError) {
    this.halt();
    this.generation++;
    this.error = error;
    this.setStatus("ERROR");
  }

  private loop(generation: number) {
    const source = this.source;
    if (!source) return;
    const frameMs = 1000 / source.fps;
    const step = async () => {
      if (generation !== this.generation) return;
      const started = this.now();
      let landmarks = null;
      try {
        landmarks = await source.detect(started);
      } catch {
        landmarks = null;
      }
      if (generation !== this.generation) return;
      const t = this.now();
      this.reading = this.signal.update(landmarks, t);
      if (this.reading.handVisible) this.lastHandAt = t;

      if (this.status === "CALIBRATING" && this.calibrator) {
        const phase = this.calibrator.add(this.reading.rawSpeed, t);
        if (phase === "DONE") {
          const cal = this.calibrator.result();
          this.signal.setCalibration(cal);
          saveCalibration(cal);
          this.calibrator = null;
          this.calibrationPhase = null;
          this.setStatus("RUNNING");
        } else {
          this.calibrationPhase = phase;
        }
      }
      if (this.status === "CALIBRATING") this.reading = { ...this.reading, power: 0 };

      if (t - this.lastUiAt >= UI_INTERVAL_MS) {
        this.lastUiAt = t;
        this.publish();
      }
      const wait = Math.max(0, frameMs - (this.now() - started));
      this.timer = setTimeout(step, wait);
    };
    this.timer = setTimeout(step, 0);
  }

  private setStatus(status: CameraStatus) {
    this.status = status;
    if (status === "RUNNING" || status === "CALIBRATING") this.stoppedAt = null;
    this.publish();
  }

  private buildView(): HandView {
    return {
      status: this.status,
      error: this.error,
      stream: this.stream,
      mode: this.mode,
      reading: this.reading,
      calibrationPhase: this.calibrationPhase,
      calibration: this.signal.getCalibration(),
      handLost: this.status === "RUNNING" && this.now() - this.lastHandAt > HAND_LOST_NOTICE_MS,
    };
  }

  private publish() {
    this.view = this.buildView();
    this.listeners.forEach((l) => l(this.view));
  }
}
