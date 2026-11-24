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

/**
 * Consistency proof that the tree over the first `oldSize` leaves is a prefix
 * of the tree over all `leafHashes` (RFC 6962 section 2.1.2, SUBPROOF).
 * Empty when `oldSize` is 0 or equals the tree size.
 */
export function consistencyProof(leafHashes: readonly Uint8Array[], oldSize: number): Uint8Array[] {
  const n = leafHashes.length;
  if (!Number.isSafeInteger(oldSize) || oldSize < 0 || oldSize > n) throw new RangeError("old size out of range");
  if (oldSize === 0 || oldSize === n) return [];
  const subproof = (m: number, leaves: readonly Uint8Array[], complete: boolean): Uint8Array[] => {
    const size = leaves.length;
    if (m === size) return complete ? [] : [merkleRoot(leaves)];
    const k = split(size);
    return m <= k
      ? [...subproof(m, leaves.slice(0, k), complete), merkleRoot(leaves.slice(k))]
      : [...subproof(m - k, leaves.slice(k), false), merkleRoot(leaves.slice(0, k))];
  };
  return subproof(oldSize, leafHashes, true);
}

/**
 * True iff `proof` shows the tree of `oldSize` with `oldRoot` is a prefix of
 * the tree of `newSize` with `newRoot` (RFC 9162 section 2.1.4.2, the same
 * proofs as RFC 6962). An old size of 0 is consistent with anything, given an
 * empty proof; equal sizes need equal roots and an empty proof.
 */
export function verifyConsistency(oldSize: number, newSize: number, oldRoot: Uint8Array, newRoot: Uint8Array, proof: readonly Uint8Array[]): boolean {
  if (!Number.isSafeInteger(oldSize) || !Number.isSafeInteger(newSize) || oldSize < 0 || oldSize > newSize) return false;
  const equal = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((x, i) => x === b[i]);
  if (oldSize === 0) return proof.length === 0;
  if (oldSize === newSize) return proof.length === 0 && equal(oldRoot, newRoot);
  const path = [...proof];
  // If the old size is a power of two, the old root is the first node of the path.
  if (Number.isInteger(Math.log2(oldSize))) path.unshift(oldRoot);
  if (path.length === 0) return false;
  let fn = oldSize - 1;
  let sn = newSize - 1;
  while (fn % 2 === 1) {
    fn = Math.floor(fn / 2);
    sn = Math.floor(sn / 2);
  }
  let fr = path[0]!;
  let sr = path[0]!;
  for (const c of path.slice(1)) {
    if (sn === 0) return false;
    if (fn % 2 === 1 || fn === sn) {
      fr = nodeHash(c, fr);
      sr = nodeHash(c, sr);
      if (fn % 2 === 0) {
        while (fn % 2 === 0 && fn !== 0) {
          fn = Math.floor(fn / 2);
          sn = Math.floor(sn / 2);
        }
      }
    } else {
      sr = nodeHash(sr, c);
    }
    fn = Math.floor(fn / 2);
    sn = Math.floor(sn / 2);
  }
  return sn === 0 && equal(fr, oldRoot) && equal(sr, newRoot);
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
