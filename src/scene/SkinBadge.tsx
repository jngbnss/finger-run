import { useEffect, useState } from "react";
import { SRGBColorSpace, TextureLoader, type Texture } from "three";

/** Loads an image URL into a texture; null while loading or on failure. */
export function useSkinTexture(url: string | null | undefined): Texture | null {
  const [texture, setTexture] = useState<Texture | null>(null);
  useEffect(() => {
    if (!url) {
      setTexture(null);
      return;
    }
    let cancelled = false;
    let loaded: Texture | null = null;
    new TextureLoader().load(
      url,
      (t) => {
        t.colorSpace = SRGBColorSpace;
        loaded = t;
        if (cancelled) t.dispose();
        else setTexture(t);
      },
      undefined,
      () => !cancelled && setTexture(null),
    );
    return () => {
      cancelled = true;
      loaded?.dispose();
    };
  }, [url]);
  return texture;
}

interface SkinBadgeProps {
  texture: Texture;
  /** Edge length in the parent's units. */
  size: number;
  frameColor?: string;
}

/** The player's drawing as a framed square patch; faces +Z of its parent. */
export function SkinBadge({ texture, size, frameColor = "#111111" }: SkinBadgeProps) {
  return (
    <group>
      <mesh position={[0, 0, -size * 0.01]}>
        <planeGeometry args={[size * 1.12, size * 1.12]} />
        <meshBasicMaterial color={frameColor} />
      </mesh>
      <mesh>
        <planeGeometry args={[size, size]} />
        <meshBasicMaterial map={texture} toneMapped={false} />
      </mesh>
    </group>
  );
}
