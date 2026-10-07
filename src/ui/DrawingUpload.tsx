import { useRef, useState, type ChangeEvent } from "react";
import type { DrawingState } from "../skin/useDrawing";
import { CharacterEditor } from "./CharacterEditor";
import { validateDrawingFile } from "./drawingValidation";

interface DrawingUploadProps {
  drawing: DrawingState;
  /** Label for the "race as my drawing" toggle; differs between SOLO (local) and ONLINE (shared). */
  skinLabel: string;
  skinNote?: string | null;
}

async function decodes(url: string): Promise<boolean> {
  const img = new Image();
  img.src = url;
  try {
    await img.decode();
    return img.naturalWidth > 0 && img.naturalHeight > 0;
  } catch {
    return false;
  }
}

export function DrawingUpload({ drawing, skinLabel, skinNote }: DrawingUploadProps) {
  const drawingUrl = drawing.url;
  const onDrawing = drawing.setUrl;
  const { skinOn, setSkinOn: onSkinOn, character } = drawing;
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  async function handleChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;

    const problem = validateDrawingFile(file);
    if (problem) {
      setError(problem);
      return;
    }

    setBusy(true);
    const candidate = URL.createObjectURL(file);
    const ok = await decodes(candidate);
    setBusy(false);
    if (!ok) {
      // Keep the existing preview and flag.
      URL.revokeObjectURL(candidate);
      setError(`"${file.name}" could not be decoded as an image. The previous drawing was kept.`);
      return;
    }
    setError(null);
    onDrawing(candidate);
  }

  return (
    <section className="card upload">
      <h2>Your drawing runner</h2>
      <p className="hint">
        Draw a character (a stick figure works) with a dark pen on plain paper and upload a photo (PNG/JPG, max 5MB). We
        cut it out, puff it up into a simple 3D shape and make it run. It also appears on the finish banner.
      </p>
      <p className="notice">AI 3D model conversion is not connected in this prototype; the shape is an inflated cut-out.</p>
      <input
        ref={input}
        type="file"
        accept="image/png,image/jpeg"
        aria-label="Drawing file (PNG or JPG, up to 5MB)"
        onChange={handleChange}
        hidden
      />
      <button type="button" className="secondary" onClick={() => input.current?.click()} disabled={busy}>
        {busy ? "Checking image…" : drawingUrl ? "Replace drawing" : "Upload drawing"}
      </button>
      {drawing.processing && (
        <p className="hint" role="status">
          Cutting out your drawing…
        </p>
      )}
      {drawing.error && (
        <p className="error" role="alert">
          {drawing.error}
        </p>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <label className="check">
        <input type="checkbox" checked={skinOn} onChange={(e) => onSkinOn(e.target.checked)} disabled={!character} />
        <span>{skinLabel}</span>
      </label>
      {skinNote && (
        <p className="hint" role="status" data-testid="skin-note">
          {skinNote}
        </p>
      )}
      {character && (
        <figure className="preview cutout">
          <img src={character.url} alt="Your cut-out runner" />
          <figcaption data-testid="character-status">
            {skinOn ? "Racing as your drawing" : "Saved, but racing as the robot"}
          </figcaption>
        </figure>
      )}
      {drawing.draft && !drawing.editing && (
        <button type="button" className="link" onClick={drawing.openEditor}>
          {character ? "Edit joints" : "Set up joints"}
        </button>
      )}
      {drawing.editing && drawing.draft && drawing.editorJoints && (
        <CharacterEditor
          key={drawing.draft.url}
          draft={drawing.draft}
          initialJoints={drawing.editorJoints}
          initialFlip={drawing.editorFlip}
          onConfirm={drawing.confirm}
          onCancel={drawing.closeEditor}
        />
      )}
    </section>
  );
}
