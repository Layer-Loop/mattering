/**
 * drand beacon parameters, round/time arithmetic, and verification of release
 * material (a round's BLS signature). Pure: no network access.
 */
import { bls12_381 } from "@noble/curves/bls12-381";
import { sha256 } from "@noble/hashes/sha256";
import { hexToBytes } from "@noble/hashes/utils";
import { MatteringError } from "./errors.ts";

/** The only drand scheme this version supports (quicknet's). */
export const SUPPORTED_SCHEME = "bls-unchained-g1-rfc9380";
const SIGNATURE_DST = "BLS_SIG_BLS12381G1_XMD:SHA-256_SSWU_RO_NUL_";

export interface BeaconInfo {
  /** Lowercase hex chain hash. */
  chainHash: string;
  /** Lowercase hex compressed G2 group public key (96 bytes). */
  publicKey: string;
  scheme: string;
  /** UNIX seconds of round 1. */
  genesisTime: number;
  /** Seconds between rounds. */
  period: number;
}

/** drand mainnet "quicknet", as pinned by drand's own tlock-js defaults. */
export const QUICKNET: BeaconInfo = Object.freeze({
  chainHash: "52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971",
  publicKey:
    "83cf0f2896adee7eb8b5f01fcad3912212c437e0073e911fb90022d3e760183c8c4b450b6a0a6c3ac6a5776a2d1064510d1fec758c921cc22b0e17e63aaf4bcb5ed66304de9cf809bd274ca73bab4af5a6e9c76a4bc09e76eae8991ef5ece45a",
  scheme: SUPPORTED_SCHEME,
  genesisTime: 1692803367,
  period: 3,
});

/** Release material: the beacon's signature for one round. Public once emitted. */
export interface Release {
  round: number;
  /** Lowercase hex compressed G1 signature (48 bytes). */
  signature: string;
}

const HEX = /^[0-9a-f]*$/;
export function isLowerHex(value: unknown, bytes: number): value is string {
  return typeof value === "string" && value.length === bytes * 2 && HEX.test(value);
}

export function assertBeaconInfo(info: unknown, path = "beacon"): asserts info is BeaconInfo {
  const b = info as Partial<BeaconInfo> | null;
  if (b === null || typeof b !== "object") throw new MatteringError("MALFORMED", `${path}: not an object`);
  const keys = Object.keys(b).sort().join(",");
  if (keys !== "chainHash,genesisTime,period,publicKey,scheme") {
    throw new MatteringError("MALFORMED", `${path}: unexpected fields (${keys})`);
  }
  if (!isLowerHex(b.chainHash, 32)) throw new MatteringError("MALFORMED", `${path}.chainHash: want 32 bytes of lowercase hex`);
  if (!isLowerHex(b.publicKey, 96)) throw new MatteringError("MALFORMED", `${path}.publicKey: want 96 bytes of lowercase hex`);
  if (b.scheme !== SUPPORTED_SCHEME) throw new MatteringError("MALFORMED", `${path}.scheme: only ${SUPPORTED_SCHEME} is supported`);
  if (!Number.isSafeInteger(b.genesisTime) || b.genesisTime! < 0) throw new MatteringError("MALFORMED", `${path}.genesisTime`);
  if (!Number.isSafeInteger(b.period) || b.period! < 1) throw new MatteringError("MALFORMED", `${path}.period`);
}

export function assertRound(round: unknown, path = "round"): asserts round is number {
  if (!Number.isSafeInteger(round) || (round as number) < 1) {
    throw new MatteringError("MALFORMED", `${path}: want a positive integer`);
  }
}

export function sameBeacon(a: BeaconInfo, b: BeaconInfo): boolean {
  return (
    a.chainHash === b.chainHash &&
    a.publicKey === b.publicKey &&
    a.scheme === b.scheme &&
    a.genesisTime === b.genesisTime &&
    a.period === b.period
  );
}

/** UNIX seconds at which `round` is scheduled to be emitted. */
export function timeOfRound(info: BeaconInfo, round: number): number {
  return info.genesisTime + (round - 1) * info.period;
}

/** The first round scheduled at or after `unixSeconds`. */
export function firstRoundAtOrAfter(info: BeaconInfo, unixSeconds: number): number {
  if (unixSeconds <= info.genesisTime) return 1;
  return Math.ceil((unixSeconds - info.genesisTime) / info.period) + 1;
}

/** The message a beacon signs for an unchained round: SHA-256(round as u64 big-endian). */
export function roundMessage(round: number): Uint8Array {
  const buf = new Uint8Array(8);
  new DataView(buf.buffer).setBigUint64(0, BigInt(round));
  return sha256(buf);
}

/**
 * True iff `release.signature` is the beacon's BLS signature for
 * `release.round` under `info.publicKey`. This is the check that turns
 * "someone handed me bytes" into "the beacon emitted this round".
 */
export function verifyRelease(info: BeaconInfo, release: Release): boolean {
  if (info.scheme !== SUPPORTED_SCHEME) return false;
  if (!Number.isSafeInteger(release.round) || release.round < 1) return false;
  if (!isLowerHex(release.signature, 48) || !isLowerHex(info.publicKey, 96)) return false;
  try {
    return bls12_381.verifyShortSignature(
      hexToBytes(release.signature),
      roundMessage(release.round),
      hexToBytes(info.publicKey),
      { DST: SIGNATURE_DST },
    );
  } catch {
    return false;
  }
}

export { SIGNATURE_DST as BEACON_SIGNATURE_DST };
