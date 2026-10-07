import { Component, type ReactNode } from "react";

interface Props {
  onError: (message: string) => void;
  children: ReactNode;
}

/** Catches WebGL scene init/render failures so the HUD and controls stay mounted. */
export class SceneBoundary extends Component<Props, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    this.props.onError(message || "The 3D scene failed to render.");
  }

  render() {
    return this.state.failed ? null : this.props.children;
  }
}

export function hasWebGL(): boolean {
  try {
    const canvas = document.createElement("canvas");
    return Boolean(canvas.getContext("webgl2") ?? canvas.getContext("webgl"));
  } catch {
    return false;
  }
}
