/**
 * Auction policy version 4: the lowest bid can win (funding, procurement), a
 * public reserve, and bids sealed to the organiser instead of opening to
 * everyone. Offline, against a test beacon.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AUCTION_POLICY_FORMAT,
  MatteringError,
  Witness,
  generateKeyPair,
  policyHash,
  prepareBid,
  verifyAuction,
  type AuctionInputs,
  type Envelope,
  type SealedAuctionPolicy,
  type VerifierPolicy,
} from "@mattering/core";
import { bidOpenerAs, bidOpenerWithFileKeys, discloseBids, generateRecipientKeys, prepareBidTo, type RecipientKeys } from "@mattering/core/recipients";
import { TestBeacon } from "@mattering/core/testing";
import { WitnessService, memoryStore } from "@mattering/witness";
import { TestClock } from "@mattering/core/testing";

const beacon = new TestBeacon("2b7e151628aed2a6abf7158809cf4f3c2b7e151628aed2a6abf7158809cf4f3c");
const verifier: VerifierPolicy = { acceptedBeacons: [beacon.info] };
const CLOSE = 500;
const RELEASE = 510;

function policy(witness: Witness, over: Partial<SealedAuctionPolicy> = {}): SealedAuctionPolicy {
  return {
    format: AUCTION_POLICY_FORMAT,
    auctionId: "INV-88213-funding",
    unit: "bps",
    beacon: beacon.info,
    closeRound: CLOSE,
    releaseRound: RELEASE,
    witness: witness.publicKey,
    origin: witness.origin,
    logFrom: 0,
    cosigners: [],
    cosignerThreshold: 0,
    minBid: 50,
    maxBid: 1500,
    rule: "lowest-bid",
    recipients: [],
    tieBreak: "release-round-signature",
    ...over,
  };
}

/** Seal each bid (to the organiser if the policy says so), submit, close, and return the evidence. */
async function run(p: SealedAuctionPolicy, witness: Witness, amounts: number[]): Promise<{ inputs: AuctionInputs; bidders: string[] }> {
  const envelopes = new Map<string, Envelope>();
  const bidders: string[] = [];
  for (const amount of amounts) {
    const keys = generateKeyPair();
    const bid = p.recipients.length ? await prepareBidTo(p, amount, keys) : await prepareBid(p, amount, keys);
    witness.submit(bid.submission);
    envelopes.set(bid.submission.envelopeId, bid.envelope);
    bidders.push(keys.publicKey);
  }
  const closing = witness.close(policyHash(p), beacon.info, beacon.release(CLOSE));
  return { inputs: { policy: p, entries: witness.entries(), closing, envelopes, release: beacon.release(RELEASE) }, bidders };
}

test("auction v4: the lowest bid wins a funding auction", async () => {
  const witness = new Witness();
  const { inputs, bidders } = await run(policy(witness), witness, [720, 640, 910]);
  const result = await verifyAuction(inputs, verifier);
  assert.equal(result.ok, true, JSON.stringify(result.checks));
  assert.deepEqual([result.winner?.submitter, result.winner?.amount], [bidders[1], 640]);
  assert.equal(result.reserveMet, undefined, "no reserve, nothing to report");
});

test("auction v4: a reserve decides whether there is a winner, in either direction", async () => {
  for (const [rule, reserve, amounts, met] of [
    ["lowest-bid", 600, [720, 640], false],
    ["lowest-bid", 700, [720, 640], true],
    ["highest-bid", 800, [720, 640], false],
    ["highest-bid", 700, [720, 640], true],
  ] as const) {
    const witness = new Witness();
    const { inputs } = await run(policy(witness, { rule, reserve }), witness, [...amounts]);
    const result = await verifyAuction(inputs, verifier);
    assert.equal(result.ok, true);
    assert.equal(result.reserveMet, met, `${rule} reserve ${reserve}`);
    assert.equal(result.winner?.amount, met ? (rule === "lowest-bid" ? 640 : 720) : undefined);
  }
});

test("auction v4: a malformed policy is refused", () => {
  const witness = new Witness();
  assert.throws(() => policyHash(policy(witness, { reserve: 2000 })), MatteringError, "a reserve outside the range");
  assert.throws(() => policyHash(policy(witness, { rule: "middle-bid" as never })), MatteringError, "an unknown rule");
  assert.throws(() => policyHash({ ...policy(witness), unit: "" }), MatteringError, "no unit");
  assert.throws(() => policyHash({ ...policy(witness), recipients: ["not-an-age-key"] }), MatteringError, "a bad recipient");
});

test("auction v4: bids sealed to the organiser open for it and for whoever it discloses to, and no one else", async () => {
  const organiser: RecipientKeys = await generateRecipientKeys();
  const witness = new Witness();
  const p = policy(witness, { recipients: [organiser.recipient] });
  await assert.rejects(prepareBid(p, 700, generateKeyPair()), /use prepareBidTo/, "a plain bid would open to everyone");
  const { inputs, bidders } = await run(p, witness, [720, 640, 910]);

  // An outsider sees that each bid was on time, but cannot judge any.
  const outsider = await verifyAuction(inputs, verifier);
  assert.equal(outsider.ok, false);
  assert.ok(outsider.bids.every((b) => b.status === "unresolved"));
  assert.ok(outsider.checks.filter((c) => c.name !== "every-on-time-bid-judged").every((c) => c.ok), "the evidence itself checks out");
  assert.equal(JSON.stringify(inputs).includes('"amount"'), false, "no amount appears in the evidence");

  // The organiser can, and an auditor it discloses to reaches the same result without its identity.
  const asOrganiser = await verifyAuction(inputs, verifier, bidOpenerAs(organiser.identity));
  assert.equal(asOrganiser.ok, true, JSON.stringify(asOrganiser.checks));
  assert.deepEqual([asOrganiser.winner?.submitter, asOrganiser.winner?.amount], [bidders[1], 640]);
  const keys = await discloseBids(inputs, organiser.identity, verifier);
  assert.equal(Object.keys(keys).length, 3);
  assert.deepEqual((await verifyAuction(inputs, verifier, bidOpenerWithFileKeys(keys))).winner, asOrganiser.winner);
  // Another identity opens nothing, and says it could not judge the bids rather than calling them invalid.
  const stranger = await generateRecipientKeys();
  const asStranger = await verifyAuction(inputs, verifier, bidOpenerAs(stranger.identity));
  assert.equal(asStranger.ok, false);
  assert.ok(asStranger.bids.every((b) => b.status === "unresolved"), JSON.stringify(asStranger.bids.map((b) => b.reason)));
});

test("auction v4: a bid sealed to anyone but the policy's recipients is invalid", async () => {
  const organiser = await generateRecipientKeys();
  const other = await generateRecipientKeys();
  const witness = new Witness();
  const p = policy(witness, { recipients: [organiser.recipient] });
  void other;
  // A bid sealed to nobody in particular, re-signed under the policy's hash as a cheat would: not what the policy asked for.
  const keys = generateKeyPair();
  const open = await prepareBid({ ...p, recipients: [] }, 600, keys);
  // Re-sign it under the real policy's hash, as a cheat would.
  const { signSubmission } = await import("../packages/core/src/witness.ts");
  const submission = signSubmission({ policyHash: policyHash(p), envelopeId: open.submission.envelopeId, commitment: open.submission.commitment! }, keys);
  witness.submit(submission);
  const closing = witness.close(policyHash(p), beacon.info, beacon.release(CLOSE));
  const result = await verifyAuction({ policy: p, entries: witness.entries(), closing, envelopes: new Map([[open.submission.envelopeId, open.envelope]]), release: beacon.release(RELEASE) }, verifier, bidOpenerAs(organiser.identity));
  assert.equal(result.bids[0]!.status, "invalid");
  assert.match(result.bids[0]!.reason ?? "", /sealed-to-the-policy-recipients|context/);
});

test("auction v4: the witness service takes the new format, and gives no result for bids it cannot read", async () => {
  const clock = new TestClock(beacon, 10);
  const service = await WitnessService.open({ store: memoryStore(), source: clock.source(), origin: "v4.example/log" });
  const organiser = await generateRecipientKeys();
  const terms = { beacon: beacon.info, closeRound: 100, releaseRound: 110, witness: service.publicKey, origin: service.origin, logFrom: service.size, cosigners: [], cosignerThreshold: 0 };
  const sealed: SealedAuctionPolicy = { format: AUCTION_POLICY_FORMAT, auctionId: "svc", unit: "bps", ...terms, minBid: 50, maxBid: 1500, rule: "lowest-bid", recipients: [organiser.recipient], tieBreak: "release-round-signature" };
  const { policyHash: hash } = await service.registerPolicy(sealed);
  for (const amount of [700, 650]) {
    const bid = await prepareBidTo(sealed, amount, generateKeyPair());
    await service.submit(bid.submission, bid.envelope);
  }
  clock.advanceTo(100);
  await service.tick();
  clock.advanceTo(110);
  await service.tick();
  assert.deepEqual(await service.result(hash), { state: "released", kind: "auction" }, "the service cannot read the bids, and does not try");
  const evidence = (await service.evidence(hash)) as unknown as AuctionInputs;
  const result = await verifyAuction(evidence, verifier, bidOpenerAs(organiser.identity));
  assert.equal(result.ok, true, JSON.stringify(result.checks));
  assert.equal(result.winner?.amount, 650);
});
