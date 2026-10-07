import { useEffect, useRef, useState } from "react";
import { useFrame } from "@react-three/fiber";
import { CanvasTexture, SRGBColorSpace, Texture } from "three";
import { makeBackView } from "../character/backView";
import { buildRig, type CharacterRig } from "../character/buildRig";
import { loadCutout } from "../character/makeCharacter";
import { runPose } from "../character/runPose";
import { decodeRig, denormalizeJoints } from "../character/skeleton";

/** Strides per second at animationScale 1 (same cadence as the robot). */
const BASE_CADENCE_HZ = 1.4;

export interface CharacterSkin {
  /** Transparent cut-out PNG. */
  url: string;
  /** Encoded joints + flip (see encodeRig). */
  rig: string;
}

interface DrawnRunnerProps {
  character: CharacterSkin;
  animationScale: number;
  running: boolean;
  /** Called if the character cannot be built; the slot falls back to the robot. */
  onError: (reason: string) => void;
}

/**
 * The player's own drawing as an inflated, skinned 3D figure. It faces the running
 * direction (+X), so the chase camera sees its back, and its limbs swing forward and
 * back with the stick-figure skeleton.
 */
export function DrawnRunner({ character, animationScale, running, onError }: DrawnRunnerProps) {
  const [rig, setRig] = useState<CharacterRig | null>(null);
  const phase = useRef(0);
  const amount = useRef(0);
  const errorRef = useRef(onError);
  errorRef.current = onError;

  useEffect(() => {
    let cancelled = false;
    let built: CharacterRig | null = null;
    const decoded = decodeRig(character.rig);
    if (!decoded) {
      errorRef.current("Character joints are invalid");
      return;
    }
    loadCutout(character.url)
      .then(({ image, mask }) => {
        if (cancelled) return;
        const joints = denormalizeJoints(decoded.joints, mask.width, mask.height);
        const texture = new Texture(image);
        texture.colorSpace = SRGBColorSpace;
        texture.needsUpdate = true;
        built = buildRig(mask, joints, texture, decoded.flip, backTexture(image, mask, joints.neck.y));
        setRig(built);
      })
      .catch((error) => !cancelled && errorRef.current(error instanceof Error ? error.message : String(error)));
    return () => {
      cancelled = true;
      if (built) {
        for (const m of built.mesh.material as Array<{ map?: Texture | null }>) m.map?.dispose();
        built.dispose();
      }
      setRig(null);
    };
  }, [character.url, character.rig]);

  useFrame((_, delta) => {
    if (!rig) return;
    const dt = Math.min(delta, 0.05);
    const scale = running ? animationScale : 0;
    phase.current += dt * scale * BASE_CADENCE_HZ * Math.PI * 2;
    const target = scale > 0 ? Math.min(1, 0.45 + scale * 0.25) : 0;
    amount.current += (target - amount.current) * Math.min(1, dt * 8);

    const pose = runPose(phase.current, amount.current, rig.freedom);
    for (const [name, angle] of Object.entries(pose.pitch)) {
      const bone = rig.bones[name];
      if (bone) bone.rotation.x = angle;
    }
    rig.root.position.y = rig.rootRest.y + pose.bob;
  });

  // The rig's front is +Z; turn it to face the race direction (+X). The camera sees the painted back.
  return <group rotation={[0, Math.PI / 2, 0]}>{rig && <primitive object={rig.mesh} />}</group>;
}

/** The drawing's back side: same silhouette, face and inner lines painted over. */
function backTexture(image: HTMLImageElement, mask: { width: number; height: number; data: Uint8Array }, neckY: number) {
  const canvas = document.createElement("canvas");
  canvas.width = mask.width;
  canvas.height = mask.height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(image, 0, 0);
  const pixels = ctx.getImageData(0, 0, mask.width, mask.height);
  pixels.data.set(makeBackView(pixels.data, mask, Math.round(neckY)));
  ctx.putImageData(pixels, 0, 0);
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  return texture;
}
