/**
 * Pedersen commitments to an integer amount on Ristretto255.
 *
 *   C = amount·B + blinding·B'
 *
 * B is the Ristretto255 basepoint and B' is the hash-to-group of SHA3-512 of
 * B's encoding. These are the generators of the dalek `bulletproofs` crate's
 * `PedersenGens::default()`, chosen so that a range proof from that library
 * could later be verified against commitments made today. No range proof is
 * implemented here.
 */
import { ed25519, RistrettoPoint } from "@noble/curves/ed25519";
import { sha3_512 } from "@noble/hashes/sha3";
import { bytesToHex, randomBytes } from "@noble/hashes/utils";
import { isLowerHex } from "./beacon.ts";
import { MatteringError } from "./errors.ts";

const ORDER = ed25519.CURVE.n;
const B = RistrettoPoint.BASE;
const B_BLINDING = RistrettoPoint.hashToCurve(sha3_512(B.toRawBytes()));

/** Exposed so a test can pin it to the value published for the Rust library. */
export const BLINDING_GENERATOR_HEX = B_BLINDING.toHex();

/** A fresh blinding factor: 32 bytes of lowercase hex, a scalar in [1, order). */
export function randomBlinding(): string {
  for (;;) {
    const scalar = BigInt("0x" + bytesToHex(randomBytes(64))) % ORDER;
    if (scalar !== 0n) return scalar.toString(16).padStart(64, "0");
  }
}

function blindingScalar(blinding: string): bigint {
  if (!isLowerHex(blinding, 32)) throw new MatteringError("MALFORMED", "blinding: want 32 bytes of lowercase hex");
  const scalar = BigInt("0x" + blinding);
  if (scalar === 0n || scalar >= ORDER) throw new MatteringError("MALFORMED", "blinding: not a canonical non-zero scalar");
  return scalar;
}

/** Commit to `amount` (a non-negative safe integer). Returns the point as hex. */
export function commit(amount: number, blinding: string): string {
  if (!Number.isSafeInteger(amount) || amount < 0) throw new MatteringError("MALFORMED", "amount: want a non-negative integer");
  const blind = B_BLINDING.multiply(blindingScalar(blinding));
  return (amount === 0 ? blind : B.multiply(BigInt(amount)).add(blind)).toHex();
}

/** True iff `commitment` is exactly the commitment to (`amount`, `blinding`). */
export function opensTo(commitment: unknown, amount: number, blinding: string): boolean {
  if (!isLowerHex(commitment, 32)) return false;
  try {
    return commit(amount, blinding) === commitment;
  } catch {
    return false;
  }
}

export function isCommitment(value: unknown): value is string {
  if (!isLowerHex(value, 32)) return false;
  try {
    return RistrettoPoint.fromHex(value).toHex() === value;
  } catch {
    return false;
  }
}
