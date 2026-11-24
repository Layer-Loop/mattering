/**
 * A party's own view of a beacon: what is the latest round it has seen, and
 * what is the signature for a given round. The witness and each cosigner must
 * use their own source, because "what time is it" is the thing they attest.
 */
import { timeOfRound, type BeaconInfo, type Release } from "./beacon.ts";

export interface BeaconSource {
  readonly beacon: BeaconInfo;
  /** The most recent round this party can obtain, verified. Throws if it cannot tell. */
  latest(): Promise<Release>;
  /** The signature for `round`, verified, or undefined if it has not been emitted. */
  get(round: number): Promise<Release | undefined>;
  /**
   * The round that should be current by this party's own clock and the
   * beacon's published schedule. A relay's idea of "latest" can lag the real
   * beacon by a round or more, so anything that enforces a deadline must use
   * this as well. Absent for beacons with no real schedule.
   */
  scheduledRound?(): number;
}

/**
 * The round to enforce deadlines against: the later of what this party has
 * seen and what its clock says should exist. Being early by a moment is safe
 * for a deadline; being late is not.
 */
export async function deadlineRound(source: BeaconSource): Promise<{ latest: Release; round: number }> {
  const latest = await source.latest();
  return { latest, round: Math.max(latest.round, source.scheduledRound?.() ?? 0) };
}

/** UNIX seconds by this machine's clock. */
export const systemClock = (): number => Math.floor(Date.now() / 1000);

/**
 * A clock that reads time off a beacon source's schedule: the scheduled time
 * of the round that should be current. For simulated beacons in tests and
 * offline demonstrations, where wall-clock time means nothing to the beacon.
 */
export function scheduleClock(source: BeaconSource): () => number {
  return () => (source.scheduledRound ? timeOfRound(source.beacon, source.scheduledRound()) : systemClock());
}
