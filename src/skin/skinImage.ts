/** Skins are square PNGs, small enough to share over Supabase Storage. */
export const SKIN_SIZE = 256;
export const SKIN_MAX_BYTES = 256 * 1024;

export interface SkinImage {
  blob: Blob;
  /** Object URL owned by whoever created it; revoke when replaced. */
  url: string;
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Could not decode the drawing"));
    img.src = src;
  });
}

function toBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("Could not encode skin"))), type, quality),
  );
}

/** Centre-crops the drawing to a square and scales it to 256x256 PNG on a white background. */
export async function makeSkinImage(drawingUrl: string): Promise<SkinImage> {
  const img = await loadImage(drawingUrl);
  const side = Math.min(img.naturalWidth, img.naturalHeight);
  const sx = (img.naturalWidth - side) / 2;
  const sy = (img.naturalHeight - side) / 2;
  let size = SKIN_SIZE;
  for (;;) {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, size, size);
    ctx.drawImage(img, sx, sy, side, side, 0, 0, size, size);
    const blob = await toBlob(canvas, "image/png");
    // Photos can compress poorly; shrink until under the storage limit.
    if (blob.size <= SKIN_MAX_BYTES || size <= 96) return { blob, url: URL.createObjectURL(blob) };
    size = Math.round(size * 0.75);
  }
}
