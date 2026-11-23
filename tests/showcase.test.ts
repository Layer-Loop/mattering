/**
 * The showcase server: one auction on a fast simulated clock, checked the way
 * the page checks it, including the operator's attempt to rewrite the log.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { generateKeyPair, prepareBid, verifyAuction, verifyStatements, type AuctionInputs, type AuctionPolicy, type BeaconInfo, type StatementInputs } from "@mattering/core";
import { startShowcase } from "../apps/showcase/src/server.ts";

test("showcase: agents bid, a visitor joins, cheats fail, and the page's own verification agrees", async () => {
  const { url, stop } = await startShowcase({ mode: "simulated", closeAfter: 10, releaseAfter: 5, roundMs: 150, agentGapMs: 150 });
  try {
    const get = async <T>(path: string, body?: unknown): Promise<{ status: number; json: T }> => {
      const r = await fetch(url + path, body === undefined ? {} : { method: "POST", body: JSON.stringify(body) });
      return { status: r.status, json: (await r.json()) as T };
    };
    type State = { beacon: BeaconInfo; run: { phase: string; auction: AuctionPolicy; auctionHash: string; forecastHash: string; cosigned: boolean; agents: { submitted: boolean }[] } | null };
    const until = async (done: (s: State) => boolean): Promise<State> => {
      for (let i = 0; i < 200; i++) {
        const s = (await get<State>("/demo/state")).json;
        if (done(s)) return s;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error("timed out");
    };

    assert.match(await (await fetch(url + "/")).text(), /The Sealed Room/);
    assert.ok((await (await fetch(url + "/app.js")).text()).length > 50_000, "browser bundle is served");
    assert.equal((await get<State>("/demo/state")).json.run, null);
    assert.equal((await get("/demo/forge", {})).status, 409);

    const started = (await get<State>("/demo/start", {})).json;
    const run = started.run!;
    const verifier = { acceptedBeacons: [started.beacon] };
    const visitor = generateKeyPair();
    const mine = await prepareBid(run.auction, 8100, visitor);
    assert.equal((await get("/api/submissions", mine)).status, 200);
    await until((s) => s.run!.agents.every((a) => a.submitted));
    assert.equal((await get("/demo/forge", {})).status, 409, "no rewriting before release");

    await until((s) => s.run!.phase === "closed" && s.run!.cosigned);
    const late = await prepareBid(run.auction, run.auction.maxBid, generateKeyPair());
    assert.equal((await get("/api/submissions", late)).status, 409);

    await until((s) => s.run!.phase === "released");
    const evidence = (await get<AuctionInputs>(`/api/policies/${run.auctionHash}/evidence`)).json;
    const result = await verifyAuction(evidence, verifier);
    assert.equal(result.ok, true, JSON.stringify(result.checks));
    assert.equal(result.bids.length, 4);
    assert.equal(result.winner?.submitter, visitor.publicKey);
    const statements = await verifyStatements((await get<StatementInputs>(`/api/policies/${run.forecastHash}/evidence`)).json, verifier);
    assert.equal(statements.statements.filter((s) => s.status === "valid").length, 3);

    const forged = (await get<{ cosignerSaid: string; evidence: AuctionInputs }>("/demo/forge", {})).json;
    assert.equal(forged.evidence.entries.length, evidence.entries.length + 1);
    assert.match(forged.cosignerSaid, /already cosigned|too late/);
    const rejected = await verifyAuction(forged.evidence, verifier);
    assert.equal(rejected.ok, false);
    assert.equal(rejected.checks.find((c) => c.name === "closing-checkpoint-cosigned-before-release")?.ok, false);
  } finally {
    stop();
  }
});
