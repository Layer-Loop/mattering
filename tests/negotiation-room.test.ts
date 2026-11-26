/**
 * The Negotiation Room on a fast simulated clock, checked the way the page
 * checks it: from the evidence and the firms' disclosures, never the server's
 * verdict.
 */
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { BeaconInfo, MandateOpening, Side } from "@mattering/core";
import { verifyNegotiation, verifyNegotiationStep, withFileKeys, type StepInputs } from "@mattering/core/negotiation";
import { scriptedOffer } from "../apps/showcase/src/negotiation-room.ts";
import { startShowcase } from "../apps/showcase/src/server.ts";
import { checkDemo } from "./check-demo.ts";

type State = { beacon: BeaconInfo; decider: string | null; run: { id: number; done: boolean; startedAt: number; steps: { step: number; phase: string; sealedAt: Partial<Record<Side, number>>; logIndex: Partial<Record<Side, number>> }[] } | null };
type Disclosure = { evidence: StepInputs; fileKeys: Record<string, string>; openings: Record<Side, MandateOpening> };

async function negotiate(rogue: boolean) {
  const { url, stop } = await startShowcase({ mode: "simulated", roundMs: 150, negotiationCloseAfter: 8, negotiationReleaseAfter: 4, agentGapMs: 100 });
  const get = async <T>(path: string, body?: unknown): Promise<{ status: number; json: T }> => {
    const r = await fetch(url + path, body === undefined ? {} : { method: "POST", body: JSON.stringify(body) });
    return { status: r.status, json: (await r.json()) as T };
  };
  try {
    assert.match(await (await fetch(url + "/demo/negotiation")).text(), /The Negotiation Room/);
    assert.ok((await (await fetch(url + "/rooms.js")).text()).length > 50_000, "the page's script is served");
    const before = (await get<State>("/negotiation/state")).json;
    assert.equal(before.run, null);
    assert.equal(before.decider, null, "without a model the page is told the scripts decide");
    const started = (await get<State>("/negotiation/start", { rogue })).json;
    const verifier = { acceptedBeacons: [started.beacon] };

    // While step 1 is sealed, Bolt's agent cannot read Acme's offer.
    let peek: { status: number; json: { opened?: boolean } } | undefined;
    for (let i = 0; i < 100 && peek?.status !== 200; i++) {
      await new Promise((r) => setTimeout(r, 50));
      peek = await get("/negotiation/peek", {});
    }
    assert.equal(peek!.json.opened, false);

    let state = started;
    for (let i = 0; i < 600 && !state.run!.done; i++) {
      await new Promise((r) => setTimeout(r, 50));
      state = (await get<State>("/negotiation/state")).json;
    }
    assert.equal(state.run!.done, true, "the negotiation finished");
    // Every offer says when it was sealed and where it sits in the log.
    for (const s of state.run!.steps) {
      for (const side of ["buyer", "seller"] as const) {
        assert.ok(s.sealedAt[side]! >= state.run!.startedAt, `step ${s.step} ${side} sealed time`);
        assert.ok(Number.isSafeInteger(s.logIndex[side]), `step ${s.step} ${side} log position`);
      }
    }
    const disclosures = await Promise.all(state.run!.steps.map(async (s) => (await get<Disclosure>(`/negotiation/disclosure/${s.step}`)).json));
    const results = await Promise.all(disclosures.map((d) => verifyNegotiationStep(d.evidence, withFileKeys(d.fileKeys), verifier, d.openings)));
    for (const r of results) assert.equal(r.ok, true, JSON.stringify(r.checks));
    const chain = await verifyNegotiation(disclosures.map((d) => d.evidence), withFileKeys(Object.assign({}, ...disclosures.map((d) => d.fileKeys)) as Record<string, string>), verifier);
    assert.equal(chain.ok, true, chain.problem);

    // Once a step has opened, Bolt cannot change its offer for it.
    const revise = (await get<{ accepted: boolean; reason: string }>("/negotiation/revise", {})).json;
    assert.equal(revise.accepted, false);
    assert.match(revise.reason, /late/);

    // The evidence the page lets you download, checked offline by the command line.
    const dir = mkdtempSync(join(tmpdir(), "mattering-demo-"));
    writeFileSync(join(dir, "beacon.json"), JSON.stringify(started.beacon));
    writeFileSync(join(dir, "evidence.json"), JSON.stringify({ format: "mattering.demo-evidence/1", room: "negotiation", mode: "simulated", beacon: started.beacon, steps: disclosures }));
    const offline = checkDemo(join(dir, "evidence.json"), "--allow-beacon", join(dir, "beacon.json"));
    return { results, chain, openings: disclosures[0]!.openings, offline };
  } finally {
    stop();
  }
}

test("negotiation room: three sealed steps, a deal within both mandates, checked from the disclosures", async () => {
  const { results, chain, openings, offline } = await negotiate(false);
  assert.equal(offline.status, 0, offline.stdout + offline.stderr);
  assert.match(offline.stdout, /PASS  every offer within its mandate/);
  assert.match(offline.stdout, /deal in round 3 at £/);
  assert.equal(results.length, 3);
  assert.deepEqual(results.slice(0, 2).map((r) => r.outcome?.deal), [false, false]);
  const buyer = scriptedOffer("buyer", 3, openings.buyer.limit, false);
  const seller = scriptedOffer("seller", 3, openings.seller.limit, false);
  assert.deepEqual(chain.outcome, { deal: true, price: Math.floor((buyer + seller) / 2), buyerOffer: buyer, sellerOffer: seller, step: 3 });
  for (const r of results) assert.deepEqual(r.offers.map((o) => o.mandate), ["within", "within"]);
});

test("negotiation room: a rogue agent's offer beyond its mandate is shown as such", async () => {
  const { results, openings, offline } = await negotiate(true);
  assert.equal(offline.status, 1, "offline, an agent beyond its mandate is a failure too");
  assert.match(offline.stdout, /FAIL  every offer within its mandate/);
  const last = results.at(-1)!;
  assert.equal(last.outcome?.deal, true);
  const acme = last.offers.find((o) => o.side === "buyer")!;
  assert.equal(acme.mandate, "beyond");
  assert.ok(acme.price! > openings.buyer.limit);
});
