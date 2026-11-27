/**
 * Mattering's MCP server, driven by the official MCP client: two assistants,
 * one for each firm, open and join a negotiation table, seal offers round by
 * round, and reach a deal that anyone watching can work out again from the
 * evidence. The server's word is not taken for the result.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { verifyAuction, type AuctionInputs, type BeaconInfo, type MandateOpening, type Side } from "@mattering/core";
import { bidOpenerWithFileKeys } from "@mattering/core/recipients";
import { verifyNegotiation, verifyNegotiationStep, withFileKeys, type StepInputs } from "@mattering/core/negotiation";
import { startShowcase } from "../apps/showcase/src/server.ts";

type Result = { content: { type: string; text: string }[]; structuredContent?: Record<string, unknown>; isError?: boolean };
type Status = { state: string; currentRound: { round: number; youHaveSealed: boolean; otherSideHasSealed: boolean; secondsUntilClose: number } | null; openedRounds: { round: number; yourOffer: number; theirOffer: number; outcome: { deal: boolean } }[]; result: { deal: boolean; price?: number } | null; yourLimit: number };

async function assistant(url: string, name: string): Promise<{ call: (tool: string, args: Record<string, unknown>) => Promise<Result>; close: () => Promise<void> }> {
  const client = new Client({ name, version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`)));
  return { call: async (tool, args) => (await client.callTool({ name: tool, arguments: args })) as Result, close: () => client.close() };
}

const until = async <T>(get: () => Promise<T>, done: (v: T) => boolean, what: string): Promise<T> => {
  for (let i = 0; i < 400; i++) {
    const v = await get();
    if (done(v)) return v;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for ${what}`);
};

test("two assistants negotiate at a table through MCP, and anyone can check the result", async () => {
  // Round windows of 30 seconds scaled down to about a second, on a fast simulated clock.
  const { url, stop } = await startShowcase({ mode: "simulated", roundMs: 100, tableTimeScale: 0.04 });
  const acme = await assistant(url, "acme-assistant");
  const bolt = await assistant(url, "bolt-assistant");
  try {
    // What an assistant is offered.
    const listed = await (async () => {
      const client = new Client({ name: "lister", version: "1.0.0" });
      await client.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`)));
      const all = (await client.listTools()).tools;
      const instructions = client.getInstructions();
      await client.close();
      // Every tool says it is a demonstration, not binding and with no payment, and that it acts only on Mattering's tables.
      for (const t of all) {
        assert.match(t.description ?? "", /^Demonstration environment: .*not legally binding and no payment is made/, t.name);
        assert.equal(t.annotations?.openWorldHint, false, t.name);
      }
      return { tools: all.map((t) => t.name), instructions };
    })();
    assert.deepEqual(listed.tools, ["start_negotiation", "join_negotiation", "wait_for_next_round", "make_offer", "negotiation_status", "leave_negotiation", "start_auction", "join_auction", "place_bid", "open_auction", "auction_status"]);
    assert.match(listed.instructions ?? "", /^Demonstration environment: .*not legally binding/);

    // An assistant that has not asked its user is sent back to ask, and nothing is opened.
    const unasked = await acme.call("start_negotiation", { side: "buyer", item: "A Sony TV", minPrice: 500, maxPrice: 1500, limit: 1200 });
    assert.equal(unasked.isError, true);
    assert.match(unasked.content[0]!.text, /^Not yet: ask your user for how many rounds at most; how long each round should stay open; and whether you should bid autonomously or ask them to approve each offer/);

    // Acme's assistant opens the table as the buyer, with its limit, bidding by itself.
    const opened = await acme.call("start_negotiation", { side: "buyer", item: "Early payment of invoice INV-2041 (£10,000, due in 60 days)", minPrice: 9000, maxPrice: 10000, limit: 9750, rounds: 3, roundSeconds: 30, autonomous: true });
    assert.equal(opened.isError, undefined, opened.content[0]?.text);
    // Every reply says so too, in words and as data.
    assert.match(opened.content[0]!.text, /^\[Demonstration environment: /);
    assert.deepEqual([(opened.structuredContent!.environment as { name: string }).name, (opened.structuredContent!.environment as { legallyBinding: boolean }).legallyBinding, (opened.structuredContent!.environment as { paymentsMade: boolean }).paymentsMade], ["demonstration", false, false]);
    assert.match((opened.structuredContent!.environment as { clock: string }).clock, /simulated/);
    const acmeToken = opened.structuredContent!.token as string;
    const invite = opened.structuredContent!.invite as string;
    const tableId = opened.structuredContent!.tableId as string;
    // The token and the invite say what they are, and the defaults chosen are named for the user.
    assert.match(acmeToken, /^tok_[0-9a-f]{24}_[0-9a-f]{32}$/);
    assert.match(invite, /^inv_[0-9a-f]{24}_[0-9a-f]{32}$/);
    assert.match(opened.content[0]!.text, /Share only this invite with the other party: inv_/);
    assert.match(opened.content[0]!.text, /Defaults used, tell your user: unit: GBP, organisation: The buyer\./);
    assert.match(opened.structuredContent!.rules as string, /two parties only.*midpoint/);
    // A table is a session on Mattering's platform.
    assert.match(tableId, /^ses_[0-9a-f]{24}$/);
    assert.match(opened.structuredContent!.watchUrl as string, new RegExp(`/demo/table\\?id=${tableId}$`));
    const waiting = (await acme.call("negotiation_status", { token: acmeToken })).structuredContent as unknown as Status;
    assert.equal(waiting.state, "waiting for the other side to join");

    // Mixing them up is caught: a token is not an invite, and an invite is not a token.
    assert.match((await bolt.call("join_negotiation", { invite: acmeToken, limit: 9600, autonomous: false })).content[0]!.text, /That is a token, which is secret, not an invite/);
    assert.match((await acme.call("negotiation_status", { token: invite })).content[0]!.text, /That is the invite/);
    // Bolt's assistant joins as the seller, asking its user to approve each offer. An invite cannot be used twice.
    assert.match((await bolt.call("join_negotiation", { invite, limit: 9600 })).content[0]!.text, /ask your user for whether you should bid autonomously/);
    const joined = await bolt.call("join_negotiation", { invite, limit: 9600, organisation: "Bolt Ltd", autonomous: false });
    assert.equal(joined.structuredContent!.side, "seller");
    assert.match(joined.content[0]!.text, /asking your user to approve each offer\. Read the terms back to your user/);
    const boltToken = joined.structuredContent!.token as string;
    assert.equal((await bolt.call("join_negotiation", { invite, limit: 9600, autonomous: true })).isError, true);
    // Round 1 has not begun: it waits for the opener to check in, so no round runs while the opener is away.
    const before = (await bolt.call("negotiation_status", { token: boltToken })).structuredContent as unknown as Status;
    assert.equal(before.state, "waiting for both sides to check in");
    assert.match((await bolt.call("make_offer", { token: boltToken, price: 9950, approvedByUser: true })).content[0]!.text, /round 1 has not begun/);
    // Acme's assistant checks in by waiting; round 1 begins, and it is told at once that it owes an offer.
    const checkedIn = await acme.call("wait_for_next_round", { token: acmeToken, maxSeconds: 5 });
    assert.match(checkedIn.structuredContent!.changed as string, /^Round 1 is open and you have not sealed an offer for it yet/);
    // Bolt's next step is to propose to its user, and an offer without the user's approval is sent back.
    assert.match(((await bolt.call("negotiation_status", { token: boltToken })).structuredContent!.nextStep as string), /^Propose an offer for round 1 to your user/);
    const unapproved = await bolt.call("make_offer", { token: boltToken, price: 9950 });
    assert.equal(unapproved.isError, true);
    assert.match(unapproved.content[0]!.text, /ask them to approve 9950 GBP for round 1, then call make_offer again with approvedByUser: true/);

    // The mandate binds: an offer beyond the side's own limit is refused.
    const beyond = await acme.call("make_offer", { token: acmeToken, price: 9800 });
    assert.equal(beyond.isError, true);
    assert.match(beyond.content[0]!.text, /mandate lets you pay at most 9750/);

    // Round 1: far apart. Only the first offer in a round counts.
    assert.equal((await acme.call("make_offer", { token: acmeToken, price: 9400, note: "We open low." })).structuredContent!.round, 1);
    assert.equal((await acme.call("make_offer", { token: acmeToken, price: 9450 })).isError, true, "a second offer in the same round is refused");
    assert.equal((await bolt.call("make_offer", { token: boltToken, price: 9950, approvedByUser: true })).structuredContent!.round, 1);
    const mid = (await bolt.call("negotiation_status", { token: boltToken })).structuredContent as unknown as Status;
    assert.equal(mid.currentRound?.youHaveSealed, true);
    assert.equal(mid.currentRound?.otherSideHasSealed, true);
    assert.equal(mid.openedRounds.length, 0, "nothing is known about the other side until the round opens");

    // Neither assistant is told when round 1 opens: it waits, and the wait returns when the table moves on.
    const waited = await bolt.call("wait_for_next_round", { token: boltToken, maxSeconds: 20 });
    assert.match(waited.structuredContent!.changed as string, /^Round 1 has opened: no deal yet/);
    assert.match(waited.structuredContent!.nextStep as string, /make_offer/);
    // Asked to wait while it still owes an offer, it says so at once rather than waiting.
    const owes = await acme.call("wait_for_next_round", { token: acmeToken, maxSeconds: 20 });
    assert.match(owes.structuredContent!.changed as string, /not sealed an offer/);
    // A note stays hidden from the watch page, which both sides have, until the negotiation is over.
    const midState = (await (await fetch(`${url}/table/${tableId}/negotiation/state`)).json()) as { run: { steps: { notes: Partial<Record<Side, string>> }[] } };
    assert.deepEqual(midState.run.steps[0]!.notes, {}, "no note is shown while the negotiation runs");
    // Round 2 begins once round 1 opens; each side then sees both opened offers.
    // Anyone watching can check each opened round, but neither side's limit is given until the end.
    const early = (await (await fetch(`${url}/table/${tableId}/negotiation/disclosure/1`)).json()) as { fileKeys: Record<string, string>; openings: Record<string, unknown> };
    assert.equal(Object.keys(early.fileKeys).length, 2);
    assert.deepEqual(early.openings, {}, "the limits stay hidden while the negotiation runs");
    const r2 = await until(async () => (await bolt.call("negotiation_status", { token: boltToken })).structuredContent as unknown as Status, (s) => s.currentRound?.round === 2, "round 2");
    assert.deepEqual(r2.openedRounds.map((r) => [r.yourOffer, r.theirOffer, r.outcome.deal]), [[9950, 9400, false]]);
    await acme.call("make_offer", { token: acmeToken, price: 9700 });
    await bolt.call("make_offer", { token: boltToken, price: 9650, approvedByUser: true });
    const finished = await acme.call("wait_for_next_round", { token: acmeToken, maxSeconds: 20 });
    assert.match(finished.structuredContent!.changed as string, /negotiation is over: the offers crossed, a deal at 9675/);
    assert.match(finished.content[0]!.text, /Report the result, with its receipt/);
    // The receipt: what anyone can check the result against, with where to fetch each round's evidence.
    const receipt = finished.structuredContent!.receipt as { negotiationId: string; rounds: { round: number; policyHash: string; openedAtDrandRound: number; evidence: string }[] };
    assert.equal(receipt.rounds.length, 2);
    assert.match(finished.content[0]!.text, /Receipt \(ses_[0-9a-f]{24}\): round 1: policy [0-9a-f]{16}…, opened at drand round \d+, evidence http/);
    const evidence = (await (await fetch(receipt.rounds[1]!.evidence)).json()) as { policyHash: string; state: string };
    assert.equal(evidence.state, "released", "each round's evidence is public at the receipt's address");
    const done = (await acme.call("negotiation_status", { token: acmeToken })).structuredContent as unknown as Status;
    assert.deepEqual(done.result, { deal: true, price: 9675, buyerOffer: 9700, sellerOffer: 9650 });

    // Anyone with the watch link checks it from the evidence and the firms' disclosures, not the server's word.
    const get = async <T>(path: string): Promise<T> => (await (await fetch(`${url}/table/${tableId}${path}`)).json()) as T;
    const state = await get<{ beacon: BeaconInfo; firms: Record<Side, { organisation: string }>; run: { done: boolean; steps: { step: number; notes: Partial<Record<Side, string>> }[] } }>("/negotiation/state");
    assert.equal(state.run.done, true);
    assert.equal(state.firms.buyer.organisation, "The buyer");
    assert.equal(state.run.steps[0]!.notes.buyer, "We open low.", "notes are shown once the negotiation is over");
    const verifier = { acceptedBeacons: [state.beacon] };
    const disclosures = await Promise.all(state.run.steps.map((s) => get<{ evidence: StepInputs; fileKeys: Record<string, string>; openings: Record<Side, MandateOpening> }>(`/negotiation/disclosure/${s.step}`)));
    for (const d of disclosures) assert.equal((await verifyNegotiationStep(d.evidence, withFileKeys(d.fileKeys), verifier, d.openings)).ok, true);
    const chain = await verifyNegotiation(disclosures.map((d) => d.evidence), withFileKeys(Object.assign({}, ...disclosures.map((d) => d.fileKeys)) as Record<string, string>), verifier);
    assert.equal(chain.ok, true, chain.problem);
    assert.deepEqual(chain.outcome, { deal: true, price: 9675, buyerOffer: 9700, sellerOffer: 9650, step: 2 });
    assert.deepEqual(disclosures[0]!.openings.buyer.limit, 9750);
    assert.equal((await fetch(`${url}/demo/table?id=${tableId}`)).status, 200, "the watch page is served");

    // A token for the wrong table, or no token, is refused.
    assert.equal((await acme.call("negotiation_status", { token: "not-a-token" })).isError, true);
  } finally {
    await acme.close();
    await bolt.close();
    stop();
  }
});

test("either side can walk away, and the other is told", async () => {
  const { url, stop } = await startShowcase({ mode: "simulated", roundMs: 100, tableTimeScale: 0.04 });
  const a = await assistant(url, "a");
  const b = await assistant(url, "b");
  try {
    const opened = await a.call("start_negotiation", { side: "seller", item: "A Sony TV", minPrice: 500, maxPrice: 1500, limit: 900, rounds: 3, roundSeconds: 60, autonomous: true, unit: "GBP", organisation: "Seller" });
    const joined = await b.call("join_negotiation", { invite: opened.structuredContent!.invite, limit: 1100, autonomous: true });
    const left = await b.call("leave_negotiation", { token: joined.structuredContent!.token });
    assert.match(left.content[0]!.text, /You have left the negotiation/);
    const told = await a.call("wait_for_next_round", { token: opened.structuredContent!.token, maxSeconds: 5 });
    assert.match(told.structuredContent!.changed as string, /over/);
    assert.deepEqual(told.structuredContent!.result, { deal: false, reason: "the other side left the negotiation" });
    assert.equal((await a.call("make_offer", { token: opened.structuredContent!.token, price: 1000 })).isError, true, "no offers after it has ended");
  } finally {
    await a.close();
    await b.close();
    stop();
  }
});

test("the MCP endpoint answers POST only, and on a laptop only to pages on this machine", async () => {
  const { url, stop } = await startShowcase({ mode: "simulated", roundMs: 100 });
  try {
    assert.equal((await fetch(`${url}/mcp`)).status, 405);
    const init = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } };
    const post = (origin?: string) => fetch(`${url}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(origin ? { origin } : {}) }, body: JSON.stringify(init) });
    const ok = await post();
    assert.equal(ok.status, 200);
    assert.equal(((await ok.json()) as { result: { protocolVersion: string } }).result.protocolVersion, "2025-06-18");
    assert.equal((await post("https://evil.example")).status, 403);
    assert.equal((await post("http://localhost:5173")).status, 200);
    const note = await fetch(`${url}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) });
    assert.equal(note.status, 202);
  } finally {
    stop();
  }
});

test("an organiser's assistant runs a sealed-bid auction through MCP; three bidders' assistants bid, and the result checks out", async () => {
  const KEY = "mk_test_mcpauctioncheck00000";
  // The test may read the evidence and keys as the MCP's own integrator would.
  const { url, stop } = await startShowcase({ mode: "simulated", roundMs: 100, tableTimeScale: 0.04, apiKeys: { [KEY]: "mattering-mcp" } });
  const desk = await assistant(url, "desk-assistant");
  const funders = await Promise.all(["a", "b", "c"].map((n) => assistant(url, `funder-${n}`)));
  try {
    const unasked = await desk.call("start_auction", { item: "Funding of invoice INV-88213", minBid: 50, maxBid: 1500 });
    assert.match(unasked.content[0]!.text, /^Not yet: ask your user for whether the highest or the lowest bid wins; how many bidders to invite; and how long bidding should stay open/);
    const opened = await desk.call("start_auction", { item: "Funding of invoice INV-88213: £250,000, due in 90 days", unit: "bps", minBid: 50, maxBid: 1500, rule: "lowest-bid", reserve: 900, bidders: 3, biddingSeconds: 30, organisation: "Northbank Receivables" });
    assert.equal(opened.isError, undefined, opened.content[0]?.text);
    assert.match(opened.structuredContent!.rules as string, /organiser, who does not bid/);
    const deskToken = opened.structuredContent!.token as string;
    const invites = opened.structuredContent!.invites as string[];
    const auctionId = opened.structuredContent!.auctionId as string;
    assert.equal(invites.length, 3);
    assert.match(opened.content[0]!.text, /Give each bidder one of these invites/);

    // Each funder's assistant joins with its user's limit: for a funding auction, the least it will accept.
    assert.match((await funders[0]!.call("join_negotiation", { invite: invites[0], limit: 600, autonomous: true })).content[0]!.text, /That invite is for an auction: use join_auction/);
    const limits = [700, 650, 880];
    const tokens: string[] = [];
    for (const [i, f] of funders.entries()) {
      const joined = await f.call("join_auction", { invite: invites[i], limit: limits[i], autonomous: i !== 2, organisation: `Funder ${"ABC"[i]}` });
      assert.equal(joined.isError, undefined, joined.content[0]?.text);
      tokens.push(joined.structuredContent!.token as string);
      if (i < 2) assert.match((await desk.call("auction_status", { token: deskToken })).structuredContent!.state as string, new RegExp(`waiting for bidders: ${i + 1} of 3`));
    }
    // The last to join opened bidding.
    assert.match((await funders[0]!.call("wait_for_next_round", { token: tokens[0], maxSeconds: 5 })).structuredContent!.changed as string, /^Bidding is open and you have not placed your bid yet/);
    assert.equal((await desk.call("place_bid", { token: deskToken, amount: 500 })).isError, true, "the organiser does not bid");
    assert.match((await funders[0]!.call("place_bid", { token: tokens[0], amount: 690 })).content[0]!.text, /limit lets you bid no less than 700/);
    assert.equal((await funders[0]!.call("place_bid", { token: tokens[0], amount: 731 })).structuredContent!.sealed, true);
    assert.equal((await funders[0]!.call("place_bid", { token: tokens[0], amount: 720 })).isError, true, "one bid only");
    await funders[1]!.call("place_bid", { token: tokens[1], amount: 677 });
    assert.match((await funders[2]!.call("place_bid", { token: tokens[2], amount: 905 })).content[0]!.text, /ask them to approve 905 bps, then call place_bid again with approvedByUser: true/);
    await funders[2]!.call("place_bid", { token: tokens[2], amount: 905, approvedByUser: true });
    const sealed = (await desk.call("auction_status", { token: deskToken })).structuredContent!;
    assert.equal(sealed.result, null, "nothing is known until the bids open");

    const done = await desk.call("wait_for_next_round", { token: deskToken, maxSeconds: 30 });
    const doneNow = done.structuredContent!.state === "finished" ? done : await until(() => desk.call("wait_for_next_round", { token: deskToken, maxSeconds: 30 }), (r) => r.structuredContent!.state === "finished", "the result");
    assert.match(doneNow.content[0]!.text, /Funder B won with 677|Report the result/);
    const result = doneNow.structuredContent!.result as { winner: { name: string; amount: number }; reserveMet: boolean; bids: { name: string; amount: number }[] };
    assert.deepEqual([result.winner.name, result.winner.amount, result.reserveMet], ["Funder B", 677, true]);
    assert.deepEqual(result.bids.map((b) => [b.name, b.amount]), [["Funder B", 677], ["Funder A", 731], ["Funder C", 905]], "the organiser sees every bid");
    const asLoser = (await funders[2]!.call("auction_status", { token: tokens[2] })).structuredContent!.result as { winner: { name: string }; yourBid: number; bids?: unknown };
    assert.deepEqual([asLoser.winner.name, asLoser.yourBid, asLoser.bids], ["Funder B", 905, undefined], "a bidder sees the winner and its own bid");

    // The result is worked out again from the public log's evidence and the disclosed keys, not taken from the server.
    const evidence = (await (await fetch(`${url}/api/v1/sessions/${auctionId}/evidence`, { headers: { authorization: `Bearer ${KEY}` } })).json()) as { beacon: BeaconInfo; rounds: AuctionInputs[]; fileKeys: Record<string, string> };
    const checked = await verifyAuction(evidence.rounds[0]!, { acceptedBeacons: [evidence.beacon] }, bidOpenerWithFileKeys(evidence.fileKeys));
    assert.equal(checked.winner?.amount, 677);
  } finally {
    await desk.close();
    for (const f of funders) await f.close();
    stop();
  }
});
