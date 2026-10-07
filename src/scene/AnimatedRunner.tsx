import { useEffect, useMemo } from "react";
import { useFrame } from "@react-three/fiber";
import { useGLTF } from "@react-three/drei";
import {
  AnimationMixer,
  Box3,
  Color,
  Mesh,
  Vector3,
  type Material,
  type MeshStandardMaterial,
} from "three";
import { clone as cloneSkinned } from "three/examples/jsm/utils/SkeletonUtils.js";
import { pickRunClip, stripRootMotion } from "./clipUtils";
import { GHOST_COLOR, GHOST_OPACITY, type RunnerVisualProps } from "./runnerTypes";

export const MODEL_URL = `${import.meta.env.BASE_URL}models/RobotExpressive.glb`;
const TARGET_HEIGHT_M = 1.8;

export class MissingClipError extends Error {
  constructor(names: string[]) {
    super(`No Running/Run/Walking clip in model (found: ${names.join(", ") || "none"})`);
  }
}

function ghostify(material: Material): Material {
  const m = material.clone() as MeshStandardMaterial;
  m.transparent = true;
  m.opacity = GHOST_OPACITY;
  m.depthWrite = false;
  if (m.color) m.color = new Color(GHOST_COLOR);
  if (m.emissive) {
    m.emissive = new Color(GHOST_COLOR);
    m.emissiveIntensity = 0.4;
  }
  return m;
}

/**
 * Rigged GLB runner. Load failures and missing clips throw so the surrounding
 * error boundary can swap in the procedural runner.
 */
export function AnimatedRunner({ animationScale, running, ghost }: RunnerVisualProps) {
  const gltf = useGLTF(MODEL_URL);

  const clip = useMemo(() => {
    const found = pickRunClip(gltf.animations);
    if (!found) throw new MissingClipError(gltf.animations.map((c) => c.name));
    return stripRootMotion(found);
  }, [gltf.animations]);

  const { model, scale } = useMemo(() => {
    const model = cloneSkinned(gltf.scene);
    model.traverse((obj) => {
      if (!(obj instanceof Mesh)) return;
      obj.castShadow = !ghost;
      if (ghost) {
        obj.material = Array.isArray(obj.material)
          ? obj.material.map(ghostify)
          : ghostify(obj.material);
      }
    });
    // Precise mode applies bone transforms; raw skinned geometry is in different units.
    model.updateMatrixWorld(true);
    const height = new Box3().setFromObject(model, true).getSize(new Vector3()).y;
    return { model, scale: height > 0 ? TARGET_HEIGHT_M / height : 1 };
  }, [gltf.scene, ghost]);

  const mixer = useMemo(() => new AnimationMixer(model), [model]);
  const action = useMemo(() => mixer.clipAction(clip), [mixer, clip]);

  useEffect(() => {
    action.play();
    return () => {
      mixer.stopAllAction();
      mixer.uncacheRoot(model);
    };
  }, [action, mixer, model]);

  useFrame((_, delta) => {
    // Playback speed comes straight from the engine snapshot.
    action.timeScale = running ? animationScale : 0;
    mixer.update(Math.min(delta, 0.05));
  });

  // Model stays at local origin; the outer group owns world position. The GLB faces +Z, the race runs +X.
  return <primitive object={model} scale={scale} rotation={[0, Math.PI / 2, 0]} />;
}
