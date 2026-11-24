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

// --- compact ranges ----------------------------------------------------------

/** How many perfect subtrees make up the first `size` leaves: one per set bit. */
function popcount(size: number): number {
  let count = 0;
  for (let n = size; n > 0; n = Math.floor(n / 2)) count += n % 2;
  return count;
}

/**
 * The root of a tree whose first `prefixSize` leaves are given only as their
 * compact range (the roots of the perfect subtrees covering them, largest
 * first, as `MerkleTree.compactRange` returns) and whose remaining leaves are
 * given in full. Undefined if the compact range has the wrong length for
 * `prefixSize`. This is how a verifier checks one stretch of a long log
 * without the entries before it.
 */
export function rootFromCompactRange(prefix: readonly Uint8Array[], prefixSize: number, leafHashes: readonly Uint8Array[]): Uint8Array | undefined {
  if (!Number.isSafeInteger(prefixSize) || prefixSize < 0 || prefix.length !== popcount(prefixSize)) return undefined;
  // A stack of perfect subtrees, sizes strictly decreasing: the binary digits of the count so far.
  const stack: { size: number; hash: Uint8Array }[] = [];
  let remaining = prefixSize;
  for (const hash of prefix) {
    let size = 1;
    while (size * 2 <= remaining) size *= 2;
    stack.push({ size, hash });
    remaining -= size;
  }
  for (const leaf of leafHashes) {
    stack.push({ size: 1, hash: leaf });
    while (stack.length >= 2 && stack.at(-1)!.size === stack.at(-2)!.size) {
      const right = stack.pop()!;
      const left = stack.pop()!;
      stack.push({ size: left.size * 2, hash: nodeHash(left.hash, right.hash) });
    }
  }
  if (stack.length === 0) return sha256(new Uint8Array());
  // RFC 6962 splits off the largest power of two first, so fold from the right.
  let root = stack.at(-1)!.hash;
  for (let i = stack.length - 2; i >= 0; i--) root = nodeHash(stack[i]!.hash, root);
  return root;
}

/**
 * An append-only RFC 6962 tree that keeps the root of every complete perfect
 * subtree, so roots and proofs for any size cost O(log n) hashes rather than
 * rehashing every leaf. Gives the same answers as the functions above.
 */
export class MerkleTree {
  /** levels[l][i] is the root of the 2^l leaves starting at i * 2^l. */
  private readonly levels: Uint8Array[][] = [[]];

  constructor(leafHashes: Iterable<Uint8Array> = []) {
    for (const leaf of leafHashes) this.append(leaf);
  }

  get size(): number {
    return this.levels[0]!.length;
  }

  leaf(index: number): Uint8Array {
    const leaf = this.levels[0]![index];
    if (!leaf) throw new RangeError("leaf index out of range");
    return leaf;
  }

  append(leafHash: Uint8Array): void {
    this.levels[0]!.push(leafHash);
    let level = 0;
    let index = this.levels[0]!.length - 1;
    while (index % 2 === 1) {
      const below = this.levels[level]!;
      (this.levels[level + 1] ??= []).push(nodeHash(below[index - 1]!, below[index]!));
      level += 1;
      index = (index - 1) / 2;
    }
  }

  /** RFC 6962 MTH over leaves [start, end). `start` must be aligned as the RFC's own recursion leaves it. */
  private hash(start: number, end: number): Uint8Array {
    const n = end - start;
    if (n === 0) return sha256(new Uint8Array());
    if ((n & (n - 1)) === 0 && start % n === 0) return this.levels[Math.log2(n)]![start / n]!;
    const k = split(n);
    return nodeHash(this.hash(start, start + k), this.hash(start + k, end));
  }

  private checkSize(size: number): void {
    if (!Number.isSafeInteger(size) || size < 0 || size > this.size) throw new RangeError("tree size out of range");
  }

  root(size = this.size): Uint8Array {
    this.checkSize(size);
    return this.hash(0, size);
  }

  /** Audit path for leaf `index` in the tree of `size`. */
  inclusionProof(index: number, size = this.size): Uint8Array[] {
    this.checkSize(size);
    if (!Number.isSafeInteger(index) || index < 0 || index >= size) throw new RangeError("leaf index out of range");
    const path = (m: number, start: number, end: number): Uint8Array[] => {
      if (end - start === 1) return [];
      const k = split(end - start);
      return m < k ? [...path(m, start, start + k), this.hash(start + k, end)] : [...path(m - k, start + k, end), this.hash(start, start + k)];
    };
    return path(index, 0, size);
  }

  /** Consistency proof from `oldSize` to `size`, as `consistencyProof` gives it. */
  consistencyProof(oldSize: number, size = this.size): Uint8Array[] {
    this.checkSize(size);
    if (!Number.isSafeInteger(oldSize) || oldSize < 0 || oldSize > size) throw new RangeError("old size out of range");
    if (oldSize === 0 || oldSize === size) return [];
    const subproof = (m: number, start: number, end: number, complete: boolean): Uint8Array[] => {
      if (m === end - start) return complete ? [] : [this.hash(start, end)];
      const k = split(end - start);
      return m <= k
        ? [...subproof(m, start, start + k, complete), this.hash(start + k, end)]
        : [...subproof(m - k, start + k, end, false), this.hash(start, start + k)];
    };
    return subproof(oldSize, 0, size, true);
  }

  /** The roots of the perfect subtrees covering the first `size` leaves, largest first. */
  compactRange(size: number): Uint8Array[] {
    this.checkSize(size);
    const out: Uint8Array[] = [];
    let start = 0;
    for (let level = Math.floor(Math.log2(Math.max(size, 1))); level >= 0; level--) {
      const width = 2 ** level;
      if (start + width <= size) {
        out.push(this.levels[level]![start / width]!);
        start += width;
      }
    }
    return out;
  }
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
