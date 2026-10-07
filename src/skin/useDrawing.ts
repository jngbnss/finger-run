import { useCallback, useEffect, useRef, useState } from "react";
import { CharacterError, makeCharacterDraft, type CharacterDraft } from "../character/makeCharacter";
import { encodeRig, normalizeJoints, type Joints } from "../character/skeleton";
import type { CharacterSkin } from "../scene/DrawnRunner";

/** A confirmed character: cut-out PNG plus joints, ready to race and to share. */
export interface Character extends CharacterSkin {
  blob: Blob;
}

export interface DrawingState {
  /** The validated upload, for the banner and preview. */
  url: string | null;
  setUrl: (url: string) => void;
  /** Cut-out being checked in the joint editor. */
  draft: CharacterDraft | null;
  /** Initial joints/flip for the editor (the confirmed ones when re-editing). */
  editorJoints: Joints | null;
  editorFlip: boolean;
  editing: boolean;
  processing: boolean;
  error: string | null;
  openEditor: () => void;
  closeEditor: () => void;
  confirm: (joints: Joints, flip: boolean) => void;
  /** The drawing as a runner, once the joints are confirmed. */
  character: Character | null;
  /** Whether to race as the drawing (and share it online). */
  skinOn: boolean;
  setSkinOn: (on: boolean) => void;
}

/** Owns the drawing, its cut-out and the confirmed character, and revokes their object URLs. */
export function useDrawing(): DrawingState {
  const [url, setUrlState] = useState<string | null>(null);
  const [draft, setDraft] = useState<CharacterDraft | null>(null);
  const [editing, setEditing] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [character, setCharacter] = useState<Character | null>(null);
  const [saved, setSaved] = useState<{ joints: Joints; flip: boolean } | null>(null);
  const [skinOn, setSkinOn] = useState(true);
  const urlRef = useRef<string | null>(null);
  const draftRef = useRef<CharacterDraft | null>(null);
  const characterUrlRef = useRef<string | null>(null);
  characterUrlRef.current = character?.url ?? null;

  const setUrl = useCallback((next: string) => {
    if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    urlRef.current = next;
    setUrlState(next);
  }, []);

  useEffect(() => {
    if (!url) return;
    let cancelled = false;
    setProcessing(true);
    setError(null);
    makeCharacterDraft(url)
      .then((made) => {
        if (cancelled) return URL.revokeObjectURL(made.url);
        // Drop an unconfirmed older cut-out; a confirmed one stays until it is replaced.
        const old = draftRef.current;
        if (old && old.url !== characterUrlRef.current) URL.revokeObjectURL(old.url);
        draftRef.current = made;
        setDraft(made);
        setSaved(null);
        setEditing(true);
      })
      .catch((e) => !cancelled && setError(e instanceof CharacterError ? e.message : "Could not cut out the drawing."))
      .finally(() => !cancelled && setProcessing(false));
    return () => {
      cancelled = true;
    };
  }, [url]);

  const confirm = useCallback((joints: Joints, flip: boolean) => {
    const d = draftRef.current;
    if (!d) return;
    setSaved({ joints, flip });
    setCharacter((prev) => {
      if (prev && prev.url !== d.url) URL.revokeObjectURL(prev.url);
      return { blob: d.blob, url: d.url, rig: encodeRig(normalizeJoints(joints, d.width, d.height), flip) };
    });
    setEditing(false);
  }, []);

  useEffect(
    () => () => {
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
      if (draftRef.current) URL.revokeObjectURL(draftRef.current.url);
      if (characterUrlRef.current && characterUrlRef.current !== draftRef.current?.url) {
        URL.revokeObjectURL(characterUrlRef.current);
      }
    },
    [],
  );

  return {
    url,
    setUrl,
    draft,
    editorJoints: saved?.joints ?? draft?.joints ?? null,
    editorFlip: saved?.flip ?? false,
    editing: editing && draft !== null,
    processing,
    error,
    openEditor: useCallback(() => setEditing(true), []),
    closeEditor: useCallback(() => setEditing(false), []),
    confirm,
    character,
    skinOn,
    setSkinOn,
  };
}
