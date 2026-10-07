import { useEffect, useMemo } from "react";
import { CanvasTexture, DoubleSide, SRGBColorSpace } from "three";
import { RACE_DISTANCE_M } from "../game/raceEngine";

const H = 256;
const BORDER = 20;
const BANNER_HEIGHT = 2.75;

function drawCheckerFrame(ctx: CanvasRenderingContext2D) {
  const W = ctx.canvas.width;
  const cell = BORDER;
  for (let x = 0; x < W; x += cell) {
    for (let y = 0; y < H; y += cell) {
      ctx.fillStyle = (x / cell + y / cell) % 2 === 0 ? "#ffffff" : "#111111";
      ctx.fillRect(x, y, cell, cell);
    }
  }
}

function drawDefault(ctx: CanvasRenderingContext2D) {
  const W = ctx.canvas.width;
  drawCheckerFrame(ctx);
  ctx.fillStyle = "#0b0e14";
  ctx.fillRect(BORDER, BORDER, W - BORDER * 2, H - BORDER * 2);
  ctx.fillStyle = "#ffffff";
  ctx.font = "bold 96px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("FINISH", W / 2, H / 2 + 4);
}

function drawDrawing(ctx: CanvasRenderingContext2D, img: HTMLImageElement) {
  const W = ctx.canvas.width;
  drawCheckerFrame(ctx);
  const innerW = W - BORDER * 2;
  const innerH = H - BORDER * 2;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(BORDER, BORDER, innerW, innerH);
  const fit = Math.min(innerW / img.naturalWidth, innerH / img.naturalHeight);
  const w = img.naturalWidth * fit;
  const h = img.naturalHeight * fit;
  ctx.drawImage(img, BORDER + (innerW - w) / 2, BORDER + (innerH - h) / 2, w, h);
}

/** Finish-line banner. Shows the uploaded 2D drawing as a flat image when one is set. */
export function FinishFlag({ drawingUrl, halfWidth = 2.5 }: { drawingUrl: string | null; halfWidth?: number }) {
  const bannerWidth = halfWidth * 2 + 0.5;
  const texture = useMemo(() => {
    const canvas = document.createElement("canvas");
    // Keep pixels square so the drawing is not stretched on wider tracks.
    canvas.width = Math.round((H * bannerWidth) / BANNER_HEIGHT / BORDER) * BORDER;
    canvas.height = H;
    const t = new CanvasTexture(canvas);
    t.colorSpace = SRGBColorSpace;
    return t;
  }, [bannerWidth]);

  useEffect(() => () => texture.dispose(), [texture]);

  useEffect(() => {
    const ctx = (texture.image as HTMLCanvasElement).getContext("2d");
    if (!ctx) return;
    drawDefault(ctx);
    texture.needsUpdate = true;
    if (!drawingUrl) return;

    let cancelled = false;
    const img = new Image();
    img.onload = () => {
      if (cancelled) return;
      drawDrawing(ctx, img);
      texture.needsUpdate = true;
    };
    img.src = drawingUrl;
    return () => {
      cancelled = true;
    };
  }, [drawingUrl, texture]);

  return (
    <group position={[RACE_DISTANCE_M, 0, 0]}>
      {[-(halfWidth + 0.25), halfWidth + 0.25].map((z) => (
        <mesh key={z} position={[0, 2.4, z]}>
          <cylinderGeometry args={[0.07, 0.07, 4.8, 12]} />
          <meshStandardMaterial color="#d9dee8" metalness={0.6} roughness={0.3} />
        </mesh>
      ))}
      {/* Faces -X, toward the approaching runner. */}
      <mesh position={[0, 3.55, 0]} rotation={[0, -Math.PI / 2, 0]}>
        <planeGeometry args={[bannerWidth, BANNER_HEIGHT]} />
        <meshBasicMaterial map={texture} side={DoubleSide} toneMapped={false} />
      </mesh>
    </group>
  );
}
