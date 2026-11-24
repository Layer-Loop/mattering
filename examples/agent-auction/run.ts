/**
 * Three buyer agents bid for one lot of compute in a sealed-bid auction.
 *
 *   npm run example            runs offline against a local test beacon
 *   npm run example:verify     re-checks the result from the written files alone
 *
 * Everything here goes through @mattering/core's public interface. The agents
 * decide amounts; they have no say in any check.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  isSubmission,
  POLICY_FORMAT,
  Witness,
  generateKeyPair,
  open,
  policyHash,
  prepareBid,
  verifyAuction,
  verifyReceipt,
  verifySealedSubmission,
  type AuctionPolicy,
  type Envelope,
} from "@mattering/core";
import { TestBeacon } from "@mattering/core/testing";

/** An agent's whole role: look at the public policy and its private budget, name a price. */
type Strategy = (policy: AuctionPolicy, budget: number) => number | Promise<number>;

// Deterministic stand-ins. An LLM-backed agent is any function with this
// signature; whatever it returns is treated exactly like these.
const agents: { name: string; budget: number; strategy: Strategy }[] = [
  { name: "cautious", budget: 5000, strategy: (_p, budget) => Math.floor(budget * 0.6) },
  { name: "eager", budget: 4600, strategy: (_p, budget) => Math.floor(budget * 0.95) },
  { name: "lowball", budget: 9000, strategy: (p) => p.minBid + 50 },
];

const out = process.argv[2] ?? join(import.meta.dirname, "out");
const say = (line = "") => process.stdout.write(line + "\n");
const save = (name: string, value: unknown) => writeFileSync(join(out, name), JSON.stringify(value, null, 2) + "\n");
const short = (hex: string) => hex.slice(0, 12) + "…";

mkdirSync(out, { recursive: true });

// The clock. Offline, this is a local beacon whose rounds are emitted on demand.
const beacon = new TestBeacon();
const witness = new Witness();
const verifier = { acceptedBeacons: [beacon.info] };

const policy: AuctionPolicy = {
  format: POLICY_FORMAT,
  auctionId: "compute-lot-2026-11-23",
  beacon: beacon.info,
  closeRound: 100,
  releaseRound: 110,
  witness: witness.publicKey,
  origin: witness.origin,
  logFrom: witness.size,
  cosigners: [],
  cosignerThreshold: 0,
  minBid: 100,
  maxBid: 10_000,
  rule: "highest-bid",
  tieBreak: "release-round-signature",
};
const hash = policyHash(policy);
say(`1. Policy published      ${policy.auctionId}  (hash ${short(hash)})`);
say(`   bids ${policy.minBid}–${policy.maxBid}, close at round ${policy.closeRound}, open at round ${policy.releaseRound}`);

say("\n2. Agents bid");
const envelopes: Record<string, Envelope> = {};
for (const agent of agents) {
  const keys = generateKeyPair();
  const amount = await agent.strategy(policy, agent.budget);
  const { envelope, submission } = await prepareBid(policy, amount, keys);
  const receipt = witness.submit(submission);
  if (!verifyReceipt(receipt, submission, witness.publicKey)) throw new Error("bad receipt");
  envelopes[submission.envelopeId] = envelope;
  say(`   ${agent.name.padEnd(9)} sealed a bid, got receipt #${receipt.index}   (key ${short(keys.publicKey)})`);
  // The agent, its key and its amount go out of scope here. Nothing below needs them.
}

say("\n3. While sealed");
const first = witness.entries().filter(isSubmission)[0]!;
const sealedOk = verifySealedSubmission(policy, first, envelopes[first.envelopeId]!, verifier).every((c) => c.ok);
say(`   anyone can check a submission is well-formed: ${sealedOk ? "yes" : "NO"}`);
try {
  await open(envelopes[first.envelopeId]!, beacon.release(policy.closeRound), verifier);
  say("   a bid opened early: THIS SHOULD NOT HAPPEN");
} catch (error) {
  say(`   trying to open a bid with an earlier round's signature: refused (${(error as { code: string }).code})`);
}

const closing = witness.close(hash, beacon.info, beacon.release(policy.closeRound));
say(`\n4. Round ${policy.closeRound} emitted; witness closes the auction with ${closing.size} entries`);
try {
  witness.submit((await prepareBid(policy, 9999, generateKeyPair())).submission);
  say("   a late bid was accepted: THIS SHOULD NOT HAPPEN");
} catch {
  say("   a fourth agent bids 9999 now: refused as late");
}

const release = beacon.release(policy.releaseRound);
say(`\n5. Round ${policy.releaseRound} emitted; every bid can now be opened by anyone`);
const inputs = { policy, entries: witness.entries(), closing, envelopes, release };
const result = await verifyAuction(inputs, verifier);
for (const bid of result.bids) {
  say(`   #${bid.index}  ${short(bid.submitter)}  ${bid.status}${bid.amount === undefined ? "" : `  ${bid.amount}`}${bid.reason ? `  (${bid.reason})` : ""}`);
}
say(result.winner ? `\n   Winner: ${short(result.winner.submitter)} at ${result.winner.amount}` : "\n   No valid bid");

save("auction.json", inputs);
save("beacon.json", beacon.info);
save("announced-result.json", result.winner ?? null);
say(`\n6. Evidence written to ${out}`);
say("   Re-check it yourself:  npm run example:verify");
if (!result.ok) process.exitCode = 1;
