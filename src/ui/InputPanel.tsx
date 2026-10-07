import type { CSSProperties } from "react";
import type { HandPowerController, HandView } from "../input/hand/handPowerController";
import type { InputMode } from "../input/powerSource";
import { CameraPanel } from "./CameraPanel";

interface InputPanelProps {
  mode: InputMode;
  onMode: (mode: InputMode) => void;
  hand: { controller: HandPowerController; view: HandView };
  slider: number;
  onSlider: (value: number) => void;
}

/** CAMERA / SLIDER toggle with the active control below it. */
export function InputPanel({ mode, onMode, hand, slider, onSlider }: InputPanelProps) {
  return (
    <section className="card input-panel" aria-labelledby="input-title">
      <div className="input-head">
        <h2 id="input-title">Input</h2>
        <div className="segmented" role="radiogroup" aria-label="Input method">
          {(["CAMERA", "SLIDER"] as const).map((m) => (
            <button
              key={m}
              type="button"
              role="radio"
              aria-checked={mode === m}
              className={mode === m ? "on" : ""}
              onClick={() => onMode(m)}
            >
              {m}
            </button>
          ))}
        </div>
      </div>
      {mode === "CAMERA" ? (
        <CameraPanel view={hand.view} controller={hand.controller} onUseSlider={() => onMode("SLIDER")} />
      ) : (
        <>
          <label className="power" htmlFor="power">
            <span>POWER</span>
            <output htmlFor="power">{slider}</output>
          </label>
          <input
            id="power"
            type="range"
            min={0}
            max={100}
            step={1}
            value={slider}
            onChange={(e) => onSlider(Number(e.target.value))}
            style={{ "--fill": `${slider}%` } as CSSProperties}
          />
        </>
      )}
    </section>
  );
}
