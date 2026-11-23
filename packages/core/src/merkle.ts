/**
 * Merkle tree hashing and inclusion proofs exactly as in RFC 6962 section 2.1
 * (Certificate Transparency), with SHA-256. Nothing here is new.
 */
import { sha256 } from "@noble/hashes/sha256";
import { concatBytes } from "@noble/hashes/utils";

export function leafHash(leaf: Uint8Array): Uint8Array {
  return sha256(concatBytes(Uint8Array.of(0x00), leaf));
}

function nodeHash(left: Uint8Array, right: Uint8Array): Uint8Array {
  return sha256(concatBytes(Uint8Array.of(0x01), left, right));
}

/** Largest power of two strictly less than n (n > 1). */
function split(n: number): number {
  let k = 1;
  while (k * 2 < n) k *= 2;
  return k;
}

/** Root over leaf hashes. The empty tree's root is SHA-256 of the empty string. */
export function merkleRoot(leafHashes: readonly Uint8Array[]): Uint8Array {
  const n = leafHashes.length;
  if (n === 0) return sha256(new Uint8Array());
  if (n === 1) return leafHashes[0]!;
  const k = split(n);
  return nodeHash(merkleRoot(leafHashes.slice(0, k)), merkleRoot(leafHashes.slice(k)));
}

/** Audit path for leaf `index` in the tree over `leafHashes`. */
export function inclusionProof(leafHashes: readonly Uint8Array[], index: number): Uint8Array[] {
  const n = leafHashes.length;
  if (index < 0 || index >= n) throw new RangeError("leaf index out of range");
  if (n === 1) return [];
  const k = split(n);
  return index < k
    ? [...inclusionProof(leafHashes.slice(0, k), index), merkleRoot(leafHashes.slice(k))]
    : [...inclusionProof(leafHashes.slice(k), index - k), merkleRoot(leafHashes.slice(0, k))];
}

/** Recompute the root implied by an audit path (RFC 9162 section 2.1.3.2). */
export function rootFromInclusionProof(
  leaf: Uint8Array,
  index: number,
  size: number,
  proof: readonly Uint8Array[],
): Uint8Array | undefined {
  if (!Number.isSafeInteger(index) || !Number.isSafeInteger(size) || index < 0 || index >= size) return undefined;
  let fn = index;
  let sn = size - 1;
  let r = leaf;
  for (const p of proof) {
    if (sn === 0) return undefined;
    if (fn % 2 === 1 || fn === sn) {
      r = nodeHash(p, r);
      if (fn % 2 === 0) {
        while (fn % 2 === 0 && fn !== 0) {
          fn = Math.floor(fn / 2);
          sn = Math.floor(sn / 2);
        }
      }
    } else {
      r = nodeHash(r, p);
    }
    fn = Math.floor(fn / 2);
    sn = Math.floor(sn / 2);
  }
  return sn === 0 ? r : undefined;
}
