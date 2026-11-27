/**
 * The platform's session engine: sealed-bid auctions from creation to result,
 * on a real (in-memory) witness log and a fast simulated clock. Client-sealed
 * sessions are checked to hold no amount until the organiser discloses; every
 * result is checked against the evidence, not taken from the engine.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { generateKeyPair, scheduleClock, verifyAuction, type AuctionInputs, type BeaconInfo, type SealedAuctionPolicy } from "@mattering/core";
import { bidOpenerAs, bidOpenerWithFileKeys, discloseBids, generateRecipientKeys, prepareBidTo } from "@mattering/core/recipients";
import { TestBeacon, WallTestClock } from "@mattering/core/testing";
import { memoryStore } from "@mattering/witness";
import { LocalLogHost } from "../apps/showcase/src/log-host.ts";
import { Session, newSessionId, type Caller, type SessionState } from "../apps/platform/src/session.ts";

const ROUND_MS = 100;
const organiser: Caller = { role: "organiser", integrator: "int_test" };

async function world() {
  const clock = new WallTestClock(new TestBeacon(), Date.now() - 10 * ROUND_MS, ROUND_MS);
  const sourceFor = () => clock.source();
  const log = await LocalLogHost.open({
    store: memoryStore(),
    source: sourceFor(),
    origin: "sessions.example/log",
    minCosignIntervalMs: ROUND_MS,
    ownCosigner: { name: "sessions.example/cosigner", secretKey: generateKeyPair().secretKey, state: {}, persist: async () => {}, clock: scheduleClock(sourceFor()) },
  });
  let saved: SessionState | undefined;
  const session = await Session.open({
    mode: "simulated",
    sourceFor,
    timeOfRound: (round) => clock.timeOfRound(round),
    log,
    loadState: async () => saved,
    saveState: async (s) => void (saved = structuredClone(s)),
    roundMs: ROUND_MS,
    releaseAfter: 3,
    timeScale: 0.05, // a 30-second window becomes 1.5 seconds
  });
  const call = async (method: string, path: string, caller: Caller, body?: unknown) => session.handle(method, path, async () => body, caller);
  // Drive time until the session reaches a phase, as a host's timer would.
  const until = async (phase: string) => {
    for (let i = 0; i < 300 && session.phase !== phase; i++) {
      await session.work();
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.equal(session.phase, phase);
  };
  return { session, call, until, stored: () => saved!, verifier: { acceptedBeacons: [clock.testBeacon.info as BeaconInfo] } };
}

test("a client-sealed funding auction: bidders seal locally, the organiser alone reads the bids, and its disclosure publishes the result", async () => {
  const w = await world();
  const desk = await generateRecipientKeys();
  // Client sealing needs the organiser's own recipient key, so that the engine never holds it.
  const noKey = await w.call("POST", "/create", organiser, { id: newSessionId(), mechanism: "sealed-bid-auction", terms: { item: "x", unit: "bps", minBid: 50, maxBid: 1500, rule: "lowest-bid" }, invitations: [{}] });
  assert.equal(noKey.status, 400);
  assert.match((noKey.body as { error: { message: string } }).error.message, /organiserRecipient/);
  const id = newSessionId();
  const created = await w.call("POST", "/create", organiser, {
    id,
    mechanism: "sealed-bid-auction",
    terms: { item: "Funding of invoice INV-88213: £250,000, due 2027-03-01", unit: "bps", minBid: 50, maxBid: 1500, rule: "lowest-bid", reserve: 900 },
    timing: { biddingSeconds: 30 },
    confidentiality: "organiser",
    sealing: "client",
    organiserRecipient: desk.recipient,
    invitations: [{ label: "Funder A" }, { label: "Funder B" }, { label: "Funder C" }],
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const invitations = (created.body as { invitations: { code: string; label: string }[] }).invitations;
  assert.match(invitations[0]!.code, /^inv_[0-9a-f]{24}_[0-9a-f]{32}$/);

  // Each funder joins with its own key; opening needs two.
  const funders = invitations.map(() => generateKeyPair());
  const tokens: string[] = [];
  for (const [i, inv] of invitations.entries()) {
    const joined = await w.call("POST", "/join", { role: "public" }, { invitation: inv.code, publicKey: funders[i]!.publicKey });
    assert.equal(joined.status, 201, JSON.stringify(joined.body));
    tokens.push((joined.body as { token: string }).token);
  }
  assert.equal((await w.call("POST", "/join", { role: "public" }, { invitation: invitations[0]!.code, publicKey: generateKeyPair().publicKey })).status, 409, "an invitation is used once");
  assert.equal((await w.call("POST", "/open", { role: "participant", token: tokens[0]! }, {})).status, 403, "only the organiser opens");
  assert.equal((await w.call("POST", "/open", organiser, {})).status, 200);

  // Each seals locally against the round's policy and sends only the envelope and the signed submission.
  const { policy } = (await w.call("GET", "/round", { role: "public" })).body as { policy: SealedAuctionPolicy };
  const amounts = [731, 677, 905];
  for (const [i, amount] of amounts.entries()) {
    const bid = await prepareBidTo(policy, amount, funders[i]!);
    if (i === 0) assert.equal((await w.call("POST", "/bids", { role: "participant", token: tokens[0]! }, { amount: 700 })).status, 400, "a client-sealed session never takes an amount");
    const sent = await w.call("POST", "/bids", { role: "participant", token: tokens[i]! }, bid);
    assert.equal(sent.status, 201, JSON.stringify(sent.body));
    if (i === 0) {
      assert.equal((await w.call("POST", "/bids", { role: "participant", token: tokens[0]! }, bid)).status, 409, "one bid per participant");
    }
  }
  const forged = await prepareBidTo(policy, 60, generateKeyPair());
  assert.equal(((await w.call("POST", "/bids", { role: "participant", token: tokens[1]! }, forged)).body as { error: { code: string } }).error.code, "duplicate");

  // Nothing the engine holds says how much anyone bid.
  assert.equal(JSON.stringify(w.stored()).includes('"amount"'), false);

  await w.until("released");
  assert.equal((await w.call("POST", "/bids", { role: "participant", token: tokens[2]! }, await prepareBidTo(policy, 60, funders[2]!))).status, 409, "too late");
  const waiting = (await w.call("GET", "/", organiser)).body as { awaiting?: string; outcome?: unknown };
  assert.match(waiting.awaiting ?? "", /organiser's disclosure/);
  assert.equal(waiting.outcome, undefined, "the engine cannot read the bids, and publishes nothing");

  // The organiser opens the bids on its own machine, checks the result, and discloses the keys.
  const evidence = ((await w.call("GET", "/evidence", organiser)).body as { rounds: AuctionInputs[] }).rounds[0]!;
  const own = await verifyAuction(evidence, w.verifier, bidOpenerAs(desk.identity));
  assert.equal(own.winner?.amount, 677);
  const keys = await discloseBids(evidence, desk.identity, w.verifier);
  const partial = Object.fromEntries(Object.entries(keys).slice(0, 1));
  assert.equal(((await w.call("POST", "/disclose", organiser, { fileKeys: partial })).body as { error: { code: string } }).error.code, "incomplete");
  const published = await w.call("POST", "/disclose", organiser, { fileKeys: keys });
  assert.equal(published.status, 200, JSON.stringify(published.body));

  // The organiser sees every bid; a funder sees the winner and its own bid only; the receipt names the evidence.
  const asOrganiser = published.body as { phase: string; outcome: { winner: { label: string; amount: number }; reserveMet: boolean; bids: { label: string; amount: number }[] }; receipt: { rounds: { policyHash: string }[] } };
  assert.equal(asOrganiser.phase, "finished");
  assert.deepEqual([asOrganiser.outcome.winner.label, asOrganiser.outcome.winner.amount, asOrganiser.outcome.reserveMet], ["Funder B", 677, true]);
  assert.deepEqual(asOrganiser.outcome.bids.map((b) => [b.label, b.amount]), [["Funder B", 677], ["Funder A", 731], ["Funder C", 905]]);
  const asFunderC = (await w.call("GET", "/", { role: "participant", token: tokens[2]! })).body as { outcome: { winner: { label: string }; bids?: unknown }; you: { yourBid: { amount: number; status: string } } };
  assert.equal(asFunderC.outcome.winner.label, "Funder B");
  assert.equal(asFunderC.outcome.bids, undefined, "losing bids are the organiser's to see");
  assert.deepEqual([asFunderC.you.yourBid.amount, asFunderC.you.yourBid.status], [905, "valid"]);
  // Anyone given the published evidence and keys reaches the same winner.
  const bundle = (await w.call("GET", "/evidence", { role: "public" })).body as { rounds: AuctionInputs[]; fileKeys: Record<string, string> };
  assert.equal((await verifyAuction(bundle.rounds[0]!, w.verifier, bidOpenerWithFileKeys(bundle.fileKeys))).winner?.amount, 677);
  assert.equal(asOrganiser.receipt.rounds[0]!.policyHash, (evidence as unknown as { policyHash: string }).policyHash);
});

test("a server-sealed public auction, for callers that cannot seal: the engine seals, says so, and publishes the result itself", async () => {
  const w = await world();
  const created = await w.call("POST", "/create", organiser, {
    id: newSessionId(),
    mechanism: "sealed-bid-auction",
    terms: { item: "A Sony TV, boxed", unit: "GBP", minBid: 300, maxBid: 1500, rule: "highest-bid" },
    timing: { biddingSeconds: 30 },
    confidentiality: "public",
    sealing: "server",
    invitations: [{ label: "Claude" }, { label: "ChatGPT" }],
  });
  const invitations = (created.body as { invitations: { code: string }[] }).invitations;
  const tokens = await Promise.all(invitations.map(async (inv) => ((await w.call("POST", "/join", { role: "public" }, { invitation: inv.code })).body as { token: string }).token));
  await w.call("POST", "/open", organiser, {});
  assert.equal((await w.call("POST", "/bids", { role: "participant", token: tokens[0]! }, { amount: 2000 })).status, 400, "outside the range");
  for (const [i, amount] of [820, 860].entries()) assert.equal((await w.call("POST", "/bids", { role: "participant", token: tokens[i]! }, { amount })).status, 201);
  await w.until("finished");
  const view = (await w.call("GET", "/", { role: "participant", token: tokens[0]! })).body as { trust: string; outcome: { winner: { label: string; amount: number }; bids: { amount: number }[] } };
  assert.match(view.trust, /^server-sealed: Mattering held the bidders' keys/);
  assert.deepEqual([view.outcome.winner.label, view.outcome.winner.amount], ["ChatGPT", 860]);
  assert.deepEqual(view.outcome.bids.map((b) => b.amount), [860, 820], "public bids are everyone's to see");
});

test("a session needs a quorum: it will not open with one bidder, expires without one, and can be cancelled", async () => {
  const w = await world();
  const base = { mechanism: "sealed-bid-auction", terms: { item: "x", unit: "GBP", minBid: 1, maxBid: 100, rule: "highest-bid" }, confidentiality: "public", sealing: "server", invitations: [{}, {}] };
  const created = await w.call("POST", "/create", organiser, { ...base, id: newSessionId(), timing: { biddingSeconds: 30, quorumBy: new Date(Date.now() + 600).toISOString() } });
  const inv = (created.body as { invitations: { code: string }[] }).invitations;
  await w.call("POST", "/join", { role: "public" }, { invitation: inv[0]!.code });
  assert.equal(((await w.call("POST", "/open", organiser, {})).body as { error: { code: string } }).error.code, "no-quorum");
  await w.until("expired");

  const w2 = await world();
  await w2.call("POST", "/create", organiser, { ...base, id: newSessionId() });
  assert.equal((await w2.call("POST", "/cancel", { role: "organiser", integrator: "someone-else" }, {})).status, 403);
  assert.equal(((await w2.call("POST", "/cancel", organiser, {})).body as { phase: string }).phase, "cancelled");
});

test("terms and settings are checked before anything is created", async () => {
  const w = await world();
  const bad = async (body: Record<string, unknown>) => ((await w.call("POST", "/create", organiser, { id: newSessionId(), mechanism: "sealed-bid-auction", confidentiality: "public", sealing: "server", invitations: [{}], ...body })).body as { error: { code: string; message: string } }).error;
  assert.match((await bad({ terms: { item: "x", unit: "GBP", minBid: 1, maxBid: 100, rule: "middle" } })).message, /terms.rule/);
  assert.match((await bad({ terms: { item: "x", unit: "GBP", minBid: 1, maxBid: 100, rule: "highest-bid", reserve: 500 } })).message, /terms.reserve/);
  assert.match((await bad({ mechanism: "dutch", terms: {} })).message, /mechanism/);
  assert.equal((await w.call("POST", "/create", { role: "public" }, { id: newSessionId() })).status, 403, "creating a session needs an API key");
});
