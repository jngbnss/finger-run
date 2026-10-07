import type { Landmark } from "./fingerSignal";

export type WorkerRequest =
  | { type: "init"; wasmBase: string; modelUrl: string }
  | { type: "frame"; bitmap: ImageBitmap; timestamp: number }
  | { type: "close" };

export type WorkerResponse =
  | { type: "ready"; delegate: "GPU" | "CPU" }
  | { type: "error"; message: string }
  | { type: "result"; timestamp: number; landmarks: Landmark[] | null; error?: string };

/** Pinned to the installed @mediapipe/tasks-vision version. Only model files are downloaded. */
export const MEDIAPIPE_VERSION = "1.1.0";
export const WASM_BASE = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MEDIAPIPE_VERSION}/wasm`;
export const HAND_MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task";
