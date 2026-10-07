import { useRef } from "react";
import { useFrame } from "@react-three/fiber";
import type { Group } from "three";
import { GHOST_COLOR, GHOST_OPACITY, PLAYER_COLOR, type RunnerVisualProps } from "./runnerTypes";

/** Strides per second at animationScale 1. */
const BASE_CADENCE_HZ = 1.4;

/** Stick robot built from primitives; faces +X. Fallback when the GLB is unusable. */
export function ProceduralRunner({ animationScale, running, ghost, tint }: RunnerVisualProps) {
  const body = useRef<Group>(null);
  const leftLeg = useRef<Group>(null);
  const rightLeg = useRef<Group>(null);
  const leftArm = useRef<Group>(null);
  const rightArm = useRef<Group>(null);
  const phase = useRef(0);
  const amplitude = useRef(0);

  useFrame((_, delta) => {
    const dt = Math.min(delta, 0.05);
    const scale = running ? animationScale : 0;
    phase.current += dt * scale * BASE_CADENCE_HZ * Math.PI * 2;
    const targetAmp = scale > 0 ? Math.min(1, 0.45 + scale * 0.25) : 0;
    amplitude.current += (targetAmp - amplitude.current) * Math.min(1, dt * 8);

    const swing = Math.sin(phase.current) * amplitude.current;
    if (leftLeg.current) leftLeg.current.rotation.z = swing * 0.9;
    if (rightLeg.current) rightLeg.current.rotation.z = -swing * 0.9;
    if (leftArm.current) leftArm.current.rotation.z = -swing * 1.1;
    if (rightArm.current) rightArm.current.rotation.z = swing * 1.1;
    if (body.current) {
      body.current.position.y = Math.abs(Math.sin(phase.current)) * 0.08 * amplitude.current;
      body.current.rotation.z = -0.12 * amplitude.current;
    }
  });

  const material = (color: string) => (
    <meshStandardMaterial
      color={color}
      roughness={0.45}
      metalness={0.2}
      transparent={ghost}
      opacity={ghost ? GHOST_OPACITY : 1}
      depthWrite={!ghost}
      emissive={ghost ? GHOST_COLOR : "#000000"}
      emissiveIntensity={ghost ? 0.4 : 0}
    />
  );
  const main = ghost ? GHOST_COLOR : (tint ?? PLAYER_COLOR);
  const joint = ghost ? GHOST_COLOR : "#d9dee8";

  const limb = (length: number) => (
    <mesh position={[0, -length / 2, 0]} castShadow={!ghost}>
      <capsuleGeometry args={[0.07, length - 0.14, 4, 8]} />
      {material(joint)}
    </mesh>
  );

  return (
    <group ref={body}>
      {/* torso */}
      <mesh position={[0, 1.3, 0]} castShadow={!ghost}>
        <boxGeometry args={[0.3, 0.55, 0.42]} />
        {material(main)}
      </mesh>
      {/* head with visor */}
      <mesh position={[0, 1.78, 0]} castShadow={!ghost}>
        <sphereGeometry args={[0.17, 16, 12]} />
        {material(main)}
      </mesh>
      <mesh position={[0.13, 1.8, 0]}>
        <boxGeometry args={[0.08, 0.08, 0.24]} />
        {material(ghost ? GHOST_COLOR : "#1a1f2b")}
      </mesh>
      {/* legs pivot at the hips */}
      <group ref={leftLeg} position={[0, 1.0, 0.11]}>
        {limb(0.95)}
      </group>
      <group ref={rightLeg} position={[0, 1.0, -0.11]}>
        {limb(0.95)}
      </group>
      {/* arms pivot at the shoulders */}
      <group ref={leftArm} position={[0, 1.52, 0.28]}>
        {limb(0.65)}
      </group>
      <group ref={rightArm} position={[0, 1.52, -0.28]}>
        {limb(0.65)}
      </group>
    </group>
  );
}
