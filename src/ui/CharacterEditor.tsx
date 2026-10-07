import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import type { CharacterDraft } from "../character/makeCharacter";
import { BONES, JOINTS, JOINT_LABELS, type JointName, type Joints } from "../character/skeleton";

interface CharacterEditorProps {
  draft: CharacterDraft;
  initialJoints: Joints;
  initialFlip: boolean;
  onConfirm: (joints: Joints, flip: boolean) => void;
  onCancel: () => void;
}

const SIDE_COLOR: Record<string, string> = { l: "#5ee7ff", r: "#ff7a1a", c: "#ffe14d" };
const sideOf = (j: JointName) => (j.startsWith("l") ? "l" : j.startsWith("r") ? "r" : "c");

/**
 * Shows the cut-out character with its stick-figure skeleton. Players drag each dot
 * onto the right body part (or select it and use the arrow keys), then confirm.
 */
export function CharacterEditor({ draft, initialJoints, initialFlip, onConfirm, onCancel }: CharacterEditorProps) {
  const [joints, setJoints] = useState<Joints>(initialJoints);
  const [flip, setFlip] = useState(initialFlip);
  const [active, setActive] = useState<JointName | null>(null);
  const svg = useRef<SVGSVGElement>(null);
  const dialog = useRef<HTMLDivElement>(null);
  const { width, height } = draft;
  const r = Math.max(4, Math.max(width, height) * 0.022);

  useEffect(() => {
    dialog.current?.focus();
  }, []);

  const toImage = (event: PointerEvent) => {
    const rect = svg.current!.getBoundingClientRect();
    let x = ((event.clientX - rect.left) / rect.width) * width;
    const y = ((event.clientY - rect.top) / rect.height) * height;
    if (flip) x = width - x;
    return { x: Math.min(width, Math.max(0, x)), y: Math.min(height, Math.max(0, y)) };
  };

  const move = (name: JointName, p: { x: number; y: number }) => setJoints((j) => ({ ...j, [name]: p }));

  const onKey = (name: JointName) => (event: KeyboardEvent) => {
    const step = event.shiftKey ? 8 : 2;
    const dx = { ArrowLeft: -step, ArrowRight: step }[event.key] ?? 0;
    const dy = { ArrowUp: -step, ArrowDown: step }[event.key] ?? 0;
    if (!dx && !dy) return;
    event.preventDefault();
    const p = joints[name];
    move(name, { x: Math.min(width, Math.max(0, p.x + (flip ? -dx : dx))), y: Math.min(height, Math.max(0, p.y + dy)) });
  };

  return (
    <div className="modal-backdrop">
      <div
        className="modal card character-editor"
        role="dialog"
        aria-modal="true"
        aria-labelledby="editor-title"
        tabIndex={-1}
        ref={dialog}
        onKeyDown={(e) => e.key === "Escape" && onCancel()}
      >
        <h2 id="editor-title">Set up your runner</h2>
        <p className="hint">
          We cut your drawing out of the paper. Drag the dots onto the head, neck, hips, shoulders, elbows, hands, knees
          and feet. The drawing bends at these points when it runs.
        </p>
        <div className="editor-stage">
          <svg
            ref={svg}
            viewBox={`0 0 ${width} ${height}`}
            role="group"
            aria-label="Character skeleton"
            style={{ transform: flip ? "scaleX(-1)" : undefined }}
            onPointerMove={(e) => active && move(active, toImage(e))}
            onPointerUp={() => setActive(null)}
            onPointerLeave={() => setActive(null)}
          >
            <image href={draft.url} width={width} height={height} />
            {BONES.map((b) => (
              <line
                key={b.name}
                x1={joints[b.from].x}
                y1={joints[b.from].y}
                x2={joints[b.to].x}
                y2={joints[b.to].y}
                stroke={SIDE_COLOR[sideOf(b.to)]}
                strokeWidth={r * 0.45}
                strokeLinecap="round"
                opacity={0.85}
              />
            ))}
            {/* Shoulders and hips connect to the spine. */}
            {(["lShoulder", "rShoulder"] as const).map((j) => (
              <line key={j} x1={joints.neck.x} y1={joints.neck.y} x2={joints[j].x} y2={joints[j].y} stroke="#ffe14d" strokeWidth={r * 0.3} opacity={0.6} />
            ))}
            {(["lHip", "rHip"] as const).map((j) => (
              <line key={j} x1={joints.root.x} y1={joints.root.y} x2={joints[j].x} y2={joints[j].y} stroke="#ffe14d" strokeWidth={r * 0.3} opacity={0.6} />
            ))}
            {JOINTS.map((j) => (
              <circle
                key={j}
                cx={joints[j].x}
                cy={joints[j].y}
                r={active === j ? r * 1.35 : r}
                fill={SIDE_COLOR[sideOf(j)]}
                stroke="#000"
                strokeWidth={r * 0.25}
                tabIndex={0}
                role="slider"
                aria-label={`${JOINT_LABELS[j]}${sideOf(j) === "c" ? "" : sideOf(j) === "l" ? " (left side of picture)" : " (right side of picture)"}`}
                aria-valuetext={`x ${Math.round(joints[j].x)}, y ${Math.round(joints[j].y)}`}
                className="joint"
                data-joint={j}
                onPointerDown={(e) => {
                  (e.target as Element).setPointerCapture?.(e.pointerId);
                  setActive(j);
                }}
                onKeyDown={onKey(j)}
              />
            ))}
          </svg>
        </div>
        <div className="buttons">
          <button type="button" onClick={() => setFlip((f) => !f)} aria-pressed={flip}>
            FLIP
          </button>
          <button type="button" onClick={() => setJoints(draft.joints)}>
            RESET DOTS
          </button>
        </div>
        <div className="buttons">
          <button type="button" onClick={onCancel}>
            CANCEL
          </button>
          <button type="button" className="primary" onClick={() => onConfirm(joints, flip)}>
            USE THIS RUNNER
          </button>
        </div>
      </div>
    </div>
  );
}
