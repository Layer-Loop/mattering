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
  countCosignatures,
  generateKeyPair,
  parseNote,
  policyHash,
  prepareBid,
  prepareStatement,
  scheduleClock,
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
  type Submission,
} from "@mattering/core";
import { TestBeacon, TestClock } from "@mattering/core/testing";
import { WitnessClient, WitnessService, cosignerServer, fileStore, httpCosign, memoryStore, witnessServer } from "@mattering/witness";

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

/**
 * A witness service with `n` independent cosigner services, each speaking the
 * C2SP tlog-witness protocol over HTTP with its own clock, all on one simulated beacon.
 */
async function deployment(cosignerCount = 2) {
  const beacon = new TestBeacon();
  const clock = new TestClock(beacon, 10);
  const cosigners: Cosigner[] = [];
  const urls: Record<string, string> = {};
  for (let i = 0; i < cosignerCount; i++) {
    const cosigner = new Cosigner({ name: `cosigner-${i}.example`, logs: [], clock: scheduleClock(clock.source()) });
    urls[cosigner.vkey] = await listen(cosignerServer(cosigner));
    cosigners.push(cosigner);
  }
  const dataDir = mkdtempSync(join(tmpdir(), "mattering-witness-"));
  const service = await WitnessService.open({ store: fileStore(dataDir), source: clock.source(), origin: "witness.example/log", cosign: httpCosign(urls) });
  for (const cosigner of cosigners) cosigner.addLog(service.vkey);
  const url = await listen(witnessServer(service));
  const client = new WitnessClient(url);
  const verifier = { acceptedBeacons: [beacon.info] };
  const terms = { beacon: beacon.info, closeRound: 100, releaseRound: 110, witness: service.publicKey, origin: service.origin, logFrom: service.size, cosigners: cosigners.map((c) => c.vkey), cosignerThreshold: cosignerCount };
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
  assert.equal(countCosignatures(d.auction, closed.closing!, closed.witnessed).cosigners.length, 2);
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
  assert.deepEqual((await d.client.log()).entries.map((e) => e.format), ["mattering.close/1"], "closed, with no bid in the log");
  await rejects(d.client.registerPolicy({ ...d.auction, auctionId: "too-late", closeRound: 90 }), "POLICY");
});

test("a relay that serves a stale 'latest' cannot keep the deadline open", async () => {
  // Found by running against live drand: relays cache "latest", so a witness
  // that trusted it alone accepted a bid after the scheduled close.
  const beacon = new TestBeacon();
  const clock = new TestClock(beacon, 10);
  const lagging = clock.source(3);
  const service = await WitnessService.open({ store: memoryStore(), source: lagging });
  const policy: AuctionPolicy = { format: POLICY_FORMAT, auctionId: "lag", beacon: beacon.info, closeRound: 100, releaseRound: 110, witness: service.publicKey, origin: service.origin, logFrom: service.size, cosigners: [], cosignerThreshold: 0, minBid: 100, maxBid: 10_000, rule: "highest-bid", tieBreak: "release-round-signature" };
  await service.registerPolicy(policy);
  clock.advanceTo(99);
  const inTime = await prepareBid(policy, 3000, generateKeyPair());
  await service.submit(inTime.submission, inTime.envelope);
  clock.advanceTo(100);
  assert.equal((await lagging.latest()).round, 97, "the relay still says round 97");
  const late = await prepareBid(policy, 9999, generateKeyPair());
  await rejects(service.submit(late.submission, late.envelope), "POLICY");
  assert.deepEqual((await service.log()).entries.map((e) => e.format), ["mattering.submission/1", "mattering.close/1"]);

  // A cosigner dates what it signs by its own clock, not by a relay. Asked
  // after the release, it may sign, but the date shows it was too late.
  const witness = new Witness();
  const cosigner = new Cosigner({ name: "lagging.example", logs: [witness.vkey], clock: scheduleClock(clock.source(20)) });
  const terms: AuctionPolicy = { ...policy, auctionId: "lag-2", witness: witness.publicKey, origin: witness.origin, cosigners: [cosigner.vkey], cosignerThreshold: 1 };
  const closing = witness.close(policyHash(terms), beacon.info, beacon.release(100));
  clock.advanceTo(110);
  assert.equal((await clock.source(20).latest()).round, 90);
  const reply = await cosigner.addCheckpoint("old 0\n\n" + witness.logCheckpoint());
  assert.equal(reply.status, 200);
  const count = countCosignatures(terms, closing, { checkpoint: witness.logCheckpoint() + reply.body, proof: [] });
  assert.deepEqual(count, { cosigners: [], problem: "cosigned only after the release round" });
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

  const restarted = await WitnessService.open({ store: fileStore(d.dataDir), source: d.clock.source() });
  assert.equal(restarted.publicKey, d.service.publicKey);
  assert.deepEqual(await restarted.evidence(hash), before);
  const late = await prepareBid(d.auction, 9999, generateKeyPair());
  await rejects(restarted.submit(late.submission, late.envelope), "POLICY");
  d.clock.advanceTo(110);
  const result = await verifyAuction((await restarted.evidence(hash)) as unknown as AuctionInputs, d.verifier);
  assert.equal(result.winner?.amount, 2000);
  assert.equal(statSync(join(d.dataDir, "witness-key.json")).mode & 0o077, 0, "key file is not readable by others");
  assert.equal(readFileSync(join(d.dataDir, "log.jsonl"), "utf8").trim().split("\n").length, 3, "two bids and the close entry");
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

  // The witness operator now knows every bid. Using its own signing key it rewrites
  // the log with a winning bid of its own slipped in before the close.
  const secretKey = (JSON.parse(readFileSync(join(d.dataDir, "witness-key.json"), "utf8")) as { secretKey: string }).secretKey;
  const forger = new Witness(secretKey, undefined, d.service.origin);
  for (const entry of honest.entries.slice(0, -1)) forger.submit(entry as Submission);
  const shill = await prepareBid(d.auction, 4201, generateKeyPair());
  forger.submit(shill.submission);
  const forgedClosing = forger.close(hash, d.beacon.info, d.beacon.release(100));
  const forged = { ...honest, entries: forger.entries(), closing: forgedClosing, envelopes: { ...honest.envelopes, [shill.submission.envelopeId]: shill.envelope } };

  // With the genuine cosignatures: the cosigned log is not an extension of the forged closing.
  const r1 = await verifyAuction(forged as AuctionInputs, d.verifier);
  assert.equal(r1.ok, false);
  assert.match(r1.checks.find((c) => c.name === "closing-checkpoint-cosigned-before-release")?.detail ?? "", /not an extension/);
  // Asking the cosigners to cosign the rewritten log: refused, it is a fork of what they cosigned.
  for (const [vkey, url] of Object.entries(d.urls)) {
    const old = d.cosigners.find((c) => c.vkey === vkey)!.state.get(d.service.origin)!.size;
    const body = `old ${old}\n` + forger.consistency(old).map((p) => p + "\n").join("") + "\n" + forger.logCheckpoint();
    const response = await fetch(url + "/add-checkpoint", { method: "POST", body });
    assert.equal(response.status, 422);
  }

  // Or it appends its bid after the close and closes again. That log does extend
  // what was cosigned, so a cosigner signs it, but dated after the release, and
  // the first close entry still decides which bids count.
  const extender = new Witness(secretKey, { entries: honest.entries, closings: [] }, d.service.origin);
  extender.submit(shill.submission);
  const movedClosing = extender.close(hash, d.beacon.info, d.beacon.release(100));
  const lines = [];
  for (const cosigner of d.cosigners) {
    const old = cosigner.state.get(d.service.origin)!.size;
    const reply = await cosigner.addCheckpoint(`old ${old}\n` + extender.consistency(old).map((p) => p + "\n").join("") + "\n" + extender.logCheckpoint());
    assert.equal(reply.status, 200);
    lines.push(reply.body);
  }
  const moved = { ...forged, entries: extender.entries(), closing: movedClosing, witnessed: { checkpoint: extender.logCheckpoint() + lines.join(""), proof: [] } };
  const r3 = await verifyAuction(moved as AuctionInputs, d.verifier);
  assert.equal(r3.ok, false);
  assert.equal(r3.checks.find((c) => c.name === "closed-only-once")?.ok, false);
  assert.match(r3.checks.find((c) => c.name === "closing-checkpoint-cosigned-before-release")?.detail ?? "", /after the release/);

  // The same forgery under a policy with no cosigners would be accepted. That is
  // exactly the trust a threshold of 0 places in the witness.
  const trusting: AuctionPolicy = { ...d.auction, cosigners: [], cosignerThreshold: 0 };
  const lone = new Witness(secretKey, undefined, d.service.origin);
  const b1 = await prepareBid(trusting, 4200, generateKeyPair());
  lone.submit(b1.submission);
  const b2 = await prepareBid(trusting, 4201, generateKeyPair());
  lone.submit(b2.submission);
  const loneClosing = lone.close(policyHash(trusting), d.beacon.info, d.beacon.release(100));
  const r2 = await verifyAuction({ policy: trusting, entries: lone.entries(), closing: loneClosing, envelopes: { [b1.submission.envelopeId]: b1.envelope, [b2.submission.envelopeId]: b2.envelope }, release: d.beacon.release(110) }, d.verifier);
  assert.equal(r2.winner?.amount, 4201);
});

test("cosigners speak C2SP tlog-witness: every refusal the protocol defines", async () => {
  const beacon = new TestBeacon();
  const clock = new TestClock(beacon, 10);
  const log = new Witness(undefined, undefined, "log.example/one");
  const cosigner = new Cosigner({ name: "cosigner.example", logs: [log.vkey], clock: scheduleClock(clock.source()) });
  const url = await listen(cosignerServer(cosigner));
  const post = async (body: string) => {
    const response = await fetch(url + "/add-checkpoint", { method: "POST", body });
    return { status: response.status, type: response.headers.get("content-type"), body: await response.text() };
  };
  const policy: AuctionPolicy = { format: POLICY_FORMAT, auctionId: "p", beacon: beacon.info, closeRound: 100, releaseRound: 110, witness: log.publicKey, origin: log.origin, logFrom: 0, cosigners: [], cosignerThreshold: 0, minBid: 1, maxBid: 10, rule: "highest-bid", tieBreak: "release-round-signature" };
  for (let i = 0; i < 3; i++) log.submit((await prepareBid(policy, 5, generateKeyPair())).submission);

  assert.equal((await post("old 0\n\n" + new Witness(undefined, undefined, "log.example/other").logCheckpoint())).status, 404, "unknown log");
  assert.equal((await post("old 0\n\n" + new Witness(undefined, undefined, "log.example/one").logCheckpoint())).status, 403, "not the log's key");
  assert.equal((await post("old 9\n\n" + log.logCheckpoint())).status, 400, "old size beyond the checkpoint");
  assert.equal((await post("old x\n\n" + log.logCheckpoint())).status, 400, "malformed");
  assert.equal((await post("old 0\n" + log.consistency(1).map((p) => p + "\n").join("") + "\n" + log.logCheckpoint())).status, 422, "old size 0 takes no proof");

  const first = await post("old 0\n\n" + log.logCheckpoint(2));
  assert.equal(first.status, 200);
  const note = parseNote(log.logCheckpoint(2) + first.body);
  assert.equal(note.signatures.length, 2, "the log's signature and one cosignature");

  const stale = await post("old 0\n\n" + log.logCheckpoint());
  assert.deepEqual([stale.status, stale.type, stale.body], [409, "text/x.tlog.size", "2\n"], "the client is told the latest cosigned size");
  const fork = new Witness(log.keys.secretKey, { entries: log.entries().slice(1), closings: [] }, log.origin);
  assert.equal((await post("old 2\n" + fork.consistency(2).map((p) => p + "\n").join("") + "\n" + fork.logCheckpoint())).status, 422, "a fork is never cosigned");
  assert.equal((await post("old 2\n" + log.consistency(2).map((p) => p + "\n").join("") + "\n" + log.logCheckpoint())).status, 200, "an honest extension is");
  assert.equal(cosigner.state.get(log.origin)?.size, 3);
});

test("cosignatures: thresholds, duplicates, outsiders and split views", async () => {
  const d = await deployment(2);
  const { policyHash: hash } = await d.client.registerPolicy(d.auction);
  const bid = await prepareBid(d.auction, 3000, generateKeyPair());
  await d.client.submit(bid.submission, bid.envelope);
  d.clock.advanceTo(100);
  await d.service.tick();
  d.clock.advanceTo(110);
  const evidence = (await d.client.evidence(hash)) as unknown as AuctionInputs;
  assert.equal((await verifyAuction(evidence, d.verifier)).ok, true);
  const [text, signatures] = evidence.witnessed!.checkpoint.split("\n\n") as [string, string];
  const [logLine, first] = signatures.split("\n");
  const only = (lines: string[]) => ({ ...evidence, witnessed: { ...evidence.witnessed!, checkpoint: `${text}\n\n${lines.map((l) => l + "\n").join("")}` } });
  assert.equal((await verifyAuction(only([logLine!, first!]), d.verifier)).ok, false, "threshold is 2");
  assert.equal((await verifyAuction(only([logLine!, first!, first!]), d.verifier)).ok, false, "the same cosigner twice counts once");
  const outsider = new Cosigner({ name: "outsider.example", logs: [d.service.vkey], clock: () => 105 });
  const reply = await outsider.addCheckpoint(`old 0\n\n${text}\n\n${logLine}\n`);
  assert.equal(reply.status, 200);
  assert.equal((await verifyAuction(only([logLine!, first!, reply.body.trimEnd()]), d.verifier)).ok, false, "a cosigner the policy does not name does not count");

  // A policy must require more than half of its cosigners, or a witness could
  // show one log to some and another log to the rest.
  assert.throws(() => policyHash({ ...d.auction, cosignerThreshold: 1 }), /more than half/);

  // A witness that only asks after the release gets nothing that counts.
  const d2 = await deployment(1);
  const { policyHash: hash2 } = await d2.client.registerPolicy(d2.auction);
  d2.clock.advanceTo(110);
  await d2.service.tick();
  const e2 = (await d2.client.evidence(hash2)) as unknown as AuctionInputs;
  assert.equal(e2.witnessed, undefined);
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
