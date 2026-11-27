/**
 * The scenario demos, server side: the integrator (this demo) runs each
 * auction through the platform's public API with the SDK, and a visitor, with
 * its own client, joins and seals as the page does. The result is worked out
 * again from the evidence the page receives.
 */
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { generateKeyPair, scheduleClock, verifyAuction, type AuctionInputs, type BeaconInfo } from "@mattering/core";
import { bidOpenerWithFileKeys } from "@mattering/core/recipients";
import { TestBeacon, WallTestClock } from "@mattering/core/testing";
import { memoryStore } from "@mattering/witness";
import { Mattering } from "@mattering/client";
import { LocalLogHost } from "../apps/showcase/src/log-host.ts";
import { localPlatform } from "../apps/platform/src/api.ts";
import { Scenario, type ScenarioName, type ScenarioState } from "../apps/showcase/src/scenario.ts";

const ROUND_MS = 100;
const timers: ReturnType<typeof setInterval>[] = [];
after(() => timers.forEach(clearInterval));

async function run(name: ScenarioName, offer: number) {
  const clock = new WallTestClock(new TestBeacon(), Date.now() - 10 * ROUND_MS, ROUND_MS);
  const sourceFor = () => clock.source();
  const log = await LocalLogHost.open({ store: memoryStore(), source: sourceFor(), origin: "demo.example/log", minCosignIntervalMs: ROUND_MS, ownCosigner: { name: "demo.example/cosigner", secretKey: generateKeyPair().secretKey, state: {}, persist: async () => {}, clock: scheduleClock(sourceFor()) } });
  const KEY = "mk_test_scenariodemo0000000";
  const p = localPlatform({ keys: { [KEY]: "mattering-demos" }, base: "/api/v1", session: { mode: "simulated", sourceFor, timeOfRound: (r) => clock.timeOfRound(r), log, roundMs: ROUND_MS, releaseAfter: 3, timeScale: 0.04, fetch: async () => ({ ok: true, status: 200 }) } });
  let saved: ScenarioState | undefined;
  const scenario = await Scenario.open({ mode: "simulated", sourceFor, apiFetch: p.fetch, apiKey: KEY, loadState: async () => saved, saveState: async (s) => void (saved = s) });
  timers.push(setInterval(() => void p.work().then(() => scenario.work()).catch(() => {}), 50));
  const beacon = clock.testBeacon.info as BeaconInfo;
  const started = (await scenario.handle("POST", "/scenario/start", async () => ({ name }))).body as { run: { invitation: string; sessionId: string } };
  // The visitor, as the page: its own client, sealing locally.
  const visitor = await new Mattering({ baseUrl: "https://demo.example/api/v1", fetch: ((i: RequestInfo | URL, init?: RequestInit) => p.fetch(new Request(i, init))) as typeof fetch, acceptedBeacons: [beacon], pollMs: 50 }).join(started.run.invitation);
  await visitor.bid(offer);
  for (let i = 0; i < 400; i++) {
    const v = (await scenario.view()) as { run: { phase: string } };
    if (v.run.phase === "finished") break;
    await new Promise((r) => setTimeout(r, 50));
  }
  const view = (await scenario.view()) as { run: { phase: string; outcome: { winner: { label: string; amount: number } | null; reserveMet?: boolean; bids: { label: string; amount: number }[] }; evidence: { rounds: AuctionInputs[]; fileKeys: Record<string, string> }; others: { label: string; publicKey: string; sealed: boolean }[] } };
  const checked = await verifyAuction(view.run.evidence.rounds[0]!, { acceptedBeacons: [beacon] }, bidOpenerWithFileKeys(view.run.evidence.fileKeys));
  return { view: view.run, checked };
}

test("the rental scenario: offers up to the advertised rent, and a tie at the full rent drawn by the public clock", async () => {
  const { view, checked } = await run("rental", 2400);
  assert.equal(view.phase, "finished");
  assert.ok(view.others.every((o) => o.sealed), "every simulated applicant sealed an offer");
  assert.equal(view.outcome.bids.length, 5);
  assert.ok(view.outcome.bids.every((b) => b.amount <= 2400), "no offer above the advertised rent");
  // Three offers at £2,400 (two applicants and the visitor): the winner is one of them, as the evidence says.
  assert.equal(view.outcome.winner!.amount, 2400);
  assert.equal(view.outcome.bids.filter((b) => b.amount === 2400).length, 3);
  assert.equal(view.outcome.bids[0]!.label, view.outcome.winner!.label, "the winner of the draw heads the ranking");
  assert.equal(checked.ok, true);
  assert.equal(checked.winner!.amount, 2400);
});

test("the funding scenario: the lowest discount within the reserve wins", async () => {
  const { view, checked } = await run("funding", 600);
  assert.equal(view.phase, "finished");
  assert.deepEqual([view.outcome.winner!.label, view.outcome.winner!.amount, view.outcome.reserveMet], ["Your fund", 600, true]);
  assert.equal(checked.winner!.amount, 600);
});
