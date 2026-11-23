/**
 * Fetch release material from public drand HTTP relays. The only networked
 * code in the package, and optional: a signature obtained any other way works
 * just as well, because `open` verifies it against the envelope's beacon key.
 */
import { assertRound, timeOfRound, verifyRelease, type BeaconInfo, type Release } from "./beacon.ts";
import { MatteringError } from "./errors.ts";
import type { BeaconSource } from "./source.ts";

export const DEFAULT_RELAYS: readonly string[] = ["https://api.drand.sh", "https://drand.cloudflare.com"];

export async function fetchRelease(
  beacon: BeaconInfo,
  round: number,
  relays: readonly string[] = DEFAULT_RELAYS,
  fetchFn: typeof fetch = fetch,
): Promise<Release> {
  assertRound(round);
  const failures: string[] = [];
  for (const relay of relays) {
    const url = `${relay.replace(/\/+$/, "")}/${beacon.chainHash}/public/${round}`;
    try {
      const response = await fetchFn(url, { signal: AbortSignal.timeout(10_000) });
      if (!response.ok) {
        failures.push(`${relay}: HTTP ${response.status}`);
        continue;
      }
      const body = (await response.json()) as { round?: unknown; signature?: unknown };
      const release = { round: Number(body.round), signature: String(body.signature).toLowerCase() };
      if (release.round !== round || !verifyRelease(beacon, release)) {
        failures.push(`${relay}: returned an invalid signature`);
        continue;
      }
      return release;
    } catch (error) {
      failures.push(`${relay}: ${(error as Error).message}`);
    }
  }
  throw new MatteringError(
    "UNAVAILABLE",
    `round ${round} could not be obtained (not yet emitted, or relays unreachable): ${failures.join("; ")}`,
  );
}

/**
 * A beacon source backed by drand relays. `latest` refuses an answer that is
 * far behind the beacon's published schedule by this machine's clock, so a
 * relay (or a network attacker) cannot make it believe it is earlier than it is
 * by replaying an old round.
 */
export function drandSource(beacon: BeaconInfo, relays: readonly string[] = DEFAULT_RELAYS, fetchFn: typeof fetch = fetch, maxLagSeconds = 30): BeaconSource {
  const known = new Map<number, Release>();
  let best: Release | undefined;
  let asked = 0;
  const scheduledRound = (): number => Math.max(1, Math.floor((Date.now() / 1000 - beacon.genesisTime) / beacon.period) + 1);
  const remember = (release: Release): Release => {
    known.set(release.round, release);
    if (!best || release.round > best.round) best = release;
    return release;
  };
  return {
    beacon,
    scheduledRound,
    async latest() {
      // Reuse what we have while the schedule says nothing newer exists, and
      // never ask the relays more than about once a second.
      if (best && (best.round >= scheduledRound() || Date.now() - asked < 900)) return best;
      asked = Date.now();
      const failures: string[] = [];
      for (const relay of relays) {
        try {
          const response = await fetchFn(`${relay.replace(/\/+$/, "")}/${beacon.chainHash}/public/latest`, { signal: AbortSignal.timeout(10_000) });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const body = (await response.json()) as { round?: unknown; signature?: unknown };
          const release = { round: Number(body.round), signature: String(body.signature).toLowerCase() };
          if (!verifyRelease(beacon, release)) throw new Error("invalid signature");
          remember(release);
          break;
        } catch (error) {
          failures.push(`${relay}: ${(error as Error).message}`);
        }
      }
      // Relays cache "latest" and can serve a round or two behind. Ask for the
      // scheduled round by number, which is not subject to that.
      const expected = scheduledRound();
      if (!best || best.round < expected) {
        try {
          remember(await fetchRelease(beacon, expected, relays, fetchFn));
        } catch {
          // not emitted yet, or unreachable; fall through with what we have
        }
      }
      if (!best) throw new MatteringError("UNAVAILABLE", `cannot establish the latest beacon round: ${failures.join("; ")}`);
      if (Date.now() / 1000 - timeOfRound(beacon, best.round) > maxLagSeconds) {
        throw new MatteringError("UNAVAILABLE", "the newest beacon round obtainable is far behind the beacon's schedule");
      }
      return best;
    },
    async get(round) {
      const have = known.get(round);
      if (have) return have;
      if (Date.now() / 1000 < timeOfRound(beacon, round)) return undefined;
      try {
        return remember(await fetchRelease(beacon, round, relays, fetchFn));
      } catch {
        return undefined;
      }
    },
  };
}
