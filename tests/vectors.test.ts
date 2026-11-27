/**
 * The published test vectors (test-vectors/*.json) hold for this library.
 * Another implementation should pass the same checks; this test keeps the
 * vectors and the code from drifting apart.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils";
import {
  BLINDING_GENERATOR_HEX,
  COSIGNATURE_ED25519,
  MatteringError,
  QUICKNET,
  SIGNATURE_ED25519,
  canonicalBytes,
  checkpointText,
  commit,
  consistencyProof,
  cosign,
  cosignatureTime,
  envelopeId,
  firstRoundAtOrAfter,
  formatVkey,
  generateKeyPair,
  hashCanonical,
  inclusionProof,
  leafHash,
  merkleRoot,
  open,
  opensTo,
  parseNote,
  parseVkey,
  rootFromInclusionProof,
  signNote,
  timeOfRound,
  verifyAuction,
  verifyConsistency,
  verifyEnvelope,
  verifyNoteSignature,
  verifyRelease,
  type AuctionInputs,
  type BeaconInfo,
  type Envelope,
  type MandateOpening,
  type Release,
  type Side,
} from "@mattering/core";
import { verifyNegotiationStep, withFileKeys, type StepInputs } from "@mattering/core/negotiation";
import { bidOpenerAs, bidOpenerWithFileKeys, fileKeyOf, openAs, openWithFileKey } from "@mattering/core/recipients";
import { TestBeacon } from "@mattering/core/testing";

type Any = any;
const load = (name: string): Any => (JSON.parse(readFileSync(join(import.meta.dirname, "..", "test-vectors", name), "utf8")) as { vectors: Any }).vectors;
const beacons = load("beacon.json");
const beaconInfo = (name: "quicknet" | "testBeacon"): BeaconInfo => (name === "quicknet" ? QUICKNET : beacons.testBeacon.info);
const policyFor = (name: "quicknet" | "testBeacon") => ({ acceptedBeacons: [beaconInfo(name)] });
const testPolicy = policyFor("testBeacon");

test("vectors: beacons, releases and the round schedule", () => {
  assert.deepEqual(beacons.quicknet.info, { ...QUICKNET });
  assert.deepEqual(new TestBeacon(beacons.testBeacon.secret).info, beacons.testBeacon.info, "the test beacon's info follows from its secret");
  for (const release of beacons.quicknet.releases as Release[]) assert.equal(verifyRelease(QUICKNET, release), true, `quicknet round ${release.round}`);
  for (const release of beacons.testBeacon.releases as Release[]) assert.equal(verifyRelease(beacons.testBeacon.info, release), true, `test round ${release.round}`);
  for (const bad of beacons.invalid) assert.equal(verifyRelease(beaconInfo(bad.beacon), bad.release), false, bad.why);
  for (const s of beacons.schedule) {
    assert.equal(firstRoundAtOrAfter(QUICKNET, s.unixSeconds), s.firstRoundAtOrAfter);
    assert.equal(timeOfRound(QUICKNET, s.firstRoundAtOrAfter), s.timeOfThatRound);
  }
});

test("vectors: canonical JSON and labelled hashes", () => {
  const v = load("canonical.json");
  for (const c of v.accepted) {
    assert.equal(new TextDecoder().decode(canonicalBytes(c.value)), c.canonical);
    for (const [label, hash] of Object.entries(c.hashes)) assert.equal(bytesToHex(hashCanonical(label, c.value)), hash, label);
  }
  // JSON.parse cannot keep 2^53 exactly, but it still parses to an unsafe integer, which is the point.
  for (const r of v.rejected) assert.throws(() => canonicalBytes(r.value), MatteringError, r.why);
});

test("vectors: Pedersen commitments", () => {
  const v = load("commitment.json");
  assert.equal(BLINDING_GENERATOR_HEX, v.blindingGenerator);
  for (const c of v.commitments) {
    assert.equal(commit(c.amount, c.blinding), c.commitment);
    assert.equal(opensTo(c.commitment, c.amount, c.blinding), true);
  }
  for (const c of v.notOpening) assert.equal(opensTo(c.commitment, c.amount, c.blinding), false, c.why);
});

test("vectors: Merkle trees, inclusion and consistency", () => {
  const v = load("merkle.json");
  const hashes = (v.leaves as string[]).map((l) => leafHash(hexToBytes(l)));
  assert.deepEqual(hashes.map(bytesToHex), v.leafHashes);
  for (const r of v.roots) assert.equal(bytesToHex(merkleRoot(hashes.slice(0, r.size))), r.root, `size ${r.size}`);
  const rootOf = (size: number): Uint8Array => hexToBytes(v.roots[size].root);
  for (const p of v.inclusion) {
    assert.deepEqual(inclusionProof(hashes.slice(0, p.size), p.index).map(bytesToHex), p.proof);
    const root = rootFromInclusionProof(hashes[p.index]!, p.index, p.size, (p.proof as string[]).map(hexToBytes));
    assert.equal(root && bytesToHex(root), v.roots[p.size].root);
  }
  for (const p of v.consistency) {
    assert.deepEqual(consistencyProof(hashes.slice(0, p.newSize), p.oldSize).map(bytesToHex), p.proof);
    assert.equal(verifyConsistency(p.oldSize, p.newSize, rootOf(p.oldSize), rootOf(p.newSize), (p.proof as string[]).map(hexToBytes)), true);
  }
});

test("vectors: signed notes, checkpoints and cosignatures", () => {
  const v = load("note.json");
  const merkle = load("merkle.json");
  assert.equal(generateKeyPair(v.log.secretKey).publicKey, v.log.publicKey);
  assert.equal(formatVkey({ name: "example.com/vector-log", type: SIGNATURE_ED25519, publicKey: v.log.publicKey }), v.log.vkey);
  assert.equal(formatVkey({ name: "cosigner.example", type: COSIGNATURE_ED25519, publicKey: v.cosigner.publicKey }), v.cosigner.vkey);
  assert.equal(checkpointText("example.com/vector-log", 7, merkle.roots[7].root), v.checkpointText);
  assert.equal(signNote(v.checkpointText, "example.com/vector-log", v.log.secretKey), v.logSignatureLine);
  assert.equal(cosign(v.checkpointText, "cosigner.example", v.cosigner.secretKey, v.cosignature.timestamp), v.cosignature.signatureLine);
  const note = parseNote(v.note);
  assert.equal(note.text, v.checkpointText);
  assert.equal(verifyNoteSignature(note, parseVkey(v.log.vkey)), true);
  assert.equal(cosignatureTime(note, parseVkey(v.cosigner.vkey)), v.cosignature.timestamp);
});

test("vectors: version 1 envelopes open with their round and no other", async () => {
  const v = load("envelope.json");
  for (const e of v.envelopes) {
    const envelope = e.envelope as Envelope;
    const policy = policyFor(e.beacon);
    assert.equal(envelopeId(envelope), e.envelopeId, e.name);
    assert.equal(verifyEnvelope(envelope, policy).ok, true, e.name);
    assert.equal(verifyEnvelope(envelope).ok, e.beacon === "quicknet", "the default policy accepts quicknet only");
    assert.equal(bytesToHex(await open(envelope, e.opensWith, policy)), e.payload, e.name);
    await assert.rejects(open(envelope, e.doesNotOpenWith, policy), MatteringError, `${e.name}: another round's release`);
  }
  for (const bad of v.invalid) await assert.rejects(open(bad.envelope, bad.release, policyFor(bad.beacon)), MatteringError, bad.why);
});

test("vectors: version 2 envelopes open only to their recipients", async () => {
  const v = load("recipients.json");
  const envelope = v.envelope as Envelope;
  assert.equal(envelopeId(envelope), v.envelopeId);
  assert.equal(verifyEnvelope(envelope, testPolicy).ok, true);
  for (const who of ["alice", "bob"]) assert.equal(bytesToHex(await openAs(envelope, v.release, v.identities[who].identity, testPolicy)), v.payload, who);
  assert.equal(await fileKeyOf(envelope, v.release, v.identities.alice.identity, testPolicy), v.fileKey);
  assert.equal(bytesToHex(await openWithFileKey(envelope, v.release, v.fileKey, testPolicy)), v.payload, "anyone given the file key");
  await assert.rejects(openAs(envelope, v.release, v.identities.stranger.identity, testPolicy), MatteringError, "a stranger");
});

test("vectors: a witnessed, cosigned auction gives the recorded result", async () => {
  const v = load("auction.json");
  const evidence = v.evidence as AuctionInputs;
  const result = await verifyAuction(evidence, testPolicy);
  assert.equal(result.ok, v.expected.ok);
  assert.deepEqual(result.checks.map((c) => c.name), v.expected.checks);
  assert.ok(result.checks.every((c) => c.ok));
  assert.deepEqual({ submitter: result.winner!.submitter, amount: result.winner!.amount }, v.expected.winner);
  assert.deepEqual(result.bids.map((b) => ({ submitter: b.submitter, amount: b.amount, status: b.status })), v.expected.bids);
  // Removing a bid after the close is caught.
  const firstBid = evidence.entries.findIndex((e) => "submitter" in e);
  const tampered = { ...evidence, entries: evidence.entries.filter((_, i) => i !== firstBid) };
  const caught = await verifyAuction(tampered, testPolicy);
  assert.equal(caught.ok, false);
  assert.equal(caught.checks.find((c) => c.name === v.tampered.failingCheck)?.ok, false, v.tampered.why);
});

test("vectors: a funding auction with bids sealed to the organiser gives the recorded result", async () => {
  const v = load("auction-v4.json");
  const evidence = v.evidence as AuctionInputs;
  const asOrganiser = await verifyAuction(evidence, testPolicy, bidOpenerAs(v.organiser.identity));
  assert.equal(asOrganiser.ok, true);
  assert.deepEqual(asOrganiser.checks.map((c) => c.name), v.expected.checks);
  assert.equal(asOrganiser.reserveMet, v.expected.reserveMet);
  assert.deepEqual({ submitter: asOrganiser.winner!.submitter, amount: asOrganiser.winner!.amount }, v.expected.winner);
  assert.deepEqual(asOrganiser.bids.map((b) => ({ submitter: b.submitter, amount: b.amount, status: b.status })), v.expected.bids);
  assert.deepEqual((await verifyAuction(evidence, testPolicy, bidOpenerWithFileKeys(v.fileKeys))).winner, asOrganiser.winner, "the disclosed keys give the same winner");
  const outsider = await verifyAuction(evidence, testPolicy);
  assert.deepEqual({ ok: outsider.ok, bids: outsider.bids.map((b) => b.status) }, v.expected.withoutKeys);
});

test("vectors: a negotiation step under mandates gives the recorded outcome", async () => {
  const v = load("negotiation.json");
  const evidence = v.evidence as StepInputs;
  const openings = v.openings as Record<Side, MandateOpening>;
  const result = await verifyNegotiationStep(evidence, withFileKeys(v.fileKeys), testPolicy, openings);
  assert.equal(result.ok, v.expected.ok);
  assert.deepEqual(result.outcome, v.expected.outcome);
  assert.deepEqual(result.checks.map((c) => c.name), v.expected.checks);
  assert.deepEqual(result.offers.filter((o) => o.side).map((o) => ({ side: o.side, price: o.price, mandate: o.mandate, status: o.status })), v.expected.offers);
  // With no keys the prices stay sealed.
  const outsider = await verifyNegotiationStep(evidence, withFileKeys({}), testPolicy);
  assert.equal(outsider.offers.filter((o) => o.side).every((o) => o.status === "unresolved"), true);
});
