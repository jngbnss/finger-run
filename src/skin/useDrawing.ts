import { useCallback, useEffect, useRef, useState } from "react";
import { makeSkinImage, type SkinImage } from "./skinImage";

export interface DrawingState {
  /** The validated upload, for the banner and preview. */
  url: string | null;
  setUrl: (url: string) => void;
  /** 256px square PNG made from the drawing, worn on the runner. */
  skin: SkinImage | null;
  skinOn: boolean;
  setSkinOn: (on: boolean) => void;
}

/** Owns the drawing's object URLs and revokes them when replaced or unmounted. */
export function useDrawing(): DrawingState {
  const [url, setUrlState] = useState<string | null>(null);
  const [skin, setSkin] = useState<SkinImage | null>(null);
  const [skinOn, setSkinOn] = useState(true);
  const urlRef = useRef<string | null>(null);
  const skinRef = useRef<SkinImage | null>(null);

  const setUrl = useCallback((next: string) => {
    if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    urlRef.current = next;
    setUrlState(next);
  }, []);

  useEffect(() => {
    if (!url) return;
    let cancelled = false;
    makeSkinImage(url)
      .then((made) => {
        if (cancelled) return URL.revokeObjectURL(made.url);
        if (skinRef.current) URL.revokeObjectURL(skinRef.current.url);
        skinRef.current = made;
        setSkin(made);
      })
      .catch(() => {
        // The drawing already decoded once; if the skin cannot be made, keep the banner only.
      });
    return () => {
      cancelled = true;
    };
  }, [url]);

  useEffect(
    () => () => {
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
      if (skinRef.current) URL.revokeObjectURL(skinRef.current.url);
    },
    [],
  );

  return { url, setUrl, skin, skinOn, setSkinOn };
}
