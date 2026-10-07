import { useCallback, useMemo, useRef, useState } from "react";
import { useHandPower } from "./hand/useHandPower";
import { cameraSource, sliderSource, type InputMode, type PowerSource } from "./powerSource";

/** CAMERA (default) or SLIDER input; `source.read()` is cheap enough to call every frame. */
export function useInputPower() {
  const hand = useHandPower();
  const [mode, setModeState] = useState<InputMode>("CAMERA");
  const [slider, setSliderState] = useState(0);
  const sliderRef = useRef(0);

  const setSlider = useCallback((value: number) => {
    sliderRef.current = value;
    setSliderState(value);
  }, []);

  const setMode = useCallback(
    (next: InputMode) => {
      // Switching away from the camera releases it.
      if (next === "SLIDER") hand.controller.stop();
      setModeState(next);
    },
    [hand.controller],
  );

  const source: PowerSource = useMemo(
    () => (mode === "CAMERA" ? cameraSource(hand.controller) : sliderSource(() => sliderRef.current)),
    [mode, hand.controller],
  );

  return { mode, setMode, hand, slider, setSlider, source };
}
