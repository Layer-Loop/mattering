/**
 * Phase 1: seal, verify and open, with deliberate cheating.
 *
 * Runs offline. The time lock is exercised for real against a local test
 * beacon: a round's ciphertext cannot be opened until that beacon signs it.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ChainClient } from "drand-client";
import { timelockDecrypt } from "tlock-js";
import {
  DEFAULT_POLICY,
  MatteringError,
  QUICKNET,
  envelopeId,
  firstRoundAtOrAfter,
  open,
  parseEnvelope,
  readStanza,
  seal,
  serializeEnvelope,
  timeOfRound,
  verifyEnvelope,
  verifyOpen,
  verifyRelease,
  type Envelope,
  type VerifierPolicy,
} from "@mattering/core";
import { TestBeacon } from "@mattering/core/testing";

const beacon = new TestBeacon("2b7e151628aed2a6abf7158809cf4f3c2b7e151628aed2a6abf7158809cf4f3c");
const policy: VerifierPolicy = { acceptedBeacons: [beacon.info] };
const payload = new TextEncoder().encode("the bid is 4200");
const ROUND = 1000;

async function sealed(context = { auction: "A-1" }): Promise<Envelope> {
  return seal({ payload, round: ROUND, beacon: beacon.info, context });
}

async function rejects(promise: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof MatteringError, `expected MatteringError, got ${String(error)}`);
    assert.equal(error.code, code);
    return true;
  });
}

function clone(envelope: Envelope): Envelope {
  return JSON.parse(JSON.stringify(envelope)) as Envelope;
}

test("seal then open returns the payload", async () => {
  const envelope = await sealed();
  assert.equal(verifyEnvelope(envelope, policy).ok, true);
  const opened = await open(envelope, beacon.release(ROUND), policy);
  assert.deepEqual(opened, payload);
  const verdict = await verifyOpen(envelope, payload, beacon.release(ROUND), policy);
  assert.equal(verdict.ok, true);
  assert.equal(verdict.envelopeId, envelopeId(envelope));
});

test("envelope survives a file round trip and keeps its id", async () => {
  const envelope = await sealed();
  const reread = parseEnvelope(serializeEnvelope(envelope));
  assert.equal(envelopeId(reread), envelopeId(envelope));
  // Key order in the file does not matter; identity is over the canonical form.
  const shuffled = JSON.stringify({ ciphertext: envelope.ciphertext, round: envelope.round, context: envelope.context, beacon: envelope.beacon, format: envelope.format });
  assert.equal(envelopeId(parseEnvelope(shuffled)), envelopeId(envelope));
});

test("the payload is not visible in the envelope", async () => {
  const envelope = await sealed();
  assert.equal(JSON.stringify(envelope).includes("4200"), false);
  assert.equal(Buffer.from(envelope.ciphertext.split("\n").slice(1, -2).join(""), "base64").includes("the bid"), false);
});

test("premature opening: an earlier or later round's signature does not open it", async () => {
  const envelope = await sealed();
  await rejects(open(envelope, beacon.release(ROUND - 1), policy), "RELEASE_MISMATCH");
  // Relabel the earlier round's (genuine) signature as this round's.
  await rejects(open(envelope, { round: ROUND, signature: beacon.release(ROUND - 1).signature }, policy), "RELEASE_INVALID");
  await rejects(open(envelope, { round: ROUND, signature: beacon.release(ROUND + 1).signature }, policy), "RELEASE_INVALID");
  await rejects(open(envelope, { round: ROUND, signature: "00".repeat(48) }, policy), "RELEASE_INVALID");
});

test("premature opening: the lock is cryptographic, not just Mattering's own check", async () => {
  // Bypass every Mattering check and hand tlock-js a genuine signature for the
  // wrong round with signature verification switched off. It still must not open.
  const envelope = await sealed();
  for (const wrongRound of [ROUND - 1, ROUND + 1]) {
    const wrong = beacon.release(wrongRound);
    const client: ChainClient = {
      options: { disableBeaconVerification: true, noCache: true },
      chain: () => ({
        baseUrl: "",
        info: async () => ({ public_key: beacon.info.publicKey, period: 1, genesis_time: 0, hash: beacon.info.chainHash, groupHash: "", schemeID: beacon.info.scheme, metadata: { beaconID: "t" } }),
      }),
      latest: async () => { throw new Error("none"); },
      get: async (round) => ({ round, signature: wrong.signature, randomness: "00" }),
    };
    const log = console.log;
    console.log = () => {};
    try {
      await assert.rejects(timelockDecrypt(envelope.ciphertext, client));
    } finally {
      console.log = log;
    }
  }
});

test("a seal made to another beacon's key cannot be opened by this beacon", async () => {
  const other = new TestBeacon();
  const envelope = await seal({ payload, round: ROUND, beacon: other.info });
  const both: VerifierPolicy = { acceptedBeacons: [beacon.info, other.info] };
  await rejects(open(envelope, beacon.release(ROUND), both), "RELEASE_INVALID");
  assert.deepEqual(await open(envelope, other.release(ROUND), both), payload);
});

test("tampering with the round is detected", async () => {
  const envelope = await sealed();
  const earlier = { ...clone(envelope), round: ROUND - 1 };
  assert.equal(verifyEnvelope(earlier, policy).ok, false);
  await rejects(open(earlier, beacon.release(ROUND - 1), policy), "MALFORMED");
});

test("tampering with the context is detected at opening, and changes the id", async () => {
  const envelope = await sealed();
  const moved = { ...clone(envelope), context: { auction: "A-2" } };
  assert.notEqual(envelopeId(moved), envelopeId(envelope));
  // Still sealed, the swap is only visible to someone who knows the expected context...
  assert.equal(verifyEnvelope(moved, policy).ok, true);
  assert.equal(verifyEnvelope(moved, { ...policy, expectedContext: { auction: "A-1" } }).ok, false);
  // ...but it can never be opened as a valid envelope.
  await rejects(open(moved, beacon.release(ROUND), policy), "BINDING");
});

test("replay: a ciphertext lifted into another context does not open there", async () => {
  const a = await sealed({ auction: "A-1" });
  const b = await sealed({ auction: "B-7" });
  const replayed = { ...clone(b), ciphertext: a.ciphertext };
  await rejects(open(replayed, beacon.release(ROUND), policy), "BINDING");
});

test("tampering with the ciphertext is detected", async () => {
  const envelope = await sealed();
  const lines = envelope.ciphertext.split("\n");
  for (const index of [1, Math.floor(lines.length / 2), lines.length - 3]) {
    const line = lines[index]!;
    const flipped = [...lines];
    flipped[index] = (line[0] === "A" ? "B" : "A") + line.slice(1);
    const tampered = { ...clone(envelope), ciphertext: flipped.join("\n") };
    await assert.rejects(open(tampered, beacon.release(ROUND), policy), MatteringError, `line ${index}`);
  }
});

test("tampering with the beacon parameters is detected", async () => {
  const envelope = await sealed();
  const other = new TestBeacon();
  const swapped = { ...clone(envelope), beacon: other.info };
  assert.equal(verifyEnvelope(swapped, { acceptedBeacons: [beacon.info, other.info] }).ok, false);
  const reperiod = { ...clone(envelope), beacon: { ...envelope.beacon, period: 30 } };
  assert.equal(verifyEnvelope(reperiod, policy).ok, false);
});

test("non-canonical encodings are rejected", async () => {
  const envelope = await sealed();
  const variants: unknown[] = [
    { ...clone(envelope), ciphertext: envelope.ciphertext.replace(/\n$/, "") },
    { ...clone(envelope), ciphertext: envelope.ciphertext.replace("\n", "\r\n") },
    { ...clone(envelope), ciphertext: envelope.ciphertext.replace("\n", "\n\n") },
    { ...clone(envelope), extra: 1 },
    { ...clone(envelope), format: "mattering.envelope/2" },
    { ...clone(envelope), round: 1.5 },
    { ...clone(envelope), round: "1000" },
    { ...clone(envelope), context: { n: 0.1 } },
    { ...clone(envelope), context: { n: null } },
    { ...clone(envelope), beacon: { ...envelope.beacon, publicKey: envelope.beacon.publicKey.toUpperCase() } },
  ];
  for (const variant of variants) {
    assert.equal(verifyEnvelope(variant, policy).ok, false, JSON.stringify(variant).slice(0, 80));
  }
  assert.throws(() => parseEnvelope("not json"), MatteringError);
});

test("a beacon the verifier did not choose is rejected (sender-controlled clock)", async () => {
  // A sender can always make their own beacon and "time-lock" to it. They hold
  // the key, so the lock means nothing. The default policy accepts only quicknet.
  const envelope = await sealed();
  assert.equal(verifyEnvelope(envelope).ok, false);
  await rejects(open(envelope, beacon.release(ROUND)), "POLICY");
  assert.deepEqual(DEFAULT_POLICY.acceptedBeacons, [QUICKNET]);
});

test("policy can pin the release round", async () => {
  const envelope = await sealed();
  assert.equal(verifyEnvelope(envelope, { ...policy, expectedRound: ROUND }).ok, true);
  assert.equal(verifyEnvelope(envelope, { ...policy, expectedRound: ROUND + 1 }).ok, false);
});

test("verifyOpen rejects a false claim about what the envelope contains", async () => {
  const envelope = await sealed();
  const verdict = await verifyOpen(envelope, new TextEncoder().encode("the bid is 9999"), beacon.release(ROUND), policy);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.checks.find((c) => c.name === "payload-matches")?.ok, false);
});

test("opening needs nothing from the sender: only the envelope file and the signature", async () => {
  const file = serializeEnvelope(await sealed());
  // Everything the sealing side had is now out of scope; only `file` survives.
  const reread = parseEnvelope(file);
  assert.deepEqual(await open(reread, beacon.release(reread.round), policy), payload);
});

test("empty and large payloads", async () => {
  for (const size of [0, 1, 70_000]) {
    const data = new Uint8Array(size).map((_, i) => i % 251);
    const envelope = await seal({ payload: data, round: 7, beacon: beacon.info });
    assert.deepEqual(await open(envelope, beacon.release(7), policy), data);
  }
});

test("quicknet parameters: seals address the pinned chain, and a known round verifies", async () => {
  const envelope = await seal({ payload, round: 30_000_000 });
  assert.deepEqual(readStanza(envelope.ciphertext), { round: 30_000_000, chainHash: QUICKNET.chainHash });
  assert.equal(verifyEnvelope(envelope).ok, true);
  // drand quicknet round 1000, as published by the League of Entropy.
  const known = { round: 1000, signature: "b44679b9a59af2ec876b1a6b1ad52ea9b1615fc3982b19576350f93447cb1125e342b73a8dd2bacbe47e4b6b63ed5e39" };
  assert.equal(verifyRelease(QUICKNET, known), true);
  assert.equal(verifyRelease(QUICKNET, { ...known, round: 1001 }), false);
});

test("round and time arithmetic", () => {
  assert.equal(timeOfRound(QUICKNET, 1), QUICKNET.genesisTime);
  assert.equal(firstRoundAtOrAfter(QUICKNET, QUICKNET.genesisTime), 1);
  assert.equal(firstRoundAtOrAfter(QUICKNET, QUICKNET.genesisTime + 1), 2);
  assert.equal(firstRoundAtOrAfter(QUICKNET, QUICKNET.genesisTime + 3), 2);
  assert.equal(firstRoundAtOrAfter(QUICKNET, QUICKNET.genesisTime + 4), 3);
  const t = 1_800_000_000;
  assert.ok(timeOfRound(QUICKNET, firstRoundAtOrAfter(QUICKNET, t)) >= t);
  assert.ok(timeOfRound(QUICKNET, firstRoundAtOrAfter(QUICKNET, t) - 1) < t);
});
