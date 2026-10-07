import { describe, expect, it } from "vitest";
import { MAX_DRAWING_BYTES, validateDrawingFile } from "./drawingValidation";

describe("drawing upload validation", () => {
  it("accepts PNG and JPEG within 5MB", () => {
    expect(validateDrawingFile({ name: "a.png", type: "image/png", size: 1000 })).toBeNull();
    expect(validateDrawingFile({ name: "a.jpg", type: "image/jpeg", size: MAX_DRAWING_BYTES })).toBeNull();
  });

  it("rejects other types", () => {
    expect(validateDrawingFile({ name: "a.gif", type: "image/gif", size: 10 })).toMatch(/PNG or JPG/);
    expect(validateDrawingFile({ name: "a.svg", type: "image/svg+xml", size: 10 })).toMatch(/PNG or JPG/);
    expect(validateDrawingFile({ name: "notes.txt", type: "", size: 10 })).toMatch(/PNG or JPG/);
  });

  it("rejects oversized and empty files", () => {
    expect(
      validateDrawingFile({ name: "big.png", type: "image/png", size: MAX_DRAWING_BYTES + 1 }),
    ).toMatch(/over the 5MB limit/);
    expect(validateDrawingFile({ name: "empty.png", type: "image/png", size: 0 })).toMatch(/empty/);
  });
});
