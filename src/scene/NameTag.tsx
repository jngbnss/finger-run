import { useEffect, useMemo } from "react";
import { CanvasTexture, SRGBColorSpace } from "three";

/** Billboard label above a runner, drawn to a canvas (no DOM overlay, no font download). */
export function NameTag({ text, color, highlight }: { text: string; color: string; highlight?: boolean }) {
  const texture = useMemo(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 256;
    canvas.height = 64;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = highlight ? color : "rgba(7, 9, 14, 0.8)";
    ctx.beginPath();
    ctx.roundRect(4, 8, 248, 48, 12);
    ctx.fill();
    ctx.lineWidth = 4;
    ctx.strokeStyle = color;
    ctx.stroke();
    ctx.fillStyle = highlight ? "#000000" : "#ffffff";
    ctx.font = "bold 30px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(text, 128, 33, 232);
    const t = new CanvasTexture(canvas);
    t.colorSpace = SRGBColorSpace;
    return t;
  }, [text, color, highlight]);

  useEffect(() => () => texture.dispose(), [texture]);

  return (
    <sprite position={[0, 2.35, 0]} scale={[1.6, 0.4, 1]} renderOrder={10}>
      <spriteMaterial map={texture} transparent depthTest={false} />
    </sprite>
  );
}
