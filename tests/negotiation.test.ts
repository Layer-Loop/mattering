/**
 * Sealed negotiation through the witness service: two parties seal offers to
 * each other, the log closes and is cosigned before anyone can read them, and
 * the parties (or an auditor they disclose to) work out the outcome. Includes
 * cheating parties and a cheating operator.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  Cosigner,
  MatteringError,
  NEGOTIATION_POLICY_FORMAT,
  generateKeyPair,
  scheduleClock,
  type KeyPair,
  type NegotiationPolicy,
  type Submission,
} from "@mattering/core";
import {
  asParty,
  discloseStep,
  negotiationPolicyHash,
  prepareOffer,
  verifyNegotiation,
  verifyNegotiationStep,
  withFileKeys,
  type StepInputs,
} from "@mattering/core/negotiation";
import { generateRecipientKeys, sealTo, type RecipientKeys } from "@mattering/core/recipients";
import { TestBeacon, TestClock } from "@mattering/core/testing";
import { WitnessService, memoryStore } from "@mattering/witness";
import { canonicalBytes } from "../packages/core/src/canonical.ts";
import { envelopeId } from "../packages/core/src/envelope.ts";
import { signSubmission } from "../packages/core/src/witness.ts";

interface PartyKeys {
  signer: KeyPair;
  box: RecipientKeys;
}

async function party(): Promise<PartyKeys> {
  return { signer: generateKeyPair(), box: await generateRecipientKeys() };
}

async function setup() {
  const beacon = new TestBeacon();
  const clock = new TestClock(beacon, 10);
  const cosigner = new Cosigner({ name: "cosigner.example", logs: [], clock: scheduleClock(clock.source()) });
  const service = await WitnessService.open({
    store: memoryStore(),
    source: clock.source(),
    origin: "negotiation.example/log",
    now: () => clock.now * 1000,
    cosign: async (_vkey, body) => {
      const reply = await cosigner.addCheckpoint(body);
      return { status: reply.status, body: reply.body };
    },
  });
  cosigner.addLog(service.vkey);
  const [buyer, seller] = await Promise.all([party(), party()]);
  const verifier = { acceptedBeacons: [beacon.info] };
  const policy = (step: number, previous: string, closeRound: number, releaseRound: number): NegotiationPolicy => ({
    format: NEGOTIATION_POLICY_FORMAT,
    negotiationId: "invoice-INV-2041-early-payment",
    step,
    previous,
    item: "Pay invoice INV-2041 (£10,000) 60 days early: the amount paid now",
    unit: "GBP pence",
    minPrice: 900_000,
    maxPrice: 1_000_000,
    buyer: { signer: buyer.signer.publicKey, recipient: buyer.box.recipient },
    seller: { signer: seller.signer.publicKey, recipient: seller.box.recipient },
    rule: "midpoint-if-crossed",
    beacon: beacon.info,
    closeRound,
    releaseRound,
    witness: service.publicKey,
    origin: service.origin,
    logFrom: service.size,
    cosigners: [cosigner.vkey],
    cosignerThreshold: 1,
  });
  /** Close and release a step on the simulated clock, and return its evidence. */
  const finish = async (p: NegotiationPolicy): Promise<StepInputs> => {
    clock.advanceTo(p.closeRound);
    await service.tick();
    clock.advanceTo(p.releaseRound);
    await service.tick();
    return (await service.evidence(negotiationPolicyHash(p))) as unknown as StepInputs;
  };
  return { beacon, clock, service, buyer, seller, verifier, policy, finish };
}

async function rejects(promise: Promise<unknown>, code: string, pattern?: RegExp): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof MatteringError, String(error));
    assert.equal(error.code, code, error.message);
    if (pattern) assert.match(error.message, pattern);
    return true;
  });
}

test("a deal: both offers sealed to both sides, opened together, and everyone who can judge agrees", async () => {
  const s = await setup();
  const p = s.policy(1, "", 100, 110);
  await s.service.registerPolicy(p);
  const bid = await prepareOffer(p, "buyer", 980_000, s.buyer.signer);
  const ask = await prepareOffer(p, "seller", 960_000, s.seller.signer);
  await s.service.submit(bid.submission, bid.envelope);
  await s.service.submit(ask.submission, ask.envelope);
  // The witness stores the envelopes and still cannot read them, after the release too.
  const evidence = await s.finish(p);
  assert.equal(JSON.stringify(evidence).includes("980000"), false);
  assert.deepEqual(await s.service.result(negotiationPolicyHash(p)), { state: "released", kind: "negotiation" });

  const asBuyer = await verifyNegotiationStep(evidence, asParty(s.buyer.box.identity), s.verifier);
  assert.equal(asBuyer.ok, true, JSON.stringify(asBuyer.checks));
  assert.deepEqual(asBuyer.outcome, { deal: true, price: 970_000, buyerOffer: 980_000, sellerOffer: 960_000 });
  const asSeller = await verifyNegotiationStep(evidence, asParty(s.seller.box.identity), s.verifier);
  assert.deepEqual(asSeller.outcome, asBuyer.outcome, "the seller reaches the same outcome");

  // An auditor, given the buyer's disclosure, reaches it too, without either party's identity.
  const keys = await discloseStep(evidence, s.buyer.box.identity, s.verifier);
  assert.equal(Object.keys(keys).length, 2);
  assert.deepEqual((await verifyNegotiationStep(evidence, withFileKeys(keys), s.verifier)).outcome, asBuyer.outcome);
  // Without keys, an outsider learns only that both offers were in on time.
  const outsider = await verifyNegotiationStep(evidence, withFileKeys({}), s.verifier);
  assert.equal(outsider.ok, false);
  assert.equal(outsider.checks.find((c) => c.name === "closing-checkpoint-cosigned-before-release")?.ok, true);
  assert.equal(outsider.offers.every((o) => o.status === "unresolved"), true);
  const stranger = await generateRecipientKeys();
  assert.equal((await verifyNegotiationStep(evidence, asParty(stranger.identity), s.verifier)).ok, false);

  // A deal ends the negotiation: a further step, even a properly linked one, does not count.
  const p2 = s.policy(2, negotiationPolicyHash(p), 120, 130);
  await s.service.registerPolicy(p2);
  for (const [side, price, keys] of [["buyer", 999_000, s.buyer.signer], ["seller", 901_000, s.seller.signer]] as const) {
    const o = await prepareOffer(p2, side, price, keys);
    await s.service.submit(o.submission, o.envelope);
  }
  const later = await verifyNegotiation([evidence, await s.finish(p2)], asParty(s.buyer.box.identity), s.verifier);
  assert.match(later.problem ?? "", /ended in a deal at step 1/);
});

test("no deal at step 1, a deal at step 2, and the chain is checked", async () => {
  const s = await setup();
  const p1 = s.policy(1, "", 100, 110);
  await s.service.registerPolicy(p1);
  for (const [side, price, keys] of [["buyer", 920_000, s.buyer.signer], ["seller", 990_000, s.seller.signer]] as const) {
    const o = await prepareOffer(p1, side, price, keys);
    await s.service.submit(o.submission, o.envelope);
  }
  const e1 = await s.finish(p1);
  const p2 = s.policy(2, negotiationPolicyHash(p1), 120, 130);
  await s.service.registerPolicy(p2);
  for (const [side, price, keys] of [["buyer", 950_000, s.buyer.signer], ["seller", 950_000, s.seller.signer]] as const) {
    const o = await prepareOffer(p2, side, price, keys);
    await s.service.submit(o.submission, o.envelope);
  }
  const e2 = await s.finish(p2);
  const opener = asParty(s.seller.box.identity);
  const result = await verifyNegotiation([e1, e2], opener, s.verifier);
  assert.equal(result.ok, true, result.problem);
  assert.deepEqual(result.steps[0]!.outcome, { deal: false, reason: "the offers did not cross" });
  assert.deepEqual(result.outcome, { deal: true, price: 950_000, buyerOffer: 950_000, sellerOffer: 950_000, step: 2 });

  assert.match((await verifyNegotiation([e2], opener, s.verifier)).problem ?? "", /numbered 2/);
  assert.match((await verifyNegotiation([e1, e1], opener, s.verifier)).problem ?? "", /numbered 1/);
  const relinked = { ...e2, policy: { ...e2.policy, previous: "00".repeat(32) } };
  assert.match((await verifyNegotiation([e1, relinked], opener, s.verifier)).problem ?? "", /does not name the step before/);
});

test("the witness refuses offers it can tell are wrong while sealed", async () => {
  const s = await setup();
  const p = s.policy(1, "", 100, 110);
  await s.service.registerPolicy(p);
  // Someone who is not a party.
  const outsider = generateKeyPair();
  const sneaky = await prepareOffer({ ...p, buyer: { ...p.buyer, signer: outsider.publicKey } }, "buyer", 990_000, outsider);
  await rejects(s.service.submit({ ...sneaky.submission, ...signSubmission({ policyHash: negotiationPolicyHash(p), envelopeId: sneaky.submission.envelopeId }, outsider) }, sneaky.envelope), "MALFORMED", /signed-by-a-party/);
  // A party whose offer would also open to someone else.
  const leak = await generateRecipientKeys();
  const hash = negotiationPolicyHash(p);
  const leaky = await sealTo({ payload: canonicalBytes({ format: "mattering.offer/1", policyHash: hash, side: "seller", signer: s.seller.signer.publicKey, price: 960_000 }), round: p.releaseRound, beacon: p.beacon, context: { kind: "mattering.offer/1", policyHash: hash, side: "seller" }, recipients: [p.buyer.recipient, p.seller.recipient, leak.recipient] });
  await rejects(s.service.submit(signSubmission({ policyHash: hash, envelopeId: envelopeId(leaky) }, s.seller.signer), leaky), "MALFORMED", /sealed-to-both-parties/);
  // An offer locked to the wrong round, by preparing it under a policy with another release.
  const early = await prepareOffer({ ...p, releaseRound: 105 }, "seller", 960_000, s.seller.signer);
  await rejects(s.service.submit({ ...early.submission, ...signSubmission({ policyHash: hash, envelopeId: early.submission.envelopeId }, s.seller.signer) }, early.envelope), "MALFORMED");
  // A party can't sign as the other side.
  await assert.rejects(prepareOffer(p, "buyer", 990_000, s.seller.signer), /not the buyer's signing key/);
  // Late.
  s.clock.advanceTo(100);
  const late = await prepareOffer(p, "buyer", 990_000, s.buyer.signer);
  await rejects(s.service.submit(late.submission, late.envelope), "POLICY", /late/);
});

test("cheating parties: a second offer, an out-of-range price, and shutting the other side out", async () => {
  const s = await setup();
  const p = s.policy(1, "", 100, 110);
  const hash = negotiationPolicyHash(p);
  await s.service.registerPolicy(p);
  const ask = await prepareOffer(p, "seller", 990_000, s.seller.signer);
  const ask2 = await prepareOffer(p, "seller", 905_000, s.seller.signer);
  await s.service.submit(ask.submission, ask.envelope);
  await s.service.submit(ask2.submission, ask2.envelope); // a second thought, still sealed: only the first counts
  // The buyer names both parties but encrypts to itself and a stranger: the
  // seller will not be able to open the buyer's offer.
  const stranger = await generateRecipientKeys();
  const payload = canonicalBytes({ format: "mattering.offer/1", policyHash: hash, side: "buyer", signer: s.buyer.signer.publicKey, price: 995_000 });
  const { Encrypter } = await import("age-encryption");
  const enc = new Encrypter();
  enc.addRecipient(s.buyer.box.recipient);
  enc.addRecipient(stranger.recipient);
  const { sealHeader, baseHeader } = await import("../packages/core/src/seal.ts");
  const shut = await sealHeader({ ...baseHeader({ payload, round: p.releaseRound, beacon: p.beacon, context: { kind: "mattering.offer/1", policyHash: hash, side: "buyer" } }), format: "mattering.envelope/2", recipients: [p.buyer.recipient, p.seller.recipient].sort() }, await enc.encrypt(payload));
  const bid: Submission = signSubmission({ policyHash: hash, envelopeId: envelopeId(shut) }, s.buyer.signer);
  await s.service.submit(bid, shut); // nothing shows while sealed
  const evidence = await s.finish(p);

  // The seller cannot open the buyer's offer: unresolved, not a different answer.
  const asSeller = await verifyNegotiationStep(evidence, asParty(s.seller.box.identity), s.verifier);
  assert.equal(asSeller.ok, false);
  assert.equal(asSeller.offers.find((o) => o.side === "buyer")?.status, "unresolved");
  assert.equal(asSeller.offers.filter((o) => o.side === "seller").map((o) => o.status).join(), "valid,invalid", "the second offer does not count");
  // The buyer sees a deal at the first ask, and can prove it by disclosing the
  // file keys. Once disclosed, the seller reaches the same outcome.
  const asBuyer = await verifyNegotiationStep(evidence, asParty(s.buyer.box.identity), s.verifier);
  assert.deepEqual(asBuyer.outcome, { deal: true, price: 992_500, buyerOffer: 995_000, sellerOffer: 990_000 });
  const disclosed = await discloseStep(evidence, s.buyer.box.identity, s.verifier);
  assert.deepEqual((await verifyNegotiationStep(evidence, withFileKeys(disclosed), s.verifier)).outcome, asBuyer.outcome);

  // A price outside the range is invalid, and there is no deal.
  const s2 = await setup();
  const q = s2.policy(1, "", 100, 110);
  await s2.service.registerPolicy(q);
  for (const [side, price, keys] of [["buyer", 1_200_000, s2.buyer.signer], ["seller", 960_000, s2.seller.signer]] as const) {
    const o = await prepareOffer(q, side, price, keys);
    await s2.service.submit(o.submission, o.envelope);
  }
  const r = await verifyNegotiationStep(await s2.finish(q), asParty(s2.seller.box.identity), s2.verifier);
  assert.equal(r.offers.find((o) => o.side === "buyer")?.status, "invalid");
  assert.deepEqual(r.outcome, { deal: false, reason: "the buyer's offer is invalid" });
});

test("an operator that drops an offer after the release is caught", async () => {
  const s = await setup();
  const p = s.policy(1, "", 100, 110);
  await s.service.registerPolicy(p);
  for (const [side, price, keys] of [["buyer", 980_000, s.buyer.signer], ["seller", 960_000, s.seller.signer]] as const) {
    const o = await prepareOffer(p, side, price, keys);
    await s.service.submit(o.submission, o.envelope);
  }
  const evidence = await s.finish(p);
  // Remove the seller's offer so the buyer "made no deal".
  const dropped = { ...evidence, entries: evidence.entries.filter((e) => !("submitter" in e) || e.submitter !== s.seller.signer.publicKey) };
  const r = await verifyNegotiationStep(dropped, asParty(s.buyer.box.identity), s.verifier);
  assert.equal(r.ok, false);
  assert.equal(r.checks.find((c) => c.name === "log-matches-closing-checkpoint")?.ok, false);
});
