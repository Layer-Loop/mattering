/**
 * TEST ONLY. A local beacon with its own BLS key, so tests can exercise the
 * real time-lock cryptography offline: a round's ciphertext genuinely cannot
 * be opened until this object signs that round.
 *
 * Whoever holds `secretHex` can open every seal made to this beacon at any
 * time. It is never in `DEFAULT_POLICY`; a verifier must opt in explicitly.
 */
import { bls12_381 } from "@noble/curves/bls12-381";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils";
import { BEACON_SIGNATURE_DST, roundMessage, SUPPORTED_SCHEME, type BeaconInfo, type Release } from "./beacon.ts";
import { hashLabelled } from "./canonical.ts";
import type { BeaconSource } from "./source.ts";

export class TestBeacon {
  readonly secretHex: string;
  readonly info: BeaconInfo;

  constructor(secretHex?: string) {
    this.secretHex = secretHex ?? bytesToHex(bls12_381.utils.randomPrivateKey());
    const publicKey = bls12_381.getPublicKeyForShortSignatures(hexToBytes(this.secretHex));
    this.info = Object.freeze({
      chainHash: bytesToHex(hashLabelled("mattering/test-beacon/v1", publicKey)),
      publicKey: bytesToHex(publicKey),
      scheme: SUPPORTED_SCHEME,
      // Rounds have no real schedule: a round is "emitted" when release() is called.
      genesisTime: 1,
      period: 1,
    });
  }

  /** Emit a round: sign it exactly as a drand quicknet-scheme beacon would. */
  release(round: number): Release {
    const signature = bls12_381.signShortSignature(roundMessage(round), hexToBytes(this.secretHex), {
      DST: BEACON_SIGNATURE_DST,
    });
    return { round, signature: bytesToHex(signature) };
  }
}

/**
 * TEST ONLY. Simulated time for a test beacon: `now` is the latest round that
 * "has been emitted". Each party in a test gets its own view via `source()`.
 */
export class TestClock {
  now: number;
  constructor(readonly testBeacon: TestBeacon, now = 1) {
    this.now = now;
  }
  advanceTo(round: number): void {
    if (round < this.now) throw new Error("time does not go backwards");
    this.now = round;
  }
  source(): BeaconSource {
    return {
      beacon: this.testBeacon.info,
      latest: async () => this.testBeacon.release(this.now),
      get: async (round) => (round <= this.now ? this.testBeacon.release(round) : undefined),
    };
  }
}
