/**
 * The hosted witness and registry, over real HTTP on localhost, with a
 * simulated beacon clock. Includes a witness that tries to cheat after release.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import {
  Cosigner,
  MatteringError,
  POLICY_FORMAT,
  STATEMENT_POLICY_FORMAT,
  Witness,
  generateKeyPair,
  policyHash,
  prepareBid,
  prepareStatement,
  statementPolicyHash,
  verifyAuction,
  verifyReceipt,
  verifyStatements,
  type AuctionInputs,
  type AuctionPolicy,
  type AuctionResult,
  type StatementInputs,
  type StatementPolicy,
  type StatementsResult,
} from "@mattering/core";
import { TestBeacon, TestClock } from "@mattering/core/testing";
import { WitnessClient, WitnessService, cosignerServer, httpCosign, witnessServer } from "@mattering/witness";

const servers: Server[] = [];
after(() => servers.forEach((s) => s.close()));

function listen(server: Server): Promise<string> {
  servers.push(server);
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)));
}

async function rejects(promise: Promise<unknown>, code: string, status?: number): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof MatteringError, String(error));
    assert.equal(error.code, code, error.message);
    if (status) assert.equal((error as { status?: number }).status, status);
    return true;
  });
}

/** A witness service with `n` independent cosigner services, all on one simulated clock. */
async function deployment(cosignerCount = 2) {
  const beacon = new TestBeacon();
  const clock = new TestClock(beacon, 10);
  const cosigners = [];
  const urls: Record<string, string> = {};
  for (let i = 0; i < cosignerCount; i++) {
    const cosigner = new Cosigner(clock.source());
    urls[cosigner.publicKey] = await listen(cosignerServer(cosigner));
    cosigners.push(cosigner);
  }
  const dataDir = mkdtempSync(join(tmpdir(), "mattering-witness-"));
  const service = new WitnessService({ dataDir, source: clock.source(), cosign: httpCosign(urls) });
  const url = await listen(witnessServer(service));
  const client = new WitnessClient(url);
  const verifier = { acceptedBeacons: [beacon.info] };
  const terms = { beacon: beacon.info, closeRound: 100, releaseRound: 110, witness: service.publicKey, cosigners: cosigners.map((c) => c.publicKey), cosignerThreshold: cosignerCount };
  const auction: AuctionPolicy = { format: POLICY_FORMAT, auctionId: "lot-1", ...terms, minBid: 100, maxBid: 10_000, rule: "highest-bid", tieBreak: "release-round-signature" };
  return { beacon, clock, cosigners, urls, dataDir, service, url, client, verifier, terms, auction };
}

test("an auction run entirely through the hosted witness, verified from its published evidence", async () => {
  const d = await deployment();
  const info = await d.client.info();
  assert.equal(info.witness, d.service.publicKey);
  const { policyHash: hash } = await d.client.registerPolicy(d.auction);
  assert.equal(hash, policyHash(d.auction));

  const bidders = [3100, 4200, 2750].map((amount) => ({ amount, keys: generateKeyPair() }));
  for (const b of bidders) {
    const { submission, envelope } = await prepareBid(d.auction, b.amount, b.keys);
    const receipt = await d.client.submit(submission, envelope);
    assert.equal(verifyReceipt(receipt, submission, info.witness), true);
  }
  assert.equal((await d.client.evidence(hash)).state, "open");
  assert.equal((await d.client.result(hash)).result, undefined);

  // The close round arrives. The service closes on its own tick and gets cosignatures.
  d.clock.advanceTo(100);
  await d.service.tick();
  const closed = await d.client.evidence(hash);
  assert.equal(closed.state, "closed");
  assert.equal(closed.cosignatures?.length, 2);
  assert.equal(closed.release, undefined);
  const late = await prepareBid(d.auction, 9999, generateKeyPair());
  await rejects(d.client.submit(late.submission, late.envelope), "POLICY", 409);

  // The release round arrives. Anyone fetches the evidence and recomputes the result themselves.
  d.clock.advanceTo(110);
  const evidence = await d.client.evidence(hash);
  assert.equal(evidence.state, "released");
  const mine = await verifyAuction(evidence as unknown as AuctionInputs, d.verifier);
  assert.equal(mine.ok, true, JSON.stringify(mine.checks));
  assert.equal(mine.winner?.submitter, bidders[1]!.keys.publicKey);
  assert.equal(mine.winner?.amount, 4200);
  const theirs = (await d.client.result(hash)).result as AuctionResult;
  assert.deepEqual(theirs.winner, mine.winner);

  // The registry view of one bidder.
  const record = await d.client.submitter(bidders[1]!.keys.publicKey);
  assert.equal(record.commitments.length, 1);
  assert.equal(record.commitments[0]!.state, "opened");
  assert.equal(record.commitments[0]!.amount, 4200);
});

test("the deadline holds even when nobody called tick", async () => {
  const d = await deployment(0);
  await d.client.registerPolicy(d.auction);
  d.clock.advanceTo(100);
  const late = await prepareBid(d.auction, 5000, generateKeyPair());
  await rejects(d.client.submit(late.submission, late.envelope), "POLICY", 409);
  assert.equal((await d.client.log()).size, 0);
  await rejects(d.client.registerPolicy({ ...d.auction, auctionId: "too-late", closeRound: 90 }), "POLICY");
});

test("a relay that serves a stale 'latest' cannot keep the deadline open", async () => {
  // Found by running against live drand: relays cache "latest", so a witness
  // that trusted it alone accepted a bid after the scheduled close.
  const beacon = new TestBeacon();
  const clock = new TestClock(beacon, 10);
  const lagging = clock.source(3);
  const service = new WitnessService({ dataDir: mkdtempSync(join(tmpdir(), "mattering-witness-")), source: lagging });
  const policy: AuctionPolicy = { format: POLICY_FORMAT, auctionId: "lag", beacon: beacon.info, closeRound: 100, releaseRound: 110, witness: service.publicKey, cosigners: [], cosignerThreshold: 0, minBid: 100, maxBid: 10_000, rule: "highest-bid", tieBreak: "release-round-signature" };
  await service.registerPolicy(policy);
  clock.advanceTo(99);
  const inTime = await prepareBid(policy, 3000, generateKeyPair());
  await service.submit(inTime.submission, inTime.envelope);
  clock.advanceTo(100);
  assert.equal((await lagging.latest()).round, 97, "the relay still says round 97");
  const late = await prepareBid(policy, 9999, generateKeyPair());
  await rejects(service.submit(late.submission, late.envelope), "POLICY");
  assert.equal(service.log().size, 1);

  // A cosigner with a lagging relay must not sign after the release either.
  const cosigner = new Cosigner(clock.source(20));
  const terms: AuctionPolicy = { ...policy, auctionId: "lag-2", cosigners: [cosigner.publicKey], cosignerThreshold: 1 };
  const witness = new Witness();
  const closing = witness.close(policyHash({ ...terms, witness: witness.publicKey }), beacon.info, beacon.release(100));
  clock.advanceTo(110);
  assert.equal((await clock.source(20).latest()).round, 90);
  await rejects(cosigner.cosign(policyHash({ ...terms, witness: witness.publicKey }), { ...terms, witness: witness.publicKey }, closing), "POLICY");
});

test("the witness refuses what it can tell is wrong while bids are sealed", async () => {
  const d = await deployment(0);
  await d.client.registerPolicy(d.auction);
  const keys = generateKeyPair();
  const good = await prepareBid(d.auction, 3000, keys);
  const other = await prepareBid(d.auction, 3000, generateKeyPair());
  await rejects(d.client.submit(good.submission, other.envelope), "MALFORMED", 400);
  await rejects(d.client.submit({ ...good.submission, signature: other.submission.signature }, good.envelope), "MALFORMED");
  const elsewhere = await prepareBid({ ...d.auction, auctionId: "unregistered" }, 3000, keys);
  await rejects(d.client.submit(elsewhere.submission, elsewhere.envelope), "MALFORMED", 404);
  const wrongRound = await prepareBid({ ...d.auction, releaseRound: 200 }, 3000, keys);
  await rejects(d.client.submit({ ...wrongRound.submission, policyHash: good.submission.policyHash }, wrongRound.envelope), "MALFORMED");
  await rejects(d.client.registerPolicy({ ...d.auction, witness: generateKeyPair().publicKey }), "POLICY");
  await rejects(d.client.registerPolicy({ ...d.auction, beacon: new TestBeacon().info }), "POLICY");
  assert.equal((await fetch(d.url + "/nothing")).status, 404);
  assert.equal((await fetch(d.url + "/submissions", { method: "POST", body: "{" })).status, 400);
  assert.equal((await d.client.log()).size, 0);
});

test("state survives a restart: same key, same log, same closing checkpoint", async () => {
  const d = await deployment(0);
  const { policyHash: hash } = await d.client.registerPolicy(d.auction);
  for (const amount of [1000, 2000]) {
    const bid = await prepareBid(d.auction, amount, generateKeyPair());
    await d.client.submit(bid.submission, bid.envelope);
  }
  d.clock.advanceTo(100);
  await d.service.tick();
  const before = await d.service.evidence(hash);

  const restarted = new WitnessService({ dataDir: d.dataDir, source: d.clock.source() });
  assert.equal(restarted.publicKey, d.service.publicKey);
  assert.deepEqual(await restarted.evidence(hash), before);
  const late = await prepareBid(d.auction, 9999, generateKeyPair());
  await rejects(restarted.submit(late.submission, late.envelope), "POLICY");
  d.clock.advanceTo(110);
  const result = await verifyAuction((await restarted.evidence(hash)) as unknown as AuctionInputs, d.verifier);
  assert.equal(result.winner?.amount, 2000);
  assert.equal(statSync(join(d.dataDir, "witness-key.json")).mode & 0o077, 0, "key file is not readable by others");
  assert.equal(readFileSync(join(d.dataDir, "log.jsonl"), "utf8").trim().split("\n").length, 2);
});

test("a witness that rewrites the log after seeing the bids cannot get it accepted", async () => {
  const d = await deployment(2);
  const { policyHash: hash } = await d.client.registerPolicy(d.auction);
  for (const amount of [3100, 4200]) {
    const bid = await prepareBid(d.auction, amount, generateKeyPair());
    await d.client.submit(bid.submission, bid.envelope);
  }
  d.clock.advanceTo(100);
  await d.service.tick();
  d.clock.advanceTo(110);
  const honest = (await d.client.evidence(hash)) as unknown as AuctionInputs & { envelopes: Record<string, unknown> };
  assert.equal((await verifyAuction(honest, d.verifier)).winner?.amount, 4200);

  // The witness operator now knows every bid. Using its own signing key it builds a
  // second log with a winning bid of its own, and a closing checkpoint that claims
  // the same close round.
  const secretKey = (JSON.parse(readFileSync(join(d.dataDir, "witness-key.json"), "utf8")) as { secretKey: string }).secretKey;
  const forger = new Witness(secretKey);
  for (const entry of honest.entries) forger.submit(entry);
  const shill = await prepareBid(d.auction, 4201, generateKeyPair());
  forger.submit(shill.submission);
  const forgedClosing = forger.close(hash, d.beacon.info, d.beacon.release(100));
  const forged = { ...honest, entries: forger.entries(), closing: forgedClosing, envelopes: { ...honest.envelopes, [shill.submission.envelopeId]: shill.envelope } };

  // With the genuine cosignatures: they are for a different checkpoint.
  const r1 = await verifyAuction(forged as AuctionInputs, d.verifier);
  assert.equal(r1.ok, false);
  assert.equal(r1.checks.find((c) => c.name === "closing-checkpoint-cosigned-before-release")?.ok, false);
  // Asking the cosigners to sign the forgery: refused, twice over (already signed another; too late).
  for (const cosigner of d.cosigners) {
    await rejects(cosigner.cosign(hash, d.auction, forgedClosing), "POLICY");
  }
  const response = await fetch(Object.values(d.urls)[0]! + "/cosign", { method: "POST", body: JSON.stringify({ policyHash: hash, policy: d.auction, closing: forgedClosing }) });
  assert.equal(response.status, 409);

  // The same forgery under a policy with no cosigners would be accepted. That is
  // exactly the trust a threshold of 0 places in the witness.
  const trusting: AuctionPolicy = { ...d.auction, cosigners: [], cosignerThreshold: 0 };
  const lone = new Witness(secretKey);
  const b1 = await prepareBid(trusting, 4200, generateKeyPair());
  lone.submit(b1.submission);
  const b2 = await prepareBid(trusting, 4201, generateKeyPair());
  lone.submit(b2.submission);
  const r2 = await verifyAuction({ policy: trusting, entries: lone.entries(), closing: lone.close(policyHash(trusting), d.beacon.info, d.beacon.release(100)), envelopes: { [b1.submission.envelopeId]: b1.envelope, [b2.submission.envelopeId]: b2.envelope }, release: d.beacon.release(110) }, d.verifier);
  assert.equal(r2.winner?.amount, 4201);
});

test("cosigners: too few, too early, too late, wrong checkpoint, not named", async () => {
  const d = await deployment(2);
  const { policyHash: hash } = await d.client.registerPolicy(d.auction);
  const bid = await prepareBid(d.auction, 3000, generateKeyPair());
  await d.client.submit(bid.submission, bid.envelope);

  const witness = new Witness();
  const early = witness.checkpoint(d.beacon.info, d.beacon.release(50), hash);
  await rejects(d.cosigners[0]!.cosign(hash, d.auction, early), "MALFORMED");

  d.clock.advanceTo(100);
  await d.service.tick();
  d.clock.advanceTo(110);
  const evidence = (await d.client.evidence(hash)) as unknown as AuctionInputs;
  assert.equal((await verifyAuction(evidence, d.verifier)).ok, true);
  const one = { ...evidence, cosignatures: evidence.cosignatures!.slice(0, 1) };
  assert.equal((await verifyAuction(one, d.verifier)).ok, false, "threshold is 2");
  const doubled = { ...evidence, cosignatures: [evidence.cosignatures![0]!, evidence.cosignatures![0]!] };
  assert.equal((await verifyAuction(doubled, d.verifier)).ok, false, "the same cosigner twice counts once");
  const outsider = new Cosigner(d.clock.source());
  await rejects(outsider.cosign(hash, d.auction, evidence.closing), "POLICY");

  // A cosigner that is first asked after release refuses, so a witness cannot delay closing past it.
  const d2 = await deployment(1);
  const { policyHash: hash2 } = await d2.client.registerPolicy(d2.auction);
  d2.clock.advanceTo(110);
  await d2.service.tick();
  const e2 = (await d2.client.evidence(hash2)) as unknown as AuctionInputs;
  assert.equal(e2.cosignatures!.length, 0);
  assert.equal((await verifyAuction(e2, d2.verifier)).ok, false);
});

test("registry: sealed statements, opened for everyone at the release round", async () => {
  const d = await deployment(1);
  const policy: StatementPolicy = { format: STATEMENT_POLICY_FORMAT, topic: "Which team wins the final on 1 December?", ...d.terms };
  const { policyHash: hash } = await d.client.registerPolicy(policy);
  assert.equal(hash, statementPolicyHash(policy));

  const agents = ["Reds", "Blues"].map((text) => ({ text, keys: generateKeyPair() }));
  for (const a of agents) {
    const { submission, envelope } = await prepareStatement(policy, a.text, a.keys);
    assert.equal(JSON.stringify([submission, envelope]).includes(a.text), false);
    await d.client.submit(submission, envelope);
  }
  // A statement submission must not smuggle in under an auction's rules or vice versa.
  const asBid = await prepareBid(d.auction, 3000, generateKeyPair());
  await rejects(d.client.submit({ ...asBid.submission, policyHash: hash }, asBid.envelope), "MALFORMED");

  const sealedView = await d.client.submitter(agents[0]!.keys.publicKey);
  assert.equal(sealedView.commitments[0]!.state, "sealed, policy open");
  assert.equal("text" in sealedView.commitments[0]!, false);

  d.clock.advanceTo(100);
  await d.service.tick();
  assert.equal((await d.client.submitter(agents[0]!.keys.publicKey)).commitments[0]!.state, "sealed");
  const afterClose = await prepareStatement(policy, "Reds, obviously", generateKeyPair());
  await rejects(d.client.submit(afterClose.submission, afterClose.envelope), "POLICY");

  d.clock.advanceTo(110);
  const evidence = (await d.client.evidence(hash)) as unknown as StatementInputs;
  const mine = await verifyStatements(evidence, d.verifier);
  assert.equal(mine.ok, true, JSON.stringify(mine.checks));
  assert.deepEqual(mine.statements.map((s) => [s.author, s.status, s.text]), agents.map((a) => [a.keys.publicKey, "valid", a.text]));
  assert.deepEqual(((await d.client.result(hash)).result as StatementsResult).statements, mine.statements);
  const opened = await d.client.submitter(agents[1]!.keys.publicKey);
  assert.deepEqual([opened.commitments[0]!.state, opened.commitments[0]!.text], ["opened", "Blues"]);
  assert.equal((await d.client.submitter(generateKeyPair().publicKey)).commitments.length, 0);
});
