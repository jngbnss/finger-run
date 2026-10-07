import { useRef, useState, type ChangeEvent } from "react";
import { validateDrawingFile } from "./drawingValidation";

interface DrawingUploadProps {
  drawingUrl: string | null;
  /** Receives a decoded, validated object URL; the owner revokes the previous one. */
  onDrawing: (url: string) => void;
  /** Whether the drawing is worn as the runner skin. */
  skinOn: boolean;
  onSkinOn: (on: boolean) => void;
  /** Label for the skin toggle; differs between SOLO (local) and ONLINE (shared). */
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

export function DrawingUpload({ drawingUrl, onDrawing, skinOn, onSkinOn, skinLabel, skinNote }: DrawingUploadProps) {
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
      <h2>Drawing &amp; skin</h2>
      <p className="notice">3D conversion is not connected in this prototype.</p>
      <p className="hint">
        Your PNG/JPG (max 5MB) appears on the finish banner and, as a skin, on your runner&apos;s chest and back.
      </p>
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
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <label className="check">
        <input type="checkbox" checked={skinOn} onChange={(e) => onSkinOn(e.target.checked)} disabled={!drawingUrl} />
        <span>{skinLabel}</span>
      </label>
      {skinNote && (
        <p className="hint" role="status" data-testid="skin-note">
          {skinNote}
        </p>
      )}
      {drawingUrl && (
        <figure className="preview">
          <img src={drawingUrl} alt="Uploaded drawing preview" />
          <figcaption>A flat 2D image on the banner{skinOn ? " and your runner" : ""}</figcaption>
        </figure>
      )}
    </section>
  );
}
