/**
 * Phase 2: witness log, commitments and the sealed-bid auction, with cheating
 * bidders, a cheating witness and a cheating coordinator. Offline.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils";
import {
  BLINDING_GENERATOR_HEX,
  MatteringError,
  POLICY_FORMAT,
  Witness,
  canonicalBytes,
  commit,
  envelopeId,
  generateKeyPair,
  inclusionProof,
  isEquivocation,
  leafHash,
  merkleRoot,
  open,
  opensTo,
  policyHash,
  prepareBid,
  randomBlinding,
  receiptHonoured,
  rootFromInclusionProof,
  sameOutcome,
  seal,
  signSubmission,
  verifyAuction,
  verifyCheckpointSignature,
  verifyReceipt,
  verifySealedSubmission,
  type AuctionInputs,
  type AuctionPolicy,
  type Envelope,
  type KeyPair,
  type PreparedBid,
  type VerifierPolicy,
} from "@mattering/core";
import { TestBeacon } from "@mattering/core/testing";

const beacon = new TestBeacon("2b7e151628aed2a6abf7158809cf4f3c2b7e151628aed2a6abf7158809cf4f3c");
const verifier: VerifierPolicy = { acceptedBeacons: [beacon.info] };
const CLOSE = 500;
const RELEASE = 510;

function makePolicy(witness: Witness, auctionId = "gpu-hours-lot-1"): AuctionPolicy {
  return { format: POLICY_FORMAT, auctionId, beacon: beacon.info, closeRound: CLOSE, releaseRound: RELEASE, witness: witness.publicKey, cosigners: [], cosignerThreshold: 0, minBid: 100, maxBid: 10_000, rule: "highest-bid", tieBreak: "release-round-signature" };
}

interface World {
  witness: Witness;
  policy: AuctionPolicy;
  keys: KeyPair[];
  envelopes: Map<string, Envelope>;
  prepared: PreparedBid[];
}

/** Run an honest auction up to (not including) the close. */
async function world(amounts: number[]): Promise<World> {
  const witness = new Witness();
  const policy = makePolicy(witness);
  const keys = amounts.map(() => generateKeyPair());
  const envelopes = new Map<string, Envelope>();
  const prepared: PreparedBid[] = [];
  for (const [i, amount] of amounts.entries()) {
    const bid = await prepareBid(policy, amount, keys[i]!);
    witness.submit(bid.submission);
    envelopes.set(bid.submission.envelopeId, bid.envelope);
    prepared.push(bid);
  }
  return { witness, policy, keys, envelopes, prepared };
}

function close(w: World): AuctionInputs {
  const closing = w.witness.close(policyHash(w.policy), beacon.info, beacon.release(CLOSE));
  return { policy: w.policy, entries: w.witness.entries(), closing, envelopes: w.envelopes, release: beacon.release(RELEASE) };
}

// --- building blocks -----------------------------------------------------------

test("Merkle tree matches the Certificate Transparency reference vectors", () => {
  const leaves = ["", "00", "10", "2021", "3031", "40414243", "5051525354555657", "606162636465666768696a6b6c6d6e6f"].map((h) => leafHash(hexToBytes(h)));
  const roots = [
    "6e340b9cffb37a989ca544e6bb780a2c78901d3fb33738768511a30617afa01d",
    "fac54203e7cc696cf0dfcb42c92a1d9dbaf70ad9e621f4bd8d98662f00e3c125",
    "aeb6bcfe274b70a14fb067a5e5578264db0fa9b51af5e0ba159158f329e06e77",
    "d37ee418976dd95753c1c73862b9398fa2a2cf9b4ff0fdfe8b30cd95209614b7",
    "4e3bbb1f7b478dcfe71fb631631519a3bca12c9aefca1612bfce4c13a86264d4",
    "76e67dadbcdf1e10e1b74ddc608abd2f98dfb16fbce75277b5232a127f2087ef",
    "ddb89be403809e325750d3d263cd78929c2942b7942a34b77e122c9594a74c8c",
    "5dc9da79a70659a9ad559cb701ded9a2ab9d823aad2f4960cfe370eff4604328",
  ];
  roots.forEach((root, i) => assert.equal(bytesToHex(merkleRoot(leaves.slice(0, i + 1))), root, `size ${i + 1}`));
  for (let size = 1; size <= leaves.length; size++) {
    const tree = leaves.slice(0, size);
    for (let index = 0; index < size; index++) {
      const proof = inclusionProof(tree, index);
      assert.equal(bytesToHex(rootFromInclusionProof(tree[index]!, index, size, proof)!), roots[size - 1]);
      if (size > 1) {
        const other = tree[(index + 1) % size]!;
        assert.notEqual(bytesToHex(rootFromInclusionProof(other, index, size, proof) ?? new Uint8Array()), roots[size - 1]);
        const truncated = rootFromInclusionProof(tree[index]!, index, size, proof.slice(1));
        assert.notEqual(truncated && bytesToHex(truncated), roots[size - 1]);
      }
    }
  }
});

test("commitments: generator matches the Rust bulletproofs library, opens only to its own values", () => {
  assert.equal(BLINDING_GENERATOR_HEX, "8c9240b456a9e6dc65c377a1048d745f94a08cdb7f44cbcd7b46f34048871134");
  const r = randomBlinding();
  const c = commit(4200, r);
  assert.equal(opensTo(c, 4200, r), true);
  assert.equal(opensTo(c, 4201, r), false);
  assert.equal(opensTo(c, 4200, randomBlinding()), false);
  assert.notEqual(commit(4200, randomBlinding()), c, "hiding: same amount, different commitment");
  assert.equal(opensTo(commit(0, r), 0, r), true);
  assert.throws(() => commit(-1, r), MatteringError);
  assert.throws(() => commit(1.5, r), MatteringError);
  assert.equal(opensTo(c, 4200, "00".repeat(32)), false);
});

// --- the honest auction ----------------------------------------------------------

test("three bidders: highest valid bid wins, and the result is reproducible", async () => {
  const w = await world([3100, 4200, 2750]);
  const inputs = close(w);
  const result = await verifyAuction(inputs, verifier);
  assert.equal(result.ok, true, JSON.stringify(result.checks));
  assert.deepEqual(result.bids.map((b) => [b.status, b.amount]), [["valid", 3100], ["valid", 4200], ["valid", 2750]]);
  assert.equal(result.winner?.submitter, w.keys[1]!.publicKey);
  assert.equal(result.winner?.amount, 4200);
  assert.deepEqual(await verifyAuction(inputs, verifier), result);
});

test("before release: submissions can be checked, bids cannot be read", async () => {
  const w = await world([3100, 4200, 2750]);
  for (const bid of w.prepared) {
    assert.equal(verifySealedSubmission(w.policy, bid.submission, bid.envelope, verifier).every((c) => c.ok), true);
    assert.equal(JSON.stringify([bid.envelope, bid.submission]).includes("blinding"), false);
    await assert.rejects(open(bid.envelope, beacon.release(CLOSE), verifier), MatteringError);
    await assert.rejects(open(bid.envelope, { round: RELEASE, signature: beacon.release(RELEASE - 1).signature }, verifier), MatteringError);
  }
  // The adjudicator cannot run early either.
  const early = await verifyAuction({ ...close(w), release: beacon.release(RELEASE - 1) }, verifier);
  assert.equal(early.ok, false);
  assert.deepEqual(early.bids, []);
});

test("bidders vanish after submitting: the auction still resolves", async () => {
  const w = await world([3100, 4200, 2750]);
  // Nothing held by any bidder is used from here on: only the log, the envelopes and the beacon.
  const inputs: AuctionInputs = JSON.parse(JSON.stringify({ ...close(w), envelopes: Object.fromEntries(w.envelopes) }));
  const result = await verifyAuction(inputs, verifier);
  assert.equal(result.ok, true);
  assert.equal(result.winner?.amount, 4200);
});

test("ties are broken by the release round's signature, not by arrival order", async () => {
  const w = await world([4200, 4200, 4200]);
  const result = await verifyAuction(close(w), verifier);
  assert.equal(result.ok, true);
  assert.equal(result.winner?.amount, 4200);
  // Same bids, reversed arrival order: the same envelope still wins.
  // The same three sealed bids arriving in the opposite order: the same envelope wins.
  const second = new Witness();
  const policy2 = { ...w.policy, witness: second.publicKey };
  void policy2;
  const reordered = { ...close(w), entries: [...w.witness.entries()].reverse() };
  assert.equal((await verifyAuction(reordered, verifier)).ok, false, "reordering a signed log breaks the checkpoint");
  const winners = new Set<string>();
  for (const order of [[0, 1, 2], [2, 1, 0], [1, 2, 0]]) {
    const again = new Witness(w.witness.keys.secretKey);
    for (const i of order) again.submit(w.prepared[i]!.submission);
    const closing = again.close(policyHash(w.policy), beacon.info, beacon.release(CLOSE));
    const r = await verifyAuction({ policy: w.policy, entries: again.entries(), closing, envelopes: w.envelopes, release: beacon.release(RELEASE) }, verifier);
    winners.add(r.winner!.envelopeId);
  }
  assert.equal(winners.size, 1);
});

// --- cheating bidders ------------------------------------------------------------

test("boundary bids are valid; out-of-range bids are invalid and attributable", async () => {
  const w = await world([100, 10_000, 99, 10_001]);
  const result = await verifyAuction(close(w), verifier);
  assert.equal(result.ok, true);
  assert.deepEqual(result.bids.map((b) => b.status), ["valid", "valid", "invalid", "invalid"]);
  assert.equal(result.bids[3]!.reason, "amount is outside the permitted range");
  assert.equal(result.bids[3]!.submitter, w.keys[3]!.publicKey);
  assert.equal(result.winner?.amount, 10_000);
});

test("substitution: a commitment to X beside a ciphertext for Y is caught at opening", async () => {
  const w = await world([3000]);
  const cheat = generateKeyPair();
  const real = await prepareBid(w.policy, 9000, cheat);
  // Publish a commitment to 150 while the sealed bid says 9000.
  const submission = signSubmission({ policyHash: policyHash(w.policy), envelopeId: real.submission.envelopeId, commitment: commit(150, randomBlinding()) }, cheat);
  // Still sealed, nobody can tell. This is the binding gap the docs describe.
  assert.equal(verifySealedSubmission(w.policy, submission, real.envelope, verifier).every((c) => c.ok), true);
  w.witness.submit(submission);
  w.envelopes.set(submission.envelopeId, real.envelope);
  const result = await verifyAuction(close(w), verifier);
  assert.equal(result.bids[1]!.status, "invalid");
  assert.equal(result.bids[1]!.reason, "commitment does not match the sealed amount");
  assert.equal(result.winner?.amount, 3000);
});

test("replay: a submission from auction A does not count in auction B", async () => {
  const a = await world([4200]);
  const witnessB = a.witness;
  const policyB = makePolicy(witnessB, "a-different-lot");
  const keysB = generateKeyPair();
  const honest = await prepareBid(policyB, 1000, keysB);
  witnessB.submit(honest.submission);
  // Replay 1: the original signed submission, verbatim. It names policy A, so B ignores it.
  // Replay 2: a thief re-signs A's envelope as their own entry in B.
  const thief = generateKeyPair();
  const lifted = signSubmission({ policyHash: policyHash(policyB), envelopeId: a.prepared[0]!.submission.envelopeId, commitment: a.prepared[0]!.submission.commitment! }, thief);
  witnessB.submit(lifted);
  const envelopes = new Map([...a.envelopes, [honest.submission.envelopeId, honest.envelope]]);
  const closing = witnessB.close(policyHash(policyB), beacon.info, beacon.release(CLOSE));
  const result = await verifyAuction({ policy: policyB, entries: witnessB.entries(), closing, envelopes, release: beacon.release(RELEASE) }, verifier);
  assert.equal(result.ok, true);
  assert.equal(result.bids.length, 2, "A's own submission is not an entry in B");
  assert.equal(result.bids[1]!.status, "invalid");
  assert.equal(result.winner?.submitter, keysB.publicKey);
});

test("copying: resubmitting a rival's sealed bid under your own key is invalid", async () => {
  const w = await world([4200, 3000]);
  const copier = generateKeyPair();
  const victim = w.prepared[0]!;
  const copy = signSubmission({ policyHash: policyHash(w.policy), envelopeId: victim.submission.envelopeId, commitment: victim.submission.commitment! }, copier);
  w.witness.submit(copy);
  const result = await verifyAuction(close(w), verifier);
  assert.equal(result.ok, true);
  assert.equal(result.bids[2]!.status, "invalid");
  assert.equal(result.winner?.submitter, w.keys[0]!.publicKey, "the original bidder still wins");

  // If the copy reaches the log first, the copier still gains nothing and cannot
  // get the genuine bid thrown out as a "duplicate".
  const w2 = new Witness();
  const p2 = makePolicy(w2);
  const alice = generateKeyPair();
  const bid = await prepareBid(p2, 4200, alice);
  w2.submit(signSubmission({ policyHash: policyHash(p2), envelopeId: bid.submission.envelopeId, commitment: bid.submission.commitment! }, copier));
  w2.submit(bid.submission);
  const r2 = await verifyAuction({ policy: p2, entries: w2.entries(), closing: w2.close(policyHash(p2), beacon.info, beacon.release(CLOSE)), envelopes: { [bid.submission.envelopeId]: bid.envelope }, release: beacon.release(RELEASE) }, verifier);
  assert.deepEqual(r2.bids.map((b) => b.status), ["invalid", "valid"]);
  assert.equal(r2.winner?.submitter, alice.publicKey);
});

test("one bid per bidder: a second submission by the same key does not count", async () => {
  const w = await world([3000]);
  const second = await prepareBid(w.policy, 9000, w.keys[0]!);
  w.witness.submit(second.submission);
  w.envelopes.set(second.submission.envelopeId, second.envelope);
  const result = await verifyAuction(close(w), verifier);
  assert.deepEqual(result.bids.map((b) => b.status), ["valid", "invalid"]);
  assert.equal(result.winner?.amount, 3000);
});

test("garbage in a well-formed envelope is invalid, not fatal", async () => {
  const w = await world([3000]);
  const troll = generateKeyPair();
  const hash = policyHash(w.policy);
  const envelope = await seal({ payload: new TextEncoder().encode("not a bid"), round: RELEASE, beacon: beacon.info, context: { kind: "mattering.bid/1", policyHash: hash, bidder: troll.publicKey } });
  w.witness.submit(signSubmission({ policyHash: hash, envelopeId: envelopeId(envelope), commitment: commit(5000, randomBlinding()) }, troll));
  w.envelopes.set(envelopeId(envelope), envelope);
  const wrongRound = generateKeyPair();
  const late = await seal({ payload: canonicalBytes({ x: 1 }), round: RELEASE + 50, beacon: beacon.info, context: { kind: "mattering.bid/1", policyHash: hash, bidder: wrongRound.publicKey } });
  w.witness.submit(signSubmission({ policyHash: hash, envelopeId: envelopeId(late), commitment: commit(5000, randomBlinding()) }, wrongRound));
  w.envelopes.set(envelopeId(late), late);
  const result = await verifyAuction(close(w), verifier);
  assert.equal(result.ok, true);
  assert.deepEqual(result.bids.map((b) => b.status), ["valid", "invalid", "invalid"]);
  assert.match(result.bids[2]!.reason!, /round-as-expected/);
});

// --- deadlines and the witness ---------------------------------------------------

test("late submissions are refused by the witness, on the beacon's clock and not the bidder's", async () => {
  const w = await world([3000]);
  close(w);
  const late = await prepareBid(w.policy, 9999, generateKeyPair());
  assert.throws(() => w.witness.submit(late.submission), (e: unknown) => e instanceof MatteringError && e.code === "POLICY");
});

test("an entry appended after the closing checkpoint does not count", async () => {
  const w = await world([3000]);
  const inputs = close(w);
  const late = await prepareBid(w.policy, 9999, generateKeyPair());
  const padded = { ...inputs, entries: [...inputs.entries, late.submission], envelopes: new Map([...w.envelopes, [late.submission.envelopeId, late.envelope]]) };
  const result = await verifyAuction(padded, verifier);
  assert.equal(result.ok, true);
  assert.equal(result.bids.length, 1);
  assert.equal(result.winner?.amount, 3000);
});

test("a witness cannot close early: the closing checkpoint must cite the close round", async () => {
  const w = await world([3000]);
  const hash = policyHash(w.policy);
  const early = w.witness.checkpoint(beacon.info, beacon.release(CLOSE - 100), hash);
  const result = await verifyAuction({ ...close(w), closing: early }, verifier);
  assert.equal(result.ok, false);
  assert.equal(result.checks.find((c) => c.name === "closed-at-the-close-round")?.ok, false);
  assert.throws(() => w.witness.checkpoint(beacon.info, { round: CLOSE, signature: beacon.release(CLOSE - 1).signature }, hash), MatteringError);
});

test("receipts: valid ones verify, and a dropped entry is provable", async () => {
  const witness = new Witness();
  const policy = makePolicy(witness);
  const bids = await Promise.all([3000, 4200, 2000].map((a) => prepareBid(policy, a, generateKeyPair())));
  const receipts = bids.map((b) => witness.submit(b.submission));
  bids.forEach((b, i) => {
    assert.equal(verifyReceipt(receipts[i]!, b.submission, witness.publicKey), true);
    assert.equal(verifyReceipt(receipts[i]!, bids[(i + 1) % 3]!.submission, witness.publicKey), false);
    assert.equal(verifyReceipt({ ...receipts[i]!, index: (i + 1) % 3 }, b.submission, witness.publicKey), false);
    assert.equal(verifyReceipt(receipts[i]!, b.submission, new Witness().publicKey), false);
    assert.equal(receiptHonoured(receipts[i]!, b.submission, witness.entries()), true);
  });
  // The witness publishes a log without the highest bid.
  const censored = witness.entries().filter((e) => e.envelopeId !== bids[1]!.submission.envelopeId);
  assert.equal(receiptHonoured(receipts[1]!, bids[1]!.submission, censored), false);
  // And it cannot pass that log off under the checkpoint it signed.
  const closing = witness.close(policyHash(policy), beacon.info, beacon.release(CLOSE));
  const envelopes = Object.fromEntries(bids.map((b) => [b.submission.envelopeId, b.envelope]));
  const result = await verifyAuction({ policy, entries: censored, closing, envelopes, release: beacon.release(RELEASE) }, verifier);
  assert.equal(result.ok, false);
});

test("a forked log is provable from two checkpoints", async () => {
  const secret = generateKeyPair().secretKey;
  const a = new Witness(secret);
  const b = new Witness(secret);
  const policy = makePolicy(a);
  a.submit((await prepareBid(policy, 3000, generateKeyPair())).submission);
  b.submit((await prepareBid(policy, 4000, generateKeyPair())).submission);
  const ca = a.checkpoint(beacon.info, beacon.release(CLOSE));
  const cb = b.checkpoint(beacon.info, beacon.release(CLOSE));
  assert.equal(isEquivocation(ca, cb, a.publicKey), true);
  assert.equal(isEquivocation(ca, ca, a.publicKey), false);
  assert.equal(verifyCheckpointSignature({ ...ca, size: 2 }, a.publicKey), false);
});

// --- cheating coordinator ----------------------------------------------------------

test("coordinator announces the wrong winner: anyone can show it is wrong", async () => {
  const w = await world([3100, 4200, 2750]);
  const result = await verifyAuction(close(w), verifier);
  assert.equal(sameOutcome(result, { submitter: w.keys[1]!.publicKey, amount: 4200 }), true);
  assert.equal(sameOutcome(result, { submitter: w.keys[0]!.publicKey, amount: 3100 }), false);
  assert.equal(sameOutcome(result, { submitter: w.keys[0]!.publicKey, amount: 4200 }), false);
  assert.equal(sameOutcome(result, undefined), false);
});

test("coordinator withholds an envelope: the outcome is unresolved, never silently changed", async () => {
  const w = await world([3100, 4200, 2750]);
  const inputs = close(w);
  const withheld = new Map(w.envelopes);
  withheld.delete(w.prepared[1]!.submission.envelopeId);
  const result = await verifyAuction({ ...inputs, envelopes: withheld }, verifier);
  assert.equal(result.ok, false);
  assert.equal(result.winner, undefined);
  assert.equal(result.bids[1]!.status, "unresolved");
});

test("coordinator swaps an envelope or edits the policy: rejected", async () => {
  const w = await world([3100, 4200]);
  const inputs = close(w);
  const forged = await prepareBid(w.policy, 9000, w.keys[0]!);
  const swapped = new Map(w.envelopes).set(w.prepared[0]!.submission.envelopeId, forged.envelope);
  // A swapped envelope is not the submitted envelope. It must block the result,
  // never void the bid: here the top bid is the one swapped, and the runner-up must not win.
  const r1 = await verifyAuction({ ...inputs, envelopes: swapped }, verifier);
  assert.equal(r1.bids[0]!.status, "unresolved");
  assert.equal(r1.ok, false);
  assert.equal(r1.winner, undefined);
  const topSwapped = new Map(w.envelopes).set(w.prepared[1]!.submission.envelopeId, forged.envelope);
  const r1b = await verifyAuction({ ...inputs, envelopes: topSwapped }, verifier);
  assert.equal(r1b.bids[1]!.status, "unresolved");
  assert.equal(r1b.winner, undefined);
  const r2 = await verifyAuction({ ...inputs, policy: { ...w.policy, maxBid: 4000 } }, verifier);
  assert.equal(r2.ok, false, "a different policy has a different hash, so the checkpoint is not for it");
  const r3 = await verifyAuction({ ...inputs, release: { round: RELEASE, signature: beacon.release(RELEASE + 1).signature } }, verifier);
  assert.equal(r3.ok, false);
});

test("an auction on a beacon the verifier does not accept is rejected", async () => {
  const w = await world([3100]);
  assert.equal((await verifyAuction(close(w), { acceptedBeacons: [new TestBeacon().info] })).ok, false);
});
