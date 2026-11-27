/**
 * @mattering/client against the platform API, in one process: an organiser
 * and its counterparties each with their own client, sealing locally, as they
 * would from their own machines.
 */
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { MatteringError, closeTime, generateKeyPair, scheduleClock, type BeaconInfo } from "@mattering/core";
import { TestBeacon, WallTestClock } from "@mattering/core/testing";
import { memoryStore } from "@mattering/witness";
import { Mattering, MatteringApiError, type Participant } from "@mattering/client";
import { LocalLogHost } from "../apps/showcase/src/log-host.ts";
import { localPlatform } from "../apps/platform/src/api.ts";

const ROUND_MS = 100;
const KEY = "mk_test_clientsdk00000000000";
const BASE = "https://api.example/api/v1";
const timers: ReturnType<typeof setInterval>[] = [];
after(() => timers.forEach(clearInterval));

interface Sent {
  method: string;
  path: string;
  body: string;
  idempotencyKey: string | null;
}

async function platform(options: { loseFirstBidReply?: boolean } = {}) {
  const clock = new WallTestClock(new TestBeacon(), Date.now() - 10 * ROUND_MS, ROUND_MS);
  const sourceFor = () => clock.source();
  const log = await LocalLogHost.open({
    store: memoryStore(),
    source: sourceFor(),
    origin: "client.example/log",
    minCosignIntervalMs: ROUND_MS,
    ownCosigner: { name: "client.example/cosigner", secretKey: generateKeyPair().secretKey, state: {}, persist: async () => {}, clock: scheduleClock(sourceFor()) },
  });
  const p = localPlatform({
    keys: { [KEY]: "Northbank Receivables" },
    base: "/api/v1",
    session: { mode: "simulated", sourceFor, timeOfRound: (r) => clock.timeOfRound(r), log, roundMs: ROUND_MS, releaseAfter: 3, timeScale: 0.05, fetch: async () => ({ ok: true, status: 200 }) },
  });
  // The host's timers.
  timers.push(setInterval(() => void p.work().catch(() => {}), 50));
  const sent: Sent[] = [];
  let lose = options.loseFirstBidReply ?? false;
  const fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (request.method === "POST") sent.push({ method: request.method, path: url.pathname, body: await request.clone().text(), idempotencyKey: request.headers.get("idempotency-key") });
    const response = await p.fetch(request);
    // The request arrives and is acted on, but its reply never comes back.
    if (lose && url.pathname.endsWith("/bids")) {
      lose = false;
      throw new TypeError("network connection lost");
    }
    return response;
  };
  const beacon = clock.testBeacon.info as BeaconInfo;
  const client = (apiKey?: string) => new Mattering({ baseUrl: BASE, fetch: fetch as typeof globalThis.fetch, acceptedBeacons: [beacon], pollMs: 50, ...(apiKey ? { apiKey } : {}) });
  return { client, sent, beacon, fetch };
}

test("client: a funding auction with the SDK; funders seal locally, the desk's own key opens the bids, and everyone checks the result", async () => {
  const w = await platform();
  const desk = w.client(KEY);
  const session = await desk.sessions.create({
    mechanism: "sealed-bid-auction",
    terms: { item: "Funding of invoice INV-88213: £250,000, due 2027-03-01", unit: "bps", minBid: 50, maxBid: 1500, rule: "lowest-bid", reserve: 900 },
    timing: { biddingSeconds: 30 },
    invitations: [{ label: "Funder A" }, { label: "Funder B" }, { label: "Funder C" }],
  });
  assert.ok(session.secrets().identity, "the desk's age identity was made here");
  assert.ok(!w.sent.some((s) => s.body.includes(session.secrets().identity!)), "and never sent");

  // Each funder has its own client and no API key: just the invitation.
  const funders: Participant[] = [];
  for (const inv of session.invitations) funders.push(await w.client().join(inv.code!));
  await session.open();
  const amounts = [731, 677, 905];
  await Promise.all(
    funders.map(async (f, i) => {
      const next = await f.next();
      assert.equal(next.kind, "bid");
      await f.bid(amounts[i]!);
    }),
  );
  const funderPosts = w.sent.filter((s) => s.path.endsWith("/bids"));
  assert.equal(funderPosts.length, 3);
  assert.ok(funderPosts.every((s) => !/"amount"/.test(s.body)), "no amount ever left a funder's machine");

  // The desk's client opens the bids with its own key and publishes; funders just wait.
  const result = await session.result();
  assert.deepEqual([(result.outcome as any).winner.label, (result.outcome as any).winner.amount], ["Funder B", 677]);
  const checked = await session.verify();
  assert.deepEqual([checked.ok, checked.matchesReported, (checked.outcome as any).winner.amount], [true, true, 677]);
  const asFunder = await funders[0]!.result();
  assert.equal((asFunder.outcome as any).winner.label, "Funder B");
  const funderCheck = await funders[0]!.verify();
  assert.equal(funderCheck.ok, false, "a funder cannot open the other bids under organiser confidentiality");
});

test("client: a negotiation with the SDK; each firm issues its agent's mandate locally, and the clients disclose each round themselves", async () => {
  const w = await platform();
  const desk = w.client(KEY);
  const session = await desk.sessions.create({
    mechanism: "negotiation",
    terms: { item: "Receivable RCV-4471: £120,000, due in 60 days", unit: "GBP", minPrice: 100_000, maxPrice: 120_000, rounds: 3 },
    timing: { biddingSeconds: 30 },
    invitations: [{ role: "buyer", label: "Northbank Capital" }, { role: "seller", label: "Harrow Supplies" }],
  });
  const expires = closeTime(w.beacon, 10_000_000);
  const code = (role: string) => session.invitations.find((i) => i.role === role)!.code!;
  const buyer = await w.client().join(code("buyer"), { limit: 116_000, organisation: { keys: generateKeyPair(), name: "Northbank Capital", expires } });
  const seller = await w.client().join(code("seller"), { limit: 112_000, organisation: { keys: generateKeyPair(), name: "Harrow Supplies", expires } });
  assert.equal(buyer.role, "buyer");
  await buyer.checkIn();

  // The agent's own safeguard: an offer beyond its mandate is refused before anything is sent.
  assert.equal((await buyer.next()).kind, "bid");
  await assert.rejects(buyer.offer(117_000), MatteringError);

  const plan = { buyer: [104_000, 114_000], seller: [118_000, 113_000] };
  const run = async (side: Participant, prices: number[]) => {
    for (;;) {
      const next = await side.next();
      if (next.kind !== "bid") return next;
      await side.offer(prices[next.round - 1]!);
    }
  };
  const [b, s] = await Promise.all([run(buyer, plan.buyer), run(seller, plan.seller)]);
  assert.equal(b.kind, "finished");
  assert.deepEqual(b.kind === "finished" && b.result.outcome, { kind: "negotiation", round: 2, deal: true, price: 113_500, buyerOffer: 114_000, sellerOffer: 113_000 });
  assert.equal(s.kind, "finished");
  assert.equal(w.sent.filter((x) => x.path.endsWith("/disclose")).length >= 2, true, "a side disclosed each opened round");
  for (const side of [buyer, seller]) assert.deepEqual(await side.verify(), { ok: true, outcome: { deal: true, price: 113_500, round: 2 }, matchesReported: true });
  const resumed = w.client().resume(seller.secrets());
  assert.equal((await resumed.state()).phase, "finished", "a participant picks up again from its secrets");
});

test("client: it will not seal to a beacon it does not accept, and a retried bid after a lost reply is the same bid", async () => {
  const w = await platform({ loseFirstBidReply: true });
  const desk = w.client(KEY);
  const create = { mechanism: "sealed-bid-auction", terms: { item: "x", unit: "GBP", minBid: 1, maxBid: 100, rule: "highest-bid" }, timing: { biddingSeconds: 30 }, confidentiality: "public", invitations: [{}, {}] };
  const session = await desk.sessions.create(create);
  // A client left on its default, drand quicknet, joins a session whose clock is a test beacon.
  const strict = new Mattering({ baseUrl: BASE, fetch: w.fetch as typeof fetch, pollMs: 50 });
  const careful = await strict.join(session.invitations[0]!.code!);
  const trusting = await w.client().join(session.invitations[1]!.code!);
  await session.open();
  await assert.rejects(careful.bid(50), (e: unknown) => e instanceof MatteringApiError && e.code === "untrusted-policy");
  assert.equal(w.sent.filter((s) => s.path.endsWith("/bids")).length, 0, "nothing was sent");

  // The first reply is lost; the client retries with the same Idempotency-Key and gets the same receipt.
  const receipt = await trusting.bid(60);
  const posts = w.sent.filter((s) => s.path.endsWith("/bids"));
  assert.equal(posts.length, 2);
  assert.equal(posts[0]!.idempotencyKey, posts[1]!.idempotencyKey);
  assert.equal((receipt as { round: number }).round, 1);
  assert.equal((await session.state()).round!.bids, 1, "one bid, not two");
});
