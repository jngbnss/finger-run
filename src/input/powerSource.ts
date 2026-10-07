import type { HandPowerController } from "./hand/handPowerController";

export type InputMode = "CAMERA" | "SLIDER";

/** Anything that yields a 0..100 power on demand. Read every animation frame. */
export interface PowerSource {
  readonly mode: InputMode;
  read(): number;
}

export function sliderSource(getValue: () => number): PowerSource {
  return { mode: "SLIDER", read: getValue };
}

export function cameraSource(controller: HandPowerController): PowerSource {
  return { mode: "CAMERA", read: () => controller.power() };
}
