/**
 * The platform's HTTP API, version 1, in one process: requests as an
 * integrator, its funders and an outsider would send them, against real
 * (in-memory) sessions and log on a fast simulated clock.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { generateKeyPair, scheduleClock, verifyAuction, type AuctionInputs, type BeaconInfo, type SealedAuctionPolicy } from "@mattering/core";
import { bidOpenerAs, bidOpenerWithFileKeys, discloseBids, generateRecipientKeys, prepareBidTo } from "@mattering/core/recipients";
import { TestBeacon, WallTestClock } from "@mattering/core/testing";
import { memoryStore } from "@mattering/witness";
import { LocalLogHost } from "../apps/showcase/src/log-host.ts";
import { localPlatform } from "../apps/platform/src/api.ts";
import { verifyDelivery } from "../apps/platform/src/hosted.ts";
import { OPENAPI } from "../apps/platform/src/openapi.ts";

const ROUND_MS = 100;
const KEY = "mk_test_0123456789abcdefABCD";
const OTHER_KEY = "mk_test_ffffffffffffffffffff";

interface Delivery {
  url: string;
  headers: Record<string, string>;
  body: string;
}

async function platform(over: { sessionsPerDay?: number; failFirst?: boolean } = {}) {
  const clock = new WallTestClock(new TestBeacon(), Date.now() - 10 * ROUND_MS, ROUND_MS);
  const sourceFor = () => clock.source();
  const log = await LocalLogHost.open({
    store: memoryStore(),
    source: sourceFor(),
    origin: "api.example/log",
    minCosignIntervalMs: ROUND_MS,
    ownCosigner: { name: "api.example/cosigner", secretKey: generateKeyPair().secretKey, state: {}, persist: async () => {}, clock: scheduleClock(sourceFor()) },
  });
  const deliveries: Delivery[] = [];
  let failures = over.failFirst ? 1 : 0;
  const p = localPlatform({
    keys: { [KEY]: "Northbank Receivables", [OTHER_KEY]: "Someone Else" },
    base: "/api/v1",
    sessionsPerDay: over.sessionsPerDay ?? 100,
    evidenceUrl: (hash) => `https://api.example/log/policies/${hash}/evidence`,
    stream: { pollMs: 50, holdMs: 400 },
    session: {
      mode: "simulated",
      sourceFor,
      timeOfRound: (round) => clock.timeOfRound(round),
      log,
      roundMs: ROUND_MS,
      releaseAfter: 3,
      timeScale: 0.05,
      fetch: async (url, init) => {
        if (failures-- > 0) return { ok: false, status: 503 };
        deliveries.push({ url, headers: init.headers, body: init.body });
        return { ok: true, status: 200 };
      },
    },
  });
  const call = async (method: string, path: string, opts: { auth?: string | undefined; body?: unknown; headers?: Record<string, string> } = {}) => {
    const response = await p.fetch(
      new Request(`https://api.example/api/v1${path}`, {
        method,
        headers: { ...(opts.auth ? { authorization: `Bearer ${opts.auth}` } : {}), ...(opts.body !== undefined ? { "content-type": "application/json" } : {}), ...opts.headers },
        ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
      }),
    );
    const text = await response.text();
    return { status: response.status, headers: response.headers, text, body: text.startsWith("{") ? (JSON.parse(text) as Record<string, any>) : undefined };
  };
  const until = async (id: string, phase: string) => {
    for (let i = 0; i < 300; i++) {
      await p.work();
      if ((await call("GET", `/sessions/${id}`, { auth: KEY })).body!.phase === phase) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.fail(`session never reached ${phase}`);
  };
  return { p, call, until, deliveries, verifier: { acceptedBeacons: [clock.testBeacon.info as BeaconInfo] } };
}

test("API: a client-sealed funding auction over HTTP, from creation to a checked result, with signed webhooks", async () => {
  const w = await platform();
  const hook = await w.call("POST", "/webhooks", { auth: KEY, body: { url: "https://desk.example/hooks/mattering" } });
  assert.equal(hook.status, 201, hook.text);
  const secret = hook.body!.secret as string;
  assert.match(secret, /^whsec_/);
  assert.equal((await w.call("GET", "/webhooks", { auth: KEY })).body!.webhooks[0].secret, undefined, "the secret is shown once");

  const desk = await generateRecipientKeys();
  const created = await w.call("POST", "/sessions", {
    auth: KEY,
    body: {
      mechanism: "sealed-bid-auction",
      terms: { item: "Funding of invoice INV-88213: £250,000, due 2027-03-01", unit: "bps", minBid: 50, maxBid: 1500, rule: "lowest-bid", reserve: 900 },
      timing: { biddingSeconds: 30 },
      organiserRecipient: desk.recipient,
      invitations: [{ label: "Funder A" }, { label: "Funder B" }],
    },
  });
  assert.equal(created.status, 201, created.text);
  assert.equal(created.headers.get("mattering-environment"), "demonstration");
  const id = created.body!.id as string;
  assert.match(id, /^ses_[0-9a-f]{24}$/);

  // Each funder joins with nothing but the invitation and its own key, and seals locally.
  const funders = [generateKeyPair(), generateKeyPair()];
  const tokens: string[] = [];
  for (const [i, inv] of (created.body!.invitations as { code: string }[]).entries()) {
    const joined = await w.call("POST", "/join", { body: { invitation: inv.code, publicKey: funders[i]!.publicKey } });
    assert.equal(joined.status, 201, joined.text);
    tokens.push(joined.body!.token);
  }
  assert.equal((await w.call("POST", `/sessions/${id}/open`, { auth: OTHER_KEY })).status, 403, "another integrator cannot run it");
  assert.equal((await w.call("POST", `/sessions/${id}/open`, { auth: KEY })).status, 200);
  const { policy } = (await w.call("GET", `/sessions/${id}/round`)).body as { policy: SealedAuctionPolicy };

  // A retried bid with the same Idempotency-Key gets the first receipt, not a refusal or a second bid.
  const bid = await prepareBidTo(policy, 640, funders[0]!);
  const first = await w.call("POST", `/sessions/${id}/bids`, { auth: tokens[0], body: bid, headers: { "idempotency-key": "bid-1" } });
  const retry = await w.call("POST", `/sessions/${id}/bids`, { auth: tokens[0], body: bid, headers: { "idempotency-key": "bid-1" } });
  assert.equal(first.status, 201, first.text);
  assert.deepEqual(retry.body, first.body);
  assert.equal((await w.call("POST", `/sessions/${id}/bids`, { auth: tokens[0], body: { other: 1 }, headers: { "idempotency-key": "bid-1" } })).body!.error.code, "idempotency-mismatch");
  assert.equal((await w.call("POST", `/sessions/${id}/bids`, { auth: tokens[0], body: bid })).body!.error.code, "duplicate", "without the key, a second bid is refused");
  assert.equal((await w.call("POST", `/sessions/${id}/bids`, { auth: tokens[1], body: { amount: 700 } })).status, 400, "a client-sealed session never takes an amount");
  assert.equal((await w.call("POST", `/sessions/${id}/bids`, { auth: tokens[1], body: await prepareBidTo(policy, 655, funders[1]!) })).status, 201);

  await w.until(id, "released");
  const evidence = (await w.call("GET", `/sessions/${id}/evidence`, { auth: KEY })).body!.rounds[0] as AuctionInputs;
  assert.equal((await verifyAuction(evidence, w.verifier, bidOpenerAs(desk.identity))).winner?.amount, 640);
  const disclosed = await w.call("POST", `/sessions/${id}/disclose`, { auth: KEY, body: { fileKeys: await discloseBids(evidence, desk.identity, w.verifier) } });
  assert.equal(disclosed.body!.phase, "finished", disclosed.text);

  // The result names the evidence on the public log and carries the keys to check it.
  const result = (await w.call("GET", `/sessions/${id}/result`, { auth: KEY })).body!;
  assert.deepEqual([result.outcome.winner.label, result.outcome.winner.amount, result.outcome.reserveMet], ["Funder A", 640, true]);
  assert.match(result.receipt.rounds[0].evidence, /^https:\/\/api\.example\/log\/policies\/[0-9a-f]{64}\/evidence$/);
  assert.equal((await verifyAuction(evidence, w.verifier, bidOpenerWithFileKeys(result.disclosure.fileKeys))).winner?.amount, 640);
  const asFunderB = (await w.call("GET", `/sessions/${id}/result`, { auth: tokens[1] })).body!;
  assert.equal(asFunderB.outcome.winner.label, "Funder A");
  assert.equal(asFunderB.disclosure, undefined, "the losing bids are the organiser's to see");
  assert.equal((await w.call("GET", `/sessions/${id}/result`)).body!.outcome, null, "and nothing is an outsider's");

  // The webhook heard every step, each delivery signed; none says how much anyone bid.
  await w.p.work();
  const types = w.deliveries.map((d) => JSON.parse(d.body).type as string);
  for (const t of ["session.created", "participant.joined", "round.opened", "bid.sealed", "round.closed", "round.released", "round.result", "session.finished"]) assert.ok(types.includes(t), `delivered ${t}: ${types.join(", ")}`);
  assert.equal(types.filter((t) => t === "bid.sealed").length, 2, "each bid is one event, the retry none");
  for (const d of w.deliveries) assert.ok(await verifyDelivery(secret, d.headers["mattering-signature"]!, d.body), "signed with the webhook's secret");
  assert.equal(await verifyDelivery(secret, w.deliveries[0]!.headers["mattering-signature"]!, w.deliveries[0]!.body.replace("session", "sessiom")), false, "a changed body fails");
  assert.equal(w.deliveries.some((d) => /"(amount|price)"/.test(d.body)), false);

  // The integrator's own records: its sessions, each delivery, and usage counted once per bid, retries included.
  const listed = (await w.call("GET", "/sessions", { auth: KEY })).body!;
  assert.deepEqual(listed.sessions.map((x: { id: string }) => x.id), [id]);
  assert.equal((await w.call("GET", "/sessions", { auth: OTHER_KEY })).body!.sessions.length, 0, "another integrator's list is its own");
  assert.equal((await w.call("GET", "/sessions")).status, 401);
  const record = (await w.call("GET", "/webhooks/deliveries", { auth: KEY })).body!.deliveries as { ok: boolean; event: string; webhook: string }[];
  assert.equal(record.length, w.deliveries.length);
  assert.ok(record.every((d) => d.ok && d.webhook === hook.body!.id));
  const today = (await w.call("GET", "/usage?days=1", { auth: KEY })).body!.usage[0];
  assert.deepEqual([today.sessions, today.bids, today.deliveries, today.failedDeliveries], [1, 2, w.deliveries.length, 0]);
});

test("API: who may call what, and every route is in the OpenAPI description", async () => {
  const w = await platform();
  const create = { mechanism: "sealed-bid-auction", terms: { item: "x", unit: "GBP", minBid: 1, maxBid: 100, rule: "highest-bid" }, confidentiality: "public", sealing: "server", invitations: [{}, {}] };
  assert.equal((await w.call("POST", "/sessions", { body: create })).status, 401, "no key");
  assert.equal((await w.call("POST", "/sessions", { auth: "mk_test_notakeyweknowabout", body: create })).status, 401, "unknown key");
  assert.equal((await w.call("POST", "/webhooks", { body: { url: "https://x.example" } })).status, 401);
  assert.equal((await w.call("POST", "/webhooks", { auth: KEY, body: { url: "http://x.example" } })).body!.error.message, "url: want an https URL");
  const id = (await w.call("POST", "/sessions", { auth: KEY, body: create })).body!.id as string;
  const other = (await w.call("POST", "/sessions", { auth: KEY, body: create })).body!;
  const token = (await w.call("POST", "/join", { body: { invitation: other.invitations[0].code } })).body!.token as string;
  assert.equal((await w.call("GET", `/sessions/${id}`, { auth: token })).status, 403, "a token is for its own session only");
  assert.equal((await w.call("POST", `/sessions/${id}/join`, { body: { invitation: other.invitations[1].code } })).status, 404, "an invitation is for its own session only");
  assert.equal((await w.call("DELETE", `/sessions/${id}`, { auth: KEY })).status, 405);
  assert.equal((await w.call("GET", `/sessions/${id}/nothing`, { auth: KEY })).status, 404);
  assert.equal((await w.call("POST", "/sessions", { auth: KEY, body: "not json" })).status, 400);

  const spec = (await w.call("GET", "/openapi.json")).body!;
  assert.equal(spec.openapi, "3.1.0");
  const described = Object.entries(OPENAPI.paths).flatMap(([path, ops]) => Object.keys(ops).map((m) => `${m.toUpperCase()} ${path}`));
  const served = ["GET /sessions", "GET /webhooks/deliveries", "GET /usage", "POST /sessions", "POST /join", "GET /sessions/{id}", ...["invitation", "round", "result", "evidence", "events"].map((s) => `GET /sessions/{id}/${s}`), ...["join", "check-in", "bids", "open", "cancel", "disclose"].map((s) => `POST /sessions/{id}/${s}`), "POST /webhooks", "GET /webhooks", "DELETE /webhooks/{webhookId}"];
  assert.deepEqual(described.sort(), served.sort());
});

test("API: creating is idempotent and within a daily allowance", async () => {
  const w = await platform({ sessionsPerDay: 1 });
  const create = { mechanism: "limit-match", terms: { item: "x", unit: "GBP", minPrice: 1, maxPrice: 100 }, sealing: "server", invitations: [{ role: "buyer" }, { role: "seller" }] };
  const first = await w.call("POST", "/sessions", { auth: KEY, body: create, headers: { "idempotency-key": "create-1" } });
  const again = await w.call("POST", "/sessions", { auth: KEY, body: create, headers: { "idempotency-key": "create-1" } });
  assert.equal(first.status, 201, first.text);
  assert.equal(again.body!.id, first.body!.id, "the retry gets the same session, and spends no allowance");
  assert.equal((await w.call("POST", "/sessions", { auth: KEY, body: { ...create, terms: { ...create.terms, item: "y" } }, headers: { "idempotency-key": "create-1" } })).status, 422);
  const over = await w.call("POST", "/sessions", { auth: KEY, body: create });
  assert.deepEqual([over.status, over.body!.error.code], [429, "limit"]);
  assert.equal((await w.call("POST", "/sessions", { auth: OTHER_KEY, body: create })).status, 201, "the allowance is per integrator");
});

test("API: a session's events as a server-sent event stream, and a webhook that failed is retried", async () => {
  const w = await platform({ failFirst: true });
  await w.call("POST", "/webhooks", { auth: KEY, body: { url: "https://desk.example/hooks", events: ["session.created", "session.finished"] } });
  const created = await w.call("POST", "/sessions", { auth: KEY, body: { mechanism: "limit-match", terms: { item: "x", unit: "GBP", minPrice: 0, maxPrice: 100 }, timing: { biddingSeconds: 30 }, sealing: "server", invitations: [{ role: "buyer" }, { role: "seller" }] } });
  const id = created.body!.id as string;
  const tokens = [];
  for (const [i, inv] of (created.body!.invitations as { code: string }[]).entries()) tokens.push((await w.call("POST", "/join", { body: { invitation: inv.code, limit: i === 0 ? 60 : 40 } })).body!.token as string);
  await w.call("POST", `/sessions/${id}/check-in`, { auth: tokens[0] });
  await w.until(id, "finished");

  const sse = await w.call("GET", `/sessions/${id}/events`, { auth: tokens[1], headers: { accept: "text/event-stream", "last-event-id": "1" } });
  assert.equal(sse.headers.get("content-type"), "text/event-stream");
  assert.doesNotMatch(sse.text, /event: session.created/, "after Last-Event-ID 1");
  assert.match(sse.text, /id: 2\nevent: participant.joined\n/);
  assert.match(sse.text, /event: session.finished\n/);
  assert.match(sse.text, /"label":"The seller"/, "a participant sees its own joining");
  assert.doesNotMatch(sse.text, /The buyer/, "but is not told the other's name");
  assert.equal((await w.call("GET", `/sessions/${id}/events`)).status, 403, "an outsider gets no events");
  const json = (await w.call("GET", `/sessions/${id}/events?after=0`, { auth: KEY })).body!;
  assert.equal(json.events[0].type, "session.created");

  // The first delivery failed; the webhook was sent only the two events it asked for, in order, once it came back.
  for (let i = 0; i < 60 && w.deliveries.length < 2; i++) {
    await w.p.work();
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.deepEqual(w.deliveries.map((d) => JSON.parse(d.body).type), ["session.created", "session.finished"]);
  const attempts = (await w.call("GET", "/webhooks/deliveries", { auth: KEY })).body!.deliveries as { ok: boolean; status: number | null; attempt: number; event: string }[];
  assert.deepEqual(attempts.map((d) => [d.event, d.ok, d.attempt]).reverse(), [["session.created", false, 1], ["session.created", true, 2], ["session.finished", true, 1]], "the failed attempt is on record, with its retry");
  assert.equal(attempts.at(-1)!.status, 503);
});
