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
  let cached: { at: number; release: Release } | undefined;
  return {
    beacon,
    async latest() {
      if (cached && Date.now() - cached.at < beacon.period * 1000) return cached.release;
      const failures: string[] = [];
      for (const relay of relays) {
        try {
          const response = await fetchFn(`${relay.replace(/\/+$/, "")}/${beacon.chainHash}/public/latest`, { signal: AbortSignal.timeout(10_000) });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const body = (await response.json()) as { round?: unknown; signature?: unknown };
          const release = { round: Number(body.round), signature: String(body.signature).toLowerCase() };
          if (!verifyRelease(beacon, release)) throw new Error("invalid signature");
          if (Date.now() / 1000 - timeOfRound(beacon, release.round) > maxLagSeconds) throw new Error("stale: far behind the beacon's schedule");
          known.set(release.round, release);
          cached = { at: Date.now(), release };
          return release;
        } catch (error) {
          failures.push(`${relay}: ${(error as Error).message}`);
        }
      }
      throw new MatteringError("UNAVAILABLE", `cannot establish the latest beacon round: ${failures.join("; ")}`);
    },
    async get(round) {
      const have = known.get(round);
      if (have) return have;
      if (Date.now() / 1000 < timeOfRound(beacon, round)) return undefined;
      try {
        const release = await fetchRelease(beacon, round, relays, fetchFn);
        known.set(round, release);
        return release;
      } catch {
        return undefined;
      }
    },
  };
}
