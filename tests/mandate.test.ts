/**
 * Agent mandates: an organisation authorises its agent's key to negotiate up
 * to a limit the other side cannot see, and nobody can move that limit later.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  Cosigner,
  MatteringError,
  NEGOTIATION_POLICY_FORMAT,
  closeTime,
  generateKeyPair,
  issueMandate,
  mandateProblem,
  scheduleClock,
  withinMandate,
  type KeyPair,
  type Mandate,
  type NegotiationPolicy,
} from "@mattering/core";
import { asParty, negotiationPolicyHash, prepareOffer, verifyNegotiationStep, type StepInputs } from "@mattering/core/negotiation";
import { generateRecipientKeys } from "@mattering/core/recipients";
import { TestBeacon, TestClock } from "@mattering/core/testing";
import { WitnessService, memoryStore } from "@mattering/witness";

const UNIT = "GBP pence";
const LATER = 2_000_000_000; // 2033

test("a mandate is signed by the organisation, for one agent, side and unit, and hides its limit", () => {
  const org = generateKeyPair();
  const agent = generateKeyPair();
  const { mandate, opening } = issueMandate(org, { organisationName: "Acme Treasury Ltd", agent: agent.publicKey, side: "buyer", unit: UNIT, limit: 975_000, expires: LATER });
  const expect = { agent: agent.publicKey, side: "buyer" as const, unit: UNIT, at: LATER - 1 };
  assert.equal(mandateProblem(mandate, expect), undefined);
  assert.equal(JSON.stringify(mandate).includes("975000"), false, "the limit is not in the mandate");

  // Any change voids the signature; another key cannot sign for the organisation.
  for (const changed of [{ agent: generateKeyPair().publicKey }, { side: "seller" }, { unit: "EUR cents" }, { expires: LATER + 1 }, { organisationName: "Acme Holdings" }, { limit: issueMandate(org, { organisationName: "x", agent: agent.publicKey, side: "buyer", unit: UNIT, limit: 999_999, expires: LATER }).mandate.limit }]) {
    assert.match(mandateProblem({ ...mandate, ...changed }, { ...expect, ...(changed.agent ? { agent: changed.agent } : {}), ...(changed.side ? { side: "seller" as const } : {}), ...(changed.unit ? { unit: changed.unit } : {}) }) ?? "", /not signed/, JSON.stringify(changed));
  }
  const impostor = generateKeyPair();
  assert.match(mandateProblem({ ...mandate, organisation: impostor.publicKey }, expect) ?? "", /not signed/);
  // Valid, but not for this use.
  assert.match(mandateProblem(mandate, { ...expect, agent: generateKeyPair().publicKey }) ?? "", /different agent/);
  assert.match(mandateProblem(mandate, { ...expect, side: "seller" }) ?? "", /act as buyer/);
  assert.match(mandateProblem(mandate, { ...expect, unit: "EUR cents" }) ?? "", /in GBP pence/);
  assert.match(mandateProblem(mandate, { ...expect, at: LATER + 1 }) ?? "", /expires before the close/);

  // With the opening: a buyer's agent may go up to the limit, not past it.
  assert.equal(withinMandate(mandate, 975_000, opening), "within");
  assert.equal(withinMandate(mandate, 975_001, opening), "beyond");
  assert.equal(withinMandate(mandate, 975_001, undefined), "undisclosed");
  // The organisation cannot claim a different limit afterwards.
  assert.equal(withinMandate(mandate, 980_000, { ...opening, limit: 990_000 }), "opening-invalid");
  const seller = issueMandate(org, { organisationName: "Acme Treasury Ltd", agent: agent.publicKey, side: "seller", unit: UNIT, limit: 950_000, expires: LATER });
  assert.equal(withinMandate(seller.mandate, 949_999, seller.opening), "beyond", "a seller's agent may not go below its limit");
  assert.throws(() => issueMandate(org, { organisationName: "x", agent: org.publicKey, side: "buyer", unit: UNIT, limit: 1, expires: LATER }), MatteringError);
});

interface Side {
  org: KeyPair;
  agent: KeyPair;
  box: { identity: string; recipient: string };
}

async function setup() {
  const beacon = new TestBeacon();
  const clock = new TestClock(beacon, 10);
  const cosigner = new Cosigner({ name: "cosigner.example", logs: [], clock: scheduleClock(clock.source()) });
  const service = await WitnessService.open({
    store: memoryStore(),
    source: clock.source(),
    origin: "mandates.example/log",
    now: () => clock.now * 1000,
    cosign: async (_v, body) => {
      const r = await cosigner.addCheckpoint(body);
      return { status: r.status, body: r.body };
    },
  });
  cosigner.addLog(service.vkey);
  const side = async (): Promise<Side> => ({ org: generateKeyPair(), agent: generateKeyPair(), box: await generateRecipientKeys() });
  const [buyer, seller] = await Promise.all([side(), side()]);
  const expires = closeTime(beacon.info, 100) + 3600;
  const buyerMandate = issueMandate(buyer.org, { organisationName: "Acme Treasury Ltd", agent: buyer.agent.publicKey, side: "buyer", unit: UNIT, limit: 975_000, expires });
  const sellerMandate = issueMandate(seller.org, { organisationName: "Bolt Components plc", agent: seller.agent.publicKey, side: "seller", unit: UNIT, limit: 950_000, expires });
  const policy = (mandates: { buyer?: Mandate; seller?: Mandate }): NegotiationPolicy => ({
    format: NEGOTIATION_POLICY_FORMAT,
    negotiationId: "INV-2041",
    step: 1,
    previous: "",
    item: "Early payment of invoice INV-2041",
    unit: UNIT,
    minPrice: 900_000,
    maxPrice: 1_000_000,
    buyer: { signer: buyer.agent.publicKey, recipient: buyer.box.recipient, ...(mandates.buyer ? { mandate: mandates.buyer } : {}) },
    seller: { signer: seller.agent.publicKey, recipient: seller.box.recipient, ...(mandates.seller ? { mandate: mandates.seller } : {}) },
    rule: "midpoint-if-crossed",
    beacon: beacon.info,
    closeRound: 100,
    releaseRound: 110,
    witness: service.publicKey,
    origin: service.origin,
    logFrom: service.size,
    cosigners: [cosigner.vkey],
    cosignerThreshold: 1,
  });
  const finish = async (p: NegotiationPolicy): Promise<StepInputs> => {
    clock.advanceTo(p.closeRound);
    await service.tick();
    clock.advanceTo(p.releaseRound);
    await service.tick();
    return (await service.evidence(negotiationPolicyHash(p))) as unknown as StepInputs;
  };
  return { beacon, service, buyer, seller, buyerMandate, sellerMandate, policy, finish, verifier: { acceptedBeacons: [beacon.info] } };
}

test("the witness refuses a negotiation whose mandate is forged, for someone else, or expired", async () => {
  const s = await setup();
  const forged = { ...s.buyerMandate.mandate, organisation: generateKeyPair().publicKey };
  await assert.rejects(s.service.registerPolicy(s.policy({ buyer: forged })), /buyer\.mandate: not signed/);
  await assert.rejects(s.service.registerPolicy(s.policy({ buyer: s.sellerMandate.mandate })), /buyer\.mandate/);
  const stale = issueMandate(s.buyer.org, { organisationName: "Acme Treasury Ltd", agent: s.buyer.agent.publicKey, side: "buyer", unit: UNIT, limit: 975_000, expires: closeTime(s.beacon.info, 100) - 1 });
  await assert.rejects(s.service.registerPolicy(s.policy({ buyer: stale.mandate })), /expires before the close/);
  await s.service.registerPolicy(s.policy({ buyer: s.buyerMandate.mandate, seller: s.sellerMandate.mandate }));
});

test("a deal within both mandates, shown with the openings, and undisclosed without them", async () => {
  const s = await setup();
  const p = s.policy({ buyer: s.buyerMandate.mandate, seller: s.sellerMandate.mandate });
  await s.service.registerPolicy(p);
  const bid = await prepareOffer(p, "buyer", 970_000, s.buyer.agent, s.buyerMandate.opening);
  const ask = await prepareOffer(p, "seller", 960_000, s.seller.agent, s.sellerMandate.opening);
  await s.service.submit(bid.submission, bid.envelope);
  await s.service.submit(ask.submission, ask.envelope);
  const evidence = await s.finish(p);
  const opener = asParty(s.seller.box.identity);
  const shown = await verifyNegotiationStep(evidence, opener, s.verifier, { buyer: s.buyerMandate.opening, seller: s.sellerMandate.opening });
  assert.deepEqual(shown.outcome, { deal: true, price: 965_000, buyerOffer: 970_000, sellerOffer: 960_000 });
  assert.deepEqual(shown.offers.map((o) => [o.side, o.mandate]), [["buyer", "within"], ["seller", "within"]]);
  const blind = await verifyNegotiationStep(evidence, opener, s.verifier);
  assert.deepEqual(blind.outcome, shown.outcome, "the same outcome whoever holds the openings");
  assert.deepEqual(blind.offers.map((o) => o.mandate), ["undisclosed", "undisclosed"]);
});

test("an agent that goes beyond its mandate is caught once the opening is shown", async () => {
  const s = await setup();
  const p = s.policy({ buyer: s.buyerMandate.mandate });
  await s.service.registerPolicy(p);
  // The honest agent's own safeguard refuses.
  await assert.rejects(prepareOffer(p, "buyer", 990_000, s.buyer.agent, s.buyerMandate.opening), /beyond this agent's mandate/);
  // A dishonest agent skips it. Nothing shows while sealed.
  const bid = await prepareOffer(p, "buyer", 990_000, s.buyer.agent);
  const ask = await prepareOffer(p, "seller", 960_000, s.seller.agent);
  await s.service.submit(bid.submission, bid.envelope);
  await s.service.submit(ask.submission, ask.envelope);
  const evidence = await s.finish(p);
  const result = await verifyNegotiationStep(evidence, asParty(s.buyer.box.identity), s.verifier, { buyer: s.buyerMandate.opening });
  assert.deepEqual(result.outcome, { deal: true, price: 975_000, buyerOffer: 990_000, sellerOffer: 960_000 });
  assert.equal(result.offers.find((o) => o.side === "buyer")?.mandate, "beyond", "the deal stands as a record, and shows the agent exceeded its authority");
  assert.equal(result.offers.find((o) => o.side === "seller")?.mandate, undefined, "the seller had no mandate");
  // Nor can Acme claim afterwards that the limit was higher.
  const claimed = await verifyNegotiationStep(evidence, asParty(s.buyer.box.identity), s.verifier, { buyer: { ...s.buyerMandate.opening, limit: 995_000 } });
  assert.equal(claimed.offers.find((o) => o.side === "buyer")?.mandate, "opening-invalid");
});
