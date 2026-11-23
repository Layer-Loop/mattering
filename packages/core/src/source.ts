/**
 * A party's own view of a beacon: what is the latest round it has seen, and
 * what is the signature for a given round. The witness and each cosigner must
 * use their own source, because "what time is it" is the thing they attest.
 */
import type { BeaconInfo, Release } from "./beacon.ts";

export interface BeaconSource {
  readonly beacon: BeaconInfo;
  /** The most recent round this party can obtain, verified. Throws if it cannot tell. */
  latest(): Promise<Release>;
  /** The signature for `round`, verified, or undefined if it has not been emitted. */
  get(round: number): Promise<Release | undefined>;
}
