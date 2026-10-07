import type { HandLandmarker } from "@mediapipe/tasks-vision";
import type { Landmark } from "./fingerSignal";
import { HAND_MODEL_URL, WASM_BASE, type WorkerResponse } from "./handProtocol";

/** Where landmarks come from: a real camera + MediaPipe, or a synthetic hand in tests. */
export interface HandTrackingSource {
  /** Opens the camera. Rejects with the browser's DOMException on failure. */
  start(onStreamEnded: () => void): Promise<MediaStream | null>;
  /** Loads the hand model; resolves with the inference mode used. */
  loadModel(): Promise<InferenceMode>;
  /** Landmarks of one hand for the current frame, or null if no hand. */
  detect(timestamp: number): Promise<Landmark[] | null>;
  /** Max inference rate for this mode. */
  readonly fps: number;
  stop(): void;
}

export type InferenceMode = "worker" | "main-thread" | "synthetic";

export const CAMERA_CONSTRAINTS: MediaStreamConstraints = {
  video: { facingMode: "user", width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 30 } },
  audio: false,
};

class ModelLoadError extends Error {
  name = "ModelLoadError";
}

export function isModelLoadError(error: unknown) {
  return error instanceof ModelLoadError;
}

interface Detector {
  detect(video: HTMLVideoElement, timestamp: number): Promise<Landmark[] | null>;
  close(): void;
}

/** MediaPipe in a module Worker; frames go over as transferable ImageBitmaps. */
async function createWorkerDetector(): Promise<Detector> {
  const worker = new Worker(new URL("./handWorker.ts", import.meta.url), { type: "module" });
  const pending = new Map<number, (landmarks: Landmark[] | null) => void>();

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Hand model timed out")), 45_000);
    worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const msg = event.data;
      if (msg.type === "ready") {
        clearTimeout(timer);
        resolve();
      } else if (msg.type === "error") {
        clearTimeout(timer);
        reject(new Error(msg.message));
      } else if (msg.type === "result") {
        pending.get(msg.timestamp)?.(msg.landmarks);
        pending.delete(msg.timestamp);
      }
    };
    worker.onerror = (event) => {
      clearTimeout(timer);
      reject(new Error(event.message || "Hand worker failed"));
    };
    worker.postMessage({ type: "init", wasmBase: WASM_BASE, modelUrl: HAND_MODEL_URL });
  }).catch((error) => {
    worker.terminate();
    throw error;
  });

  return {
    async detect(video, timestamp) {
      const bitmap = await createImageBitmap(video);
      return new Promise((resolve) => {
        pending.set(timestamp, resolve);
        worker.postMessage({ type: "frame", bitmap, timestamp }, [bitmap]);
      });
    },
    close() {
      pending.forEach((resolve) => resolve(null));
      pending.clear();
      worker.postMessage({ type: "close" });
      setTimeout(() => worker.terminate(), 500);
    },
  };
}

/** Fallback for browsers without module workers / OffscreenCanvas. */
async function createMainThreadDetector(): Promise<Detector> {
  const vision = await import("@mediapipe/tasks-vision");
  const { FilesetResolver } = vision;
  const fileset = await FilesetResolver.forVisionTasks(WASM_BASE);
  let landmarker: HandLandmarker | null = null;
  for (const delegate of ["GPU", "CPU"] as const) {
    try {
      landmarker = await vision.HandLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: HAND_MODEL_URL, delegate },
        runningMode: "VIDEO",
        numHands: 1,
      });
      break;
    } catch (error) {
      if (delegate === "CPU") throw error;
    }
  }
  return {
    async detect(video, timestamp) {
      const hand = landmarker!.detectForVideo(video, timestamp).landmarks[0];
      return hand ? hand.map((p) => ({ x: p.x, y: p.y })) : null;
    },
    close() {
      landmarker?.close();
    },
  };
}

const workerSupported = () =>
  typeof Worker !== "undefined" && typeof OffscreenCanvas !== "undefined" && typeof createImageBitmap === "function";

/** Real camera + MediaPipe Hand Landmarker (VIDEO mode, one hand). */
export class CameraHandSource implements HandTrackingSource {
  private stream: MediaStream | null = null;
  private video: HTMLVideoElement | null = null;
  private detector: Detector | null = null;
  fps = 30;

  async start(onStreamEnded: () => void): Promise<MediaStream> {
    if (!navigator.mediaDevices?.getUserMedia) throw new DOMException("No camera API", "NotFoundError");
    const stream = await navigator.mediaDevices.getUserMedia(CAMERA_CONSTRAINTS);
    this.stream = stream;
    stream.getVideoTracks().forEach((track) => track.addEventListener("ended", onStreamEnded));
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.srcObject = stream;
    await video.play();
    this.video = video;
    return stream;
  }

  async loadModel(): Promise<InferenceMode> {
    if (workerSupported()) {
      try {
        this.detector = await createWorkerDetector();
        this.fps = 30;
        return "worker";
      } catch {
        // Fall through to the main thread.
      }
    }
    try {
      this.detector = await createMainThreadDetector();
      this.fps = 15;
      return "main-thread";
    } catch (error) {
      throw new ModelLoadError(error instanceof Error ? error.message : String(error));
    }
  }

  async detect(timestamp: number) {
    const video = this.video;
    if (!video || !this.detector || video.readyState < 2 || video.videoWidth === 0) return null;
    return this.detector.detect(video, timestamp);
  }

  stop() {
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    if (this.video) this.video.srcObject = null;
    this.video = null;
    this.detector?.close();
    this.detector = null;
  }
}

/** Synthetic hand for tests: the index finger oscillates at a fixed rate. No camera access. */
export class SyntheticHandSource implements HandTrackingSource {
  fps = 30;
  constructor(
    private readonly options: { amplitude?: number; hz?: number; deny?: boolean; visible?: () => boolean } = {},
  ) {}

  async start() {
    if (this.options.deny) throw new DOMException("Permission denied", "NotAllowedError");
    return null;
  }

  async loadModel(): Promise<InferenceMode> {
    return "synthetic";
  }

  async detect(timestamp: number): Promise<Landmark[] | null> {
    if (this.options.visible && !this.options.visible()) return null;
    const amp = this.options.amplitude ?? 0.08;
    const hz = this.options.hz ?? 5;
    const lm: Landmark[] = Array.from({ length: 21 }, () => ({ x: 0.5, y: 0.7 }));
    lm[9] = { x: 0.5, y: 0.5 };
    lm[8] = { x: 0.52, y: 0.55 + amp * Math.sin((2 * Math.PI * hz * timestamp) / 1000) };
    return lm;
  }

  stop() {}
}
