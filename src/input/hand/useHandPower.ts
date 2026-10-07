import { useEffect, useState } from "react";
import { getTestHooks } from "../../testing/testHooks";
import { HandPowerController, type HandView } from "./handPowerController";
import { CameraHandSource, SyntheticHandSource, type HandTrackingSource } from "./handTracking";

function createSource(): HandTrackingSource {
  const camera = getTestHooks()?.camera;
  if (camera?.mode === "synthetic") return new SyntheticHandSource(camera);
  if (camera?.mode === "deny") return new SyntheticHandSource({ deny: true });
  return new CameraHandSource();
}

/**
 * Owns one HandPowerController for the component's lifetime. Stops the camera on
 * unmount and when the page is hidden (status PAUSED until the user restarts it).
 * React state updates at most 15 times per second.
 */
export function useHandPower(): { controller: HandPowerController; view: HandView } {
  const [controller] = useState(() => new HandPowerController(createSource));
  const [view, setView] = useState<HandView>(() => controller.getView());

  useEffect(() => {
    const unsubscribe = controller.subscribe(setView);
    const onVisibility = () => {
      if (document.hidden && controller.getView().status !== "OFF" && controller.getView().status !== "ERROR") {
        controller.stop(true);
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      unsubscribe();
      controller.stop();
    };
  }, [controller]);

  return { controller, view };
}
