import { createBridgeClient } from "../testing/bridgeClient";
import { getTestHooks } from "../testing/testHooks";
import { SupabaseRoomBackend, SupabaseTransport, getSupabase } from "./supabase";
import type { RealtimeTransport, RoomBackend } from "./transport";

/**
 * Picks the realtime backend: the Playwright bridge when a test injected it,
 * otherwise Supabase when configured, otherwise null (ONLINE is disabled).
 */
export function createRealtimeDeps(): { backend: RoomBackend; transport: RealtimeTransport } | null {
  if (getTestHooks()?.realtime === "bridge") return createBridgeClient();
  const sb = getSupabase();
  if (!sb) return null;
  return { backend: new SupabaseRoomBackend(sb), transport: new SupabaseTransport(sb) };
}
