/**
 * Fetch release material from public drand HTTP relays. The only networked
 * code in the package, and optional: a signature obtained any other way works
 * just as well, because `open` verifies it against the envelope's beacon key.
 */
import { assertRound, verifyRelease, type BeaconInfo, type Release } from "./beacon.ts";
import { MatteringError } from "./errors.ts";

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
