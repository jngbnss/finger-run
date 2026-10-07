/// <reference lib="webworker" />
import { FilesetResolver, HandLandmarker } from "@mediapipe/tasks-vision";
import type { WorkerRequest, WorkerResponse } from "./handProtocol";

/**
 * Runs the MediaPipe Hand Landmarker off the main thread. Receives ImageBitmaps,
 * returns only the 21 landmarks of one hand. Nothing leaves the browser.
 */

let landmarker: HandLandmarker | null = null;
const post = (msg: WorkerResponse, transfer: Transferable[] = []) =>
  (self as unknown as DedicatedWorkerGlobalScope).postMessage(msg, transfer);

async function init(wasmBase: string, modelUrl: string) {
  // useModule=true: the loader falls back to import() inside a module worker.
  const fileset = await FilesetResolver.forVisionTasks(wasmBase, true);
  for (const delegate of ["GPU", "CPU"] as const) {
    try {
      landmarker = await HandLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: modelUrl, delegate },
        runningMode: "VIDEO",
        numHands: 1,
      });
      return delegate;
    } catch (error) {
      if (delegate === "CPU") throw error;
    }
  }
  throw new Error("unreachable");
}

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const msg = event.data;
  if (msg.type === "init") {
    try {
      const delegate = await init(msg.wasmBase, msg.modelUrl);
      post({ type: "ready", delegate });
    } catch (error) {
      post({ type: "error", message: error instanceof Error ? error.message : String(error) });
    }
    return;
  }
  if (msg.type === "frame") {
    const { bitmap, timestamp } = msg;
    try {
      if (!landmarker) throw new Error("Hand model not ready");
      const result = landmarker.detectForVideo(bitmap, timestamp);
      const hand = result.landmarks[0];
      post({
        type: "result",
        timestamp,
        landmarks: hand ? hand.map((p) => ({ x: p.x, y: p.y })) : null,
      });
    } catch (error) {
      post({ type: "result", timestamp, landmarks: null, error: error instanceof Error ? error.message : String(error) });
    } finally {
      bitmap.close();
    }
    return;
  }
  if (msg.type === "close") {
    landmarker?.close();
    landmarker = null;
    self.close();
  }
};
