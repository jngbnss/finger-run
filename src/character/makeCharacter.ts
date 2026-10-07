import { maskArea, maskBounds, segmentCharacter, type Mask } from "./segment";
import { guessJoints, type Joints } from "./skeleton";

/** Longest side of the cut-out PNG, and the largest file we share. */
const MAX_SIDE = 384;
const MAX_BYTES = 256 * 1024;
const PAD = 4;

export class CharacterError extends Error {
  name = "CharacterError";
}

/** A cut-out waiting for the player to check the joints. */
export interface CharacterDraft {
  width: number;
  height: number;
  mask: Mask;
  /** Guessed joints in cut-out pixels. */
  joints: Joints;
  /** Transparent PNG of just the character. */
  blob: Blob;
  url: string;
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new CharacterError("Could not read the drawing."));
    img.src = src;
  });
}

function toBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new CharacterError("Could not save the cut-out."))), "image/png"),
  );
}

async function cutOut(img: HTMLImageElement, maxSide: number): Promise<CharacterDraft> {
  const scale = Math.min(1, (maxSide * 1.4) / Math.max(img.naturalWidth, img.naturalHeight));
  const sw = Math.max(1, Math.round(img.naturalWidth * scale));
  const sh = Math.max(1, Math.round(img.naturalHeight * scale));
  const source = document.createElement("canvas");
  source.width = sw;
  source.height = sh;
  const sctx = source.getContext("2d", { willReadFrequently: true })!;
  sctx.drawImage(img, 0, 0, sw, sh);
  const pixels = sctx.getImageData(0, 0, sw, sh);
  const full = segmentCharacter(pixels.data, sw, sh);

  const area = maskArea(full) / (sw * sh);
  if (area < 0.005) throw new CharacterError("No character found. Draw with a dark pen on plain paper and try again.");
  if (area > 0.97) throw new CharacterError("Couldn't tell the character from the background. Use a plain, light background.");

  // Crop to the character (plus padding) and fit inside maxSide.
  const box = maskBounds(full)!;
  const x0 = Math.max(0, box.x0 - PAD);
  const y0 = Math.max(0, box.y0 - PAD);
  const x1 = Math.min(sw - 1, box.x1 + PAD);
  const y1 = Math.min(sh - 1, box.y1 + PAD);
  const fit = Math.min(1, maxSide / Math.max(x1 - x0 + 1, y1 - y0 + 1));
  const width = Math.max(1, Math.round((x1 - x0 + 1) * fit));
  const height = Math.max(1, Math.round((y1 - y0 + 1) * fit));

  const out = document.createElement("canvas");
  out.width = width;
  out.height = height;
  const octx = out.getContext("2d", { willReadFrequently: true })!;
  const rgba = octx.createImageData(width, height);
  const maskData = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const srcX = Math.min(sw - 1, x0 + Math.floor(x / fit));
      const srcY = Math.min(sh - 1, y0 + Math.floor(y / fit));
      const s = srcY * sw + srcX;
      const d = y * width + x;
      const on = full.data[s];
      maskData[d] = on;
      rgba.data.set([pixels.data[s * 4], pixels.data[s * 4 + 1], pixels.data[s * 4 + 2], on ? 255 : 0], d * 4);
    }
  }
  octx.putImageData(rgba, 0, 0);
  const mask: Mask = { width, height, data: maskData };
  const blob = await toBlob(out);
  return { width, height, mask, joints: guessJoints(mask), blob, url: URL.createObjectURL(blob) };
}

/** Cuts the character out of an uploaded drawing and guesses its joints. */
export async function makeCharacterDraft(drawingUrl: string): Promise<CharacterDraft> {
  const img = await loadImage(drawingUrl);
  let side = MAX_SIDE;
  for (;;) {
    const draft = await cutOut(img, side);
    if (draft.blob.size <= MAX_BYTES || side <= 128) return draft;
    URL.revokeObjectURL(draft.url);
    side = Math.round(side * 0.75);
  }
}

/** Reads the silhouette back from a cut-out PNG (alpha channel), e.g. one shared by another player. */
export async function loadCutout(url: string): Promise<{ image: HTMLImageElement; mask: Mask }> {
  const image = await loadImage(url);
  const width = image.naturalWidth;
  const height = image.naturalHeight;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(image, 0, 0);
  const { data } = ctx.getImageData(0, 0, width, height);
  const mask = new Uint8Array(width * height);
  for (let i = 0; i < mask.length; i++) mask[i] = data[i * 4 + 3] > 127 ? 1 : 0;
  return { image, mask: { width, height, data: mask } };
}
