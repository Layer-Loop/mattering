/**
 * The hosted witness and registry, end to end, over HTTP.
 *
 *   npm run example:hosted            against the real drand quicknet (about 45 seconds, needs internet)
 *   npm run example:hosted -- offline against a simulated beacon (instant)
 *
 * Starts a witness service and one independent cosigner on localhost, then
 * runs an auction between three agents and a round of sealed predictions, and
 * verifies both from the evidence the service publishes.
 */
import { mkdtempSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Cosigner,
  POLICY_FORMAT,
  QUICKNET,
  STATEMENT_POLICY_FORMAT,
  countCosignatures,
  generateKeyPair,
  prepareBid,
  prepareStatement,
  scheduleClock,
  systemClock,
  timeOfRound,
  verifyAuction,
  verifyStatements,
  type AuctionInputs,
  type AuctionPolicy,
  type BeaconSource,
  type StatementInputs,
  type StatementPolicy,
} from "@mattering/core";
import { drandSource } from "@mattering/core/drand-http";
import { TestBeacon, TestClock } from "@mattering/core/testing";
import { WitnessClient, WitnessService, cosignerServer, fileStore, httpCosign, witnessServer } from "@mattering/witness";

const offline = process.argv.includes("offline");
const say = (line = "") => process.stdout.write(line + "\n");
const short = (hex: string) => hex.slice(0, 12) + "…";
const listen = (server: Server) => new Promise<string>((resolve) => server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)));

// Each party gets its own view of the beacon.
const clock = offline ? new TestClock(new TestBeacon(), 10) : undefined;
const sourceFor = (): BeaconSource => (clock ? clock.source() : drandSource(QUICKNET));
const beacon = clock ? clock.testBeacon.info : QUICKNET;
const now = (await sourceFor().latest()).round;
const closeRound = now + (offline ? 5 : 6); // quicknet: about 18 seconds from now
const releaseRound = closeRound + (offline ? 5 : 6);

/** Wait until this process's own source has seen `round`. */
async function until(round: number, what: string): Promise<void> {
  if (clock) return clock.advanceTo(round);
  const ms = timeOfRound(beacon, round) * 1000 - Date.now() + 1500;
  say(`   …waiting ${Math.max(0, Math.round(ms / 1000))}s for ${what} (drand round ${round})`);
  await new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

// The cosigner speaks the same protocol as the public witness network, and keeps its own clock.
const cosigner = new Cosigner({ name: "localhost/example-cosigner", logs: [], clock: clock ? scheduleClock(clock.source()) : systemClock });
const cosignerUrl = await listen(cosignerServer(cosigner));
const service = await WitnessService.open({ store: fileStore(mkdtempSync(join(tmpdir(), "mattering-hosted-"))), source: sourceFor(), origin: "localhost/example-log", cosign: httpCosign({ [cosigner.vkey]: cosignerUrl }) });
cosigner.addLog(service.vkey);
const witnessUrl = await listen(witnessServer(service));
const ticker = setInterval(() => void service.tick().catch(() => {}), 1000);
const client = new WitnessClient(witnessUrl);
const verifier = { acceptedBeacons: [beacon] };

say(`Witness   ${short(service.publicKey)} at ${witnessUrl}`);
say(`Log       ${service.vkey}`);
say(`Cosigner  ${cosigner.vkey} at ${cosignerUrl}`);
say(`Beacon    ${offline ? "simulated (offline)" : "drand quicknet"}; close at round ${closeRound}, release at round ${releaseRound}`);

const terms = { beacon, closeRound, releaseRound, witness: service.publicKey, origin: service.origin, cosigners: [cosigner.vkey], cosignerThreshold: 1 };
const auction: AuctionPolicy = { format: POLICY_FORMAT, auctionId: "compute-lot-1", ...terms, minBid: 100, maxBid: 10_000, rule: "highest-bid", tieBreak: "release-round-signature" };
const forecast: StatementPolicy = { format: STATEMENT_POLICY_FORMAT, topic: "What will the winning bid for compute-lot-1 be?", ...terms };
const auctionHash = (await client.registerPolicy(auction)).policyHash;
const forecastHash = (await client.registerPolicy(forecast)).policyHash;

say("\n1. Three agents each seal a bid and a prediction");
const agents = [
  { name: "cautious", bid: 3000, guess: "around 4000" },
  { name: "eager", bid: 4370, guess: "mine, at 4370" },
  { name: "lowball", bid: 150, guess: "under 5000" },
].map((a) => ({ ...a, keys: generateKeyPair() }));
for (const agent of agents) {
  const bid = await prepareBid(auction, agent.bid, agent.keys);
  const guess = await prepareStatement(forecast, agent.guess, agent.keys);
  const r1 = await client.submit(bid.submission, bid.envelope);
  const r2 = await client.submit(guess.submission, guess.envelope);
  say(`   ${agent.name.padEnd(9)} key ${short(agent.keys.publicKey)}  receipts #${r1.index} and #${r2.index}`);
}
say(`   registry, while sealed: ${JSON.stringify((await client.submitter(agents[1]!.keys.publicKey)).commitments.map((c) => c.state))}`);

say("\n2. Close");
await until(closeRound, "the close");
// A late bid is refused from the scheduled close time, even before the witness
// has obtained the close round's signature and published its closing checkpoint.
let lateOutcome = "";
try {
  const late = await prepareBid(auction, 9999, generateKeyPair());
  await client.submit(late.submission, late.envelope);
  lateOutcome = "a late bid was accepted: THIS SHOULD NOT HAPPEN";
} catch (error) {
  lateOutcome = `a late bid of 9999: refused (${(error as Error).message})`;
}
let closed = await client.evidence(auctionHash);
const cosignatures = () => (closed.closing ? countCosignatures(closed.policy, closed.closing, closed.witnessed).cosigners.length : 0);
for (let i = 0; i < 20 && (closed.state === "open" || cosignatures() < 1); i++) {
  await new Promise((resolve) => setTimeout(resolve, clock ? 0 : 500));
  await service.tick().catch(() => {});
  closed = await client.evidence(auctionHash);
}
say(`   auction is ${closed.state}; closing checkpoint covers ${closed.closing?.size} entries, ${cosignatures()} cosignature(s)`);
say(`   ${lateOutcome}`);

say("\n3. Release");
await until(releaseRound, "the release");
const auctionResult = await verifyAuction((await client.evidence(auctionHash)) as unknown as AuctionInputs, verifier);
for (const check of auctionResult.checks) say(`   ${check.ok ? "PASS" : "FAIL"}  ${check.name}`);
for (const bid of auctionResult.bids) say(`   bid  ${short(bid.submitter)}  ${bid.status}  ${bid.amount ?? ""}`);
say(auctionResult.winner ? `   Winner: ${short(auctionResult.winner.submitter)} at ${auctionResult.winner.amount}` : "   No winner");

const statements = await verifyStatements((await client.evidence(forecastHash)) as unknown as StatementInputs, verifier);
say("\n4. Predictions, sealed before the close and opened now");
for (const s of statements.statements) say(`   ${short(s.author)}  ${s.status}  "${s.text ?? ""}"`);

say("\n5. Registry record for the winner");
for (const c of (await client.submitter(auctionResult.winner?.submitter ?? agents[0]!.keys.publicKey)).commitments) {
  say(`   #${c.index}  ${String(c.kind).padEnd(10)}  ${c.state}  ${c.amount ?? (c.text === undefined ? "" : `"${c.text}"`)}`);
}

clearInterval(ticker);
const good = auctionResult.ok && statements.ok && auctionResult.winner?.amount === 4370 && auctionResult.bids.length === 3;
say(good ? "\nOK" : "\nNOT OK: the run did not go as it should");
process.exit(good ? 0 : 1);
