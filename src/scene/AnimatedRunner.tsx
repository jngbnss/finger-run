import { Fragment, useEffect, useMemo } from "react";
import { createPortal, useFrame } from "@react-three/fiber";
import { useGLTF } from "@react-three/drei";
import {
  AnimationMixer,
  Box3,
  Color,
  Matrix4,
  Mesh,
  Quaternion,
  Vector3,
  type Material,
  type Object3D,
  type MeshStandardMaterial,
} from "three";
import { clone as cloneSkinned } from "three/examples/jsm/utils/SkeletonUtils.js";
import { pickRunClip, stripRootMotion } from "./clipUtils";
import { SkinBadge, useSkinTexture } from "./SkinBadge";
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

/** Body material recoloured to a lane colour. */
function tinted(material: Material, color: string): Material {
  const m = material.clone() as MeshStandardMaterial;
  if (m.color) m.color = new Color(color);
  return m;
}

interface BadgePlacement {
  position: Vector3;
  quaternion: Quaternion;
}

interface SkinAnchor {
  bone: Object3D;
  /** Converts the bone's units back to model units. */
  scale: number;
  size: number;
  placements: BadgePlacement[];
}

/**
 * Where the skin goes, expressed in a bone's space so the patch moves with the run
 * animation: the front and back of the torso.
 */
function skinAnchors(model: Object3D): SkinAnchor[] {
  model.updateMatrixWorld(true);
  const toModel = new Matrix4().copy(model.matrixWorld).invert();
  // Names like "Torso" belong to both a bone and the geometry (a group of meshes, one per material).
  const geometry = (name: string) => {
    let found: Object3D | undefined;
    model.traverse((o) => {
      if (!found && o.name === name && !(o as Object3D & { isBone?: boolean }).isBone) found = o;
    });
    return found;
  };

  const anchor = (boneName: string, meshName: string, sizeRatio: number, faces: Array<"front" | "back">) => {
    const bone = model.getObjectByName(boneName);
    const mesh = geometry(meshName);
    if (!bone || !mesh) return null;
    const box = new Box3().setFromObject(mesh, true).applyMatrix4(toModel);
    const center = box.getCenter(new Vector3());
    const extent = box.getSize(new Vector3());
    const boneInModel = new Matrix4().multiplyMatrices(toModel, bone.matrixWorld);
    const toBone = boneInModel.clone().invert();
    const boneRotation = new Quaternion();
    const boneScale = new Vector3();
    boneInModel.decompose(new Vector3(), boneRotation, boneScale);
    const inverseRotation = boneRotation.clone().invert();
    const gap = extent.z * 0.02;
    // The model faces +Z: a front patch faces +Z, a back patch faces -Z.
    const place = (face: "front" | "back"): BadgePlacement => ({
      position: new Vector3(center.x, center.y, face === "front" ? box.max.z + gap : box.min.z - gap).applyMatrix4(toBone),
      quaternion: inverseRotation
        .clone()
        .multiply(new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), face === "front" ? 0 : Math.PI)),
    });
    return {
      bone,
      scale: 1 / boneScale.x,
      size: Math.min(extent.x, extent.y) * sizeRatio,
      placements: faces.map(place),
    };
  };

  return [anchor("Body", "Torso", 0.8, ["front", "back"])].filter(
    (a): a is SkinAnchor => a !== null,
  );
}
/**
 * Rigged GLB runner. Load failures and missing clips throw so the surrounding
 * error boundary can swap in the procedural runner.
 */
export function AnimatedRunner({ animationScale, running, ghost, tint, skinUrl }: RunnerVisualProps) {
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
      } else if (tint) {
        const recolor = (m: Material) => (m.name === "Main" ? tinted(m, tint) : m);
        obj.material = Array.isArray(obj.material) ? obj.material.map(recolor) : recolor(obj.material);
      }
    });
    // Precise mode applies bone transforms; raw skinned geometry is in different units.
    model.updateMatrixWorld(true);
    const height = new Box3().setFromObject(model, true).getSize(new Vector3()).y;
    return { model, scale: height > 0 ? TARGET_HEIGHT_M / height : 1 };
  }, [gltf.scene, ghost, tint]);

  const anchors = useMemo(() => skinAnchors(model), [model]);
  const skin = useSkinTexture(ghost ? null : skinUrl);

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
  return (
    <>
      <primitive object={model} scale={scale} rotation={[0, Math.PI / 2, 0]} />
      {skin &&
        anchors.map((anchor, a) => (
          <Fragment key={a}>
            {createPortal(
            <>
              {anchor.placements.map((p, i) => (
                <group key={i} position={p.position} quaternion={p.quaternion} scale={anchor.scale}>
                  <SkinBadge texture={skin} size={anchor.size} frameColor={tint} />
                </group>
              ))}
            </>,
            anchor.bone,
            )}
          </Fragment>
        ))}
    </>
  );
}
