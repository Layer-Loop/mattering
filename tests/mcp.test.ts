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
import type { BeaconInfo, MandateOpening, Side } from "@mattering/core";
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
    assert.deepEqual(listed.tools, ["start_negotiation", "join_negotiation", "negotiation_status", "wait_for_next_round", "make_offer"]);
    assert.match(listed.instructions ?? "", /^Demonstration environment: .*not legally binding/);

    // An assistant that has not asked its user is sent back to ask, and nothing is opened.
    const unasked = await acme.call("start_negotiation", { side: "buyer", item: "A Sony TV", minPrice: 500, maxPrice: 1500, limit: 1200 });
    assert.equal(unasked.isError, true);
    assert.match(unasked.content[0]!.text, /^Not yet: ask your user for how long each round should stay open; and whether you should bid autonomously or ask them to approve each offer/);

    // Acme's assistant opens the table as the buyer, with its limit, bidding by itself.
    const opened = await acme.call("start_negotiation", { side: "buyer", item: "Early payment of invoice INV-2041 (£10,000, due in 60 days)", minPrice: 9000, maxPrice: 10000, limit: 9750, organisation: "Acme Treasury Ltd", rounds: 3, roundSeconds: 30, autonomous: true });
    assert.equal(opened.isError, undefined, opened.content[0]?.text);
    // Every reply says so too, in words and as data.
    assert.match(opened.content[0]!.text, /^\[Demonstration environment: /);
    assert.deepEqual([(opened.structuredContent!.environment as { name: string }).name, (opened.structuredContent!.environment as { legallyBinding: boolean }).legallyBinding, (opened.structuredContent!.environment as { paymentsMade: boolean }).paymentsMade], ["demonstration", false, false]);
    assert.match((opened.structuredContent!.environment as { clock: string }).clock, /simulated/);
    const acmeToken = opened.structuredContent!.token as string;
    const invite = opened.structuredContent!.invite as string;
    const tableId = opened.structuredContent!.tableId as string;
    assert.match(opened.content[0]!.text, /invite code/);
    assert.match(opened.structuredContent!.watchUrl as string, new RegExp(`/demo/table\\?id=${tableId}$`));
    const waiting = (await acme.call("negotiation_status", { token: acmeToken })).structuredContent as unknown as Status;
    assert.equal(waiting.state, "waiting for the other side to join");

    // Bolt's assistant joins as the seller, asking its user to approve each offer. An invite cannot be used twice.
    assert.match((await bolt.call("join_negotiation", { invite, limit: 9600 })).content[0]!.text, /ask your user for whether you should bid autonomously/);
    const joined = await bolt.call("join_negotiation", { invite, limit: 9600, organisation: "Bolt Ltd", autonomous: false });
    assert.equal(joined.structuredContent!.side, "seller");
    assert.match(joined.content[0]!.text, /asking your user to approve each offer\. Read the terms back to your user/);
    const boltToken = joined.structuredContent!.token as string;
    assert.equal((await bolt.call("join_negotiation", { invite, limit: 9600, autonomous: true })).isError, true);
    // Its next step is to propose to its user, and an offer without the user's approval is sent back.
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
    // Round 2 begins once round 1 opens; each side then sees both opened offers.
    const r2 = await until(async () => (await bolt.call("negotiation_status", { token: boltToken })).structuredContent as unknown as Status, (s) => s.currentRound?.round === 2, "round 2");
    assert.deepEqual(r2.openedRounds.map((r) => [r.yourOffer, r.theirOffer, r.outcome.deal]), [[9950, 9400, false]]);
    await acme.call("make_offer", { token: acmeToken, price: 9700 });
    await bolt.call("make_offer", { token: boltToken, price: 9650, approvedByUser: true });
    const finished = await acme.call("wait_for_next_round", { token: acmeToken, maxSeconds: 20 });
    assert.match(finished.structuredContent!.changed as string, /negotiation is over: round 2 opened and the offers crossed, a deal at 9675/);
    assert.match(finished.content[0]!.text, /Report the result/);
    const done = (await acme.call("negotiation_status", { token: acmeToken })).structuredContent as unknown as Status;
    assert.deepEqual(done.result, { deal: true, price: 9675, buyerOffer: 9700, sellerOffer: 9650 });

    // Anyone with the watch link checks it from the evidence and the firms' disclosures, not the server's word.
    const get = async <T>(path: string): Promise<T> => (await (await fetch(`${url}/table/${tableId}${path}`)).json()) as T;
    const state = await get<{ beacon: BeaconInfo; firms: Record<Side, { organisation: string }>; run: { done: boolean; steps: { step: number; notes: Partial<Record<Side, string>> }[] } }>("/negotiation/state");
    assert.equal(state.run.done, true);
    assert.equal(state.firms.buyer.organisation, "Acme Treasury Ltd");
    assert.equal(state.run.steps[0]!.notes.buyer, "We open low.", "notes are shown once the round has opened");
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
