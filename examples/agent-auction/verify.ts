/**
 * Re-check an auction from its published files. Shares no state with run.ts:
 * it reads auction.json, beacon.json and announced-result.json and recomputes
 * everything.
 *
 * beacon.json is the verifier's own statement of which clock it accepts. In
 * this offline example that is the test beacon; for a real auction it would
 * be drand quicknet, and this file would not come from the auction's operator.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sameOutcome, verifyAuction, type AuctionInputs, type BeaconInfo } from "@mattering/core";

const dir = process.argv[2] ?? join(import.meta.dirname, "out");
const read = (name: string) => JSON.parse(readFileSync(join(dir, name), "utf8")) as unknown;

const inputs = read("auction.json") as AuctionInputs;
const beacon = read("beacon.json") as BeaconInfo;
const announced = read("announced-result.json") as { submitter: string; amount: number } | null;

const result = await verifyAuction(inputs, { acceptedBeacons: [beacon] });
for (const check of result.checks) console.log(`${check.ok ? "PASS" : "FAIL"}  ${check.name}${check.detail && !check.ok ? `  (${check.detail})` : ""}`);
for (const bid of result.bids) console.log(`bid #${bid.index}  ${bid.status}${bid.amount === undefined ? "" : `  ${bid.amount}`}${bid.reason ? `  (${bid.reason})` : ""}`);
const agrees = sameOutcome(result, announced ?? undefined);
console.log(agrees ? `OK  the announced winner (${announced?.amount ?? "none"}) is what the evidence gives` : "NOT OK  the announced result does not follow from the evidence");
if (!agrees) process.exitCode = 1;
