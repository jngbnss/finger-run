export interface ClockSample {
  /** Local time when the request was sent. */
  t0: number;
  /** Server time reported by server_now(). */
  server: number;
  /** Local time when the response arrived. */
  t1: number;
}

/**
 * Offset to add to local time to get server time, from the sample with the
 * shortest round trip (midpoint method).
 */
export function clockOffset(samples: ClockSample[]): { offsetMs: number; rttMs: number } {
  const valid = samples.filter(
    (s) => Number.isFinite(s.t0) && Number.isFinite(s.t1) && Number.isFinite(s.server) && s.t1 >= s.t0,
  );
  if (valid.length === 0) return { offsetMs: 0, rttMs: Number.POSITIVE_INFINITY };
  const best = valid.reduce((a, b) => (b.t1 - b.t0 < a.t1 - a.t0 ? b : a));
  return { offsetMs: best.server - (best.t0 + best.t1) / 2, rttMs: best.t1 - best.t0 };
}

export const CLOCK_SAMPLES = 5;

export async function measureClockOffset(
  serverNow: () => Promise<number>,
  localNow: () => number,
  count = CLOCK_SAMPLES,
): Promise<{ offsetMs: number; rttMs: number }> {
  const samples: ClockSample[] = [];
  for (let i = 0; i < count; i++) {
    const t0 = localNow();
    const server = await serverNow();
    samples.push({ t0, server, t1: localNow() });
  }
  return clockOffset(samples);
}
