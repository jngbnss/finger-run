import {
  PROTOCOL_VERSION,
  STALE_SNAPSHOT_MS,
  type SnapshotMessage,
  type SnapshotPlayer,
} from "./protocol";

interface Received {
  msg: SnapshotMessage;
  receivedAt: number;
}

const KEEP = 6;

/**
 * Client-side snapshot history. Ignores duplicates, out-of-order sequences and
 * other races; interpolates between snapshots by server time and never extrapolates.
 */
export class SnapshotBuffer {
  private items: Received[] = [];

  get raceId(): string | null {
    return this.items[0]?.msg.raceId ?? null;
  }

  latest(): SnapshotMessage | null {
    return this.items[this.items.length - 1]?.msg ?? null;
  }

  lastReceivedAt(): number | null {
    return this.items[this.items.length - 1]?.receivedAt ?? null;
  }

  clear() {
    this.items = [];
  }

  /** Returns false when the snapshot was ignored. */
  push(msg: SnapshotMessage, localNow: number): boolean {
    if (msg.v !== PROTOCOL_VERSION) return false;
    if (this.raceId !== null && msg.raceId !== this.raceId) {
      // A newer race replaces the history.
      this.items = [];
    }
    const last = this.latest();
    if (last && msg.seq <= last.seq) return false;
    this.items.push({ msg, receivedAt: localNow });
    if (this.items.length > KEEP) this.items.shift();
    return true;
  }

  /** True when no snapshot arrived for 1.5s; callers freeze positions. */
  isStale(localNow: number): boolean {
    const at = this.lastReceivedAt();
    return at !== null && localNow - at > STALE_SNAPSHOT_MS;
  }

  /** Player states at a server time, linearly interpolated between snapshots. */
  sample(serverTime: number): SnapshotPlayer[] {
    const n = this.items.length;
    if (n === 0) return [];
    const first = this.items[0].msg;
    const last = this.items[n - 1].msg;
    if (serverTime <= first.serverNow) return first.players;
    if (serverTime >= last.serverNow) return last.players;
    for (let i = n - 1; i > 0; i--) {
      const a = this.items[i - 1].msg;
      const b = this.items[i].msg;
      if (serverTime >= a.serverNow && serverTime <= b.serverNow) {
        return interpolatePlayers(a, b, serverTime);
      }
    }
    return last.players;
  }
}

export function interpolatePlayers(a: SnapshotMessage, b: SnapshotMessage, serverTime: number): SnapshotPlayer[] {
  const span = b.serverNow - a.serverNow;
  const t = span > 0 ? Math.min(1, Math.max(0, (serverTime - a.serverNow) / span)) : 1;
  const before = new Map(a.players.map((p) => [p.userId, p]));
  return b.players.map((pb) => {
    const pa = before.get(pb.userId);
    if (!pa) return pb;
    const lerp = (x: number, y: number) => x + (y - x) * t;
    return {
      ...pb,
      distanceM: lerp(pa.distanceM, pb.distanceM),
      speedMps: lerp(pa.speedMps, pb.speedMps),
      power: lerp(pa.power, pb.power),
      // Status and finish time switch only when the newer snapshot is reached.
      status: t >= 1 ? pb.status : pa.status,
      finishTimeMs: t >= 1 ? pb.finishTimeMs : pa.finishTimeMs,
    };
  });
}
