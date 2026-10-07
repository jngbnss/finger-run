import { AnimationClip, PropertyBinding, VectorKeyframeTrack } from "three";

const PREFERRED_CLIPS = ["running", "run", "walking"];
const ROOT_NODE = /root|hips|pelvis/i;

/** Picks Running, then Run, then Walking (case-insensitive; exact name before partial match). */
export function pickRunClip(clips: AnimationClip[]): AnimationClip | null {
  for (const wanted of PREFERRED_CLIPS) {
    const exact = clips.find((c) => c.name.toLowerCase() === wanted);
    if (exact) return exact;
  }
  for (const wanted of PREFERRED_CLIPS) {
    const partial = clips.find((c) => c.name.toLowerCase().includes(wanted));
    if (partial) return partial;
  }
  return null;
}

/**
 * Clones the clip and pins root/hips/pelvis position tracks to their first x and z,
 * keeping y so the runner still bounces but never drifts away from its group.
 */
export function stripRootMotion(clip: AnimationClip): AnimationClip {
  const copy = clip.clone();
  for (const track of copy.tracks) {
    if (!(track instanceof VectorKeyframeTrack)) continue;
    const { nodeName, propertyName } = PropertyBinding.parseTrackName(track.name);
    if (propertyName !== "position" || !ROOT_NODE.test(nodeName ?? "")) continue;
    const values = track.values;
    const x0 = values[0];
    const z0 = values[2];
    for (let i = 0; i < values.length; i += 3) {
      values[i] = x0;
      values[i + 2] = z0;
    }
  }
  return copy;
}
