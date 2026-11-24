/**
 * The incremental tree gives the same roots and proofs as the plain RFC 6962
 * functions, and a stretch of a log can be checked from its compact prefix.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { bytesToHex } from "@noble/hashes/utils";
import { MerkleTree, consistencyProof, inclusionProof, leafHash, merkleRoot, rootFromCompactRange, verifyConsistency } from "@mattering/core";

const leaves = Array.from({ length: 70 }, (_, i) => leafHash(Uint8Array.of(i, i >> 8)));
const hex = (xs: Uint8Array[]): string[] => xs.map(bytesToHex);

test("the incremental tree matches the RFC 6962 functions at every size", () => {
  const tree = new MerkleTree();
  for (let n = 0; n <= leaves.length; n++) {
    const prefix = leaves.slice(0, n);
    assert.equal(bytesToHex(tree.root()), bytesToHex(merkleRoot(prefix)), `root ${n}`);
    for (let m = 0; m <= n; m++) assert.deepEqual(hex(tree.consistencyProof(m)), hex(consistencyProof(prefix, m)), `consistency ${m}..${n}`);
    for (let i = 0; i < n; i++) assert.deepEqual(hex(tree.inclusionProof(i)), hex(inclusionProof(prefix, i)), `inclusion ${i} of ${n}`);
    if (n < leaves.length) tree.append(leaves[n]!);
  }
  // Older sizes stay answerable after the tree has grown.
  assert.equal(bytesToHex(tree.root(13)), bytesToHex(merkleRoot(leaves.slice(0, 13))));
  assert.ok(verifyConsistency(13, 70, tree.root(13), tree.root(), tree.consistencyProof(13)));
  assert.throws(() => tree.root(71), RangeError);
});

test("a stretch of the log is checked against the root from its compact prefix", () => {
  const tree = new MerkleTree(leaves);
  for (let from = 0; from <= leaves.length; from++) {
    for (const to of [from, Math.min(from + 1, 70), Math.min(from + 9, 70), 70]) {
      const prefix = tree.compactRange(from);
      const root = rootFromCompactRange(prefix, from, leaves.slice(from, to));
      assert.equal(bytesToHex(root!), bytesToHex(merkleRoot(leaves.slice(0, to))), `${from}..${to}`);
    }
  }
  const prefix = tree.compactRange(37);
  assert.equal(rootFromCompactRange(prefix.slice(1), 37, leaves.slice(37)), undefined, "a prefix of the wrong shape is refused");
  assert.equal(rootFromCompactRange(prefix, 36, leaves.slice(37)), undefined);
  const altered = [...prefix];
  altered[1] = leafHash(Uint8Array.of(99));
  assert.notEqual(bytesToHex(rootFromCompactRange(altered, 37, leaves.slice(37))!), bytesToHex(tree.root()), "a different prefix gives a different root");
});
