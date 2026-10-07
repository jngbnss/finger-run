export const MAX_DRAWING_BYTES = 5 * 1024 * 1024;
const ACCEPTED_TYPES = ["image/png", "image/jpeg"];
const ACCEPTED_EXTENSIONS = /\.(png|jpe?g)$/i;

/** Returns an error message, or null when the file may be decoded. */
export function validateDrawingFile(file: { name: string; type: string; size: number }): string | null {
  const typeOk = file.type ? ACCEPTED_TYPES.includes(file.type) : ACCEPTED_EXTENSIONS.test(file.name);
  if (!typeOk) {
    return `"${file.name}" is not a PNG or JPG image.`;
  }
  if (file.size > MAX_DRAWING_BYTES) {
    const mb = (file.size / (1024 * 1024)).toFixed(2);
    return `"${file.name}" is ${mb}MB, over the 5MB limit.`;
  }
  if (file.size === 0) {
    return `"${file.name}" is empty.`;
  }
  return null;
}
