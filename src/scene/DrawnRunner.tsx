import { useEffect, useRef, useState } from "react";
import { useFrame } from "@react-three/fiber";
import { SRGBColorSpace, Texture } from "three";
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
        const texture = new Texture(image);
        texture.colorSpace = SRGBColorSpace;
        texture.needsUpdate = true;
        built = buildRig(mask, denormalizeJoints(decoded.joints, mask.width, mask.height), texture, decoded.flip);
        setRig(built);
      })
      .catch((error) => !cancelled && errorRef.current(error instanceof Error ? error.message : String(error)));
    return () => {
      cancelled = true;
      if (built) {
        (built.mesh.material as { map?: Texture }).map?.dispose();
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

    const pose = runPose(phase.current, amount.current);
    for (const [name, angle] of Object.entries(pose.pitch)) {
      const bone = rig.bones[name];
      if (bone) bone.rotation.x = angle;
    }
    rig.root.position.y = rig.rootRest.y + pose.bob;
  });

  // The rig's front is +Z; turn it to face the race direction (+X).
  return <group rotation={[0, Math.PI / 2, 0]}>{rig && <primitive object={rig.mesh} />}</group>;
}
