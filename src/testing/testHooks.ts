/**
 * Dependency injection for automated browser tests. Playwright installs
 * `window.__FINGER_RUN_TEST__` with an init script before the app loads; there is
 * no query string or UI that turns any of this on for normal visitors.
 */
export interface TestHooks {
  camera?: { mode: "synthetic"; amplitude?: number; hz?: number } | { mode: "deny" };
  /** Use the in-test realtime bridge (fake Supabase served by the Playwright process). */
  realtime?: "bridge";
}

declare global {
  interface Window {
    __FINGER_RUN_TEST__?: TestHooks;
  }
}

export function getTestHooks(): TestHooks | null {
  return typeof window !== "undefined" ? (window.__FINGER_RUN_TEST__ ?? null) : null;
}
