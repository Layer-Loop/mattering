/**
 * One long-lived log shared by many auctions: each auction's evidence covers
 * only its own stretch of the log, the service survives restarts and lets
 * released auctions go from memory, and cosigners are asked once per
 * checkpoint however many auctions are waiting.
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  Cosigner,
  MatteringError,
  POLICY_FORMAT,
  countCosignatures,
  generateKeyPair,
  prepareBid,
  scheduleClock,
  verifyAuction,
  type AuctionInputs,
  type AuctionPolicy,
} from "@mattering/core";
import { TestBeacon, TestClock } from "@mattering/core/testing";
import { WitnessService, fileStore, memoryStore, type CosignRequest, type ServiceStore } from "@mattering/witness";

const ORIGIN = "shared.example/log";

function setup(store: ServiceStore = memoryStore()) {
  const beacon = new TestBeacon();
  const clock = new TestClock(beacon, 10);
  const cosigner = new Cosigner({ name: "cosigner.example", logs: [], clock: scheduleClock(clock.source()) });
  const requests: number[] = [];
  const cosign: CosignRequest = async (_vkey, body) => {
    requests.push(Number(/^old (\d+)/.exec(body)![1]));
    const reply = await cosigner.addCheckpoint(body);
    return { status: reply.status, body: reply.body };
  };
  const verifier = { acceptedBeacons: [beacon.info] };
  const open = async (overrides: Partial<Parameters<typeof WitnessService.open>[0]> = {}) => {
    const service = await WitnessService.open({ store, source: clock.source(), origin: ORIGIN, cosign, ...overrides });
    cosigner.addLog(service.vkey);
    return service;
  };
  const auction = (service: WitnessService, auctionId: string, closeRound: number, releaseRound: number): AuctionPolicy => ({
    format: POLICY_FORMAT,
    auctionId,
    beacon: beacon.info,
    closeRound,
    releaseRound,
    witness: service.publicKey,
    origin: service.origin,
    logFrom: service.size,
    cosigners: [cosigner.vkey],
    cosignerThreshold: 1,
    minBid: 1,
    maxBid: 1000,
    rule: "highest-bid",
    tieBreak: "release-round-signature",
  });
  const bid = async (service: WitnessService, policy: AuctionPolicy, amount: number) => {
    const prepared = await prepareBid(policy, amount, generateKeyPair());
    await service.submit(prepared.submission, prepared.envelope);
    return prepared;
  };
  return { beacon, clock, cosigner, requests, verifier, open, auction, bid };
}

test("each auction's evidence covers only its own stretch of a shared log", async () => {
  const s = setup();
  const service = await s.open();
  // Earlier traffic on the log, from an auction that runs alongside.
  const early = s.auction(service, "early", 100, 110);
  const earlyHash = (await service.registerPolicy(early)).policyHash;
  for (const amount of [10, 20, 30, 40, 50]) await s.bid(service, early, amount);
  const later = s.auction(service, "later", 100, 110);
  assert.equal(later.logFrom, 5);
  const laterHash = (await service.registerPolicy(later)).policyHash;
  await s.bid(service, early, 60); // interleaved with the later auction's bids
  await s.bid(service, later, 700);
  await s.bid(service, later, 800);

  s.clock.advanceTo(100);
  await service.tick();
  // Both closed in one tick and share one cosigned checkpoint, got with one request.
  assert.deepEqual(s.requests, [0]);
  s.clock.advanceTo(110);
  const evidence = await service.evidence(laterHash);
  assert.equal(evidence.entries!.length, evidence.closing!.size - later.logFrom, "the entries start at logFrom");
  assert.equal(evidence.prefix!.length, 2, "five entries before it: subtrees of four and one");
  const result = await verifyAuction(evidence as unknown as AuctionInputs, s.verifier);
  assert.equal(result.ok, true, JSON.stringify(result.checks));
  assert.deepEqual(result.bids.map((b) => [b.index, b.amount]), [[6, 700], [7, 800]], "indices are positions in the whole log");
  assert.equal(result.winner?.amount, 800);
  assert.equal((await verifyAuction((await service.evidence(earlyHash)) as unknown as AuctionInputs, s.verifier)).winner?.amount, 60);

  // A prefix that does not match, or entries that start elsewhere, fail against the signed closing.
  const wrongPrefix = { ...evidence, prefix: [evidence.prefix![1]!, evidence.prefix![0]!] };
  assert.equal((await verifyAuction(wrongPrefix as unknown as AuctionInputs, s.verifier)).checks.find((c) => c.name === "log-matches-closing-checkpoint")?.ok, false);
  const shifted = { ...evidence, entries: evidence.entries!.slice(1) };
  assert.equal((await verifyAuction(shifted as unknown as AuctionInputs, s.verifier)).ok, false);
  const fromZero = { ...evidence, policy: { ...later, logFrom: 0 }, prefix: [] };
  assert.equal((await verifyAuction(fromZero as unknown as AuctionInputs, s.verifier)).ok, false, "a different logFrom is a different policy");
});

test("a policy must start at the log's end, or not far behind it", async () => {
  const s = setup();
  const service = await s.open({ maxPolicyLag: 2 });
  const filler = s.auction(service, "filler", 100, 110);
  await service.registerPolicy(filler);
  for (const amount of [1, 2, 3]) await s.bid(service, filler, amount);
  const ahead = { ...s.auction(service, "ahead", 100, 110), logFrom: 4 };
  await assert.rejects(service.registerPolicy(ahead), (e: MatteringError) => e.code === "POLICY" && /beyond the end/.test(e.message));
  const behind = { ...s.auction(service, "behind", 100, 110), logFrom: 0 };
  await assert.rejects(service.registerPolicy(behind), (e: MatteringError) => e.code === "POLICY" && /too far behind/.test(e.message));
  await service.registerPolicy({ ...s.auction(service, "recent", 100, 110), logFrom: 1 });
});

test("the log survives a restart, and released auctions leave memory but stay readable", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mattering-shared-"));
  const s = setup(fileStore(dir));
  const first = await s.open();
  const policy = s.auction(first, "lot", 100, 110);
  const hash = (await first.registerPolicy(policy)).policyHash;
  const winner = await s.bid(first, policy, 900);
  await s.bid(first, policy, 400);

  // A new process on the same files: counts, then closes and gets cosigned as if nothing happened.
  const s2 = { ...s };
  const second = await WitnessService.open({ store: fileStore(dir), source: s.clock.source(), origin: ORIGIN, cosign: async (_v, body) => {
    const reply = await s2.cosigner.addCheckpoint(body);
    return { status: reply.status, body: reply.body };
  } });
  assert.equal(second.publicKey, first.publicKey);
  assert.equal(second.size, 2);
  assert.equal(second.count(hash), 2);
  s.clock.advanceTo(100);
  await second.tick();
  assert.equal((await second.phase(hash)).cosignatures, 1);
  assert.deepEqual(second.listPolicies().map((p) => p.policyHash), [hash]);

  s.clock.advanceTo(110);
  await second.tick();
  assert.deepEqual(second.listPolicies(), [], "released: no longer held in memory");
  const third = await WitnessService.open({ store: fileStore(dir), source: s.clock.source(), origin: ORIGIN });
  assert.deepEqual(third.listPolicies(), [], "and not loaded at start");
  const result = await verifyAuction((await third.evidence(hash)) as unknown as AuctionInputs, s.verifier);
  assert.equal(result.ok, true, JSON.stringify(result.checks));
  assert.equal(result.winner?.envelopeId, winner.submission.envelopeId);
  assert.equal((await third.submitter(winner.submission.submitter)).commitments[0]!.state, "opened");
  await assert.rejects(third.submit(winner.submission, winner.envelope), (e: MatteringError) => e.code === "POLICY");
  await third.registerPolicy(policy); // registering a retired policy again changes nothing
  assert.deepEqual(third.listPolicies(), []);
});

test("a cosigner is asked once per checkpoint, and again only when the log has grown", async () => {
  const s = setup();
  const service = await s.open();
  const a = s.auction(service, "a", 100, 120);
  const b = s.auction(service, "b", 105, 120);
  const ha = (await service.registerPolicy(a)).policyHash;
  const hb = (await service.registerPolicy(b)).policyHash;
  await s.bid(service, a, 5);
  await s.bid(service, b, 6);
  s.clock.advanceTo(100);
  await service.tick();
  await service.tick(); // nothing new: the cosignature in hand serves
  assert.deepEqual(s.requests, [0]);
  await s.bid(service, b, 7);
  s.clock.advanceTo(105);
  await service.tick();
  assert.deepEqual(s.requests, [0, 3], "the second request proves consistency from the size already cosigned");
  for (const hash of [ha, hb]) {
    const evidence = await service.evidence(hash);
    assert.equal(countCosignatures(evidence.policy, evidence.closing!, evidence.witnessed).cosigners.length, 1);
  }
});
