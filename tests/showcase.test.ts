/**
 * The showcase server: one auction on a fast simulated clock, checked the way
 * the page checks it, including the operator's attempt to rewrite the log.
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { generateKeyPair, prepareBid, verifyAuction, verifyStatements, type AuctionInputs, type AuctionPolicy, type BeaconInfo, type StatementInputs } from "@mattering/core";
import { AGENTS, SLOT, acceptDecision, type Decider } from "../apps/showcase/src/agents.ts";
import { claudeDecider } from "../apps/showcase/src/llm.ts";
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
    const mine = await prepareBid(run.auction, run.auction.maxBid, visitor);
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

/** Run one fast simulated auction with the given decider and return what each agent bid and who decided. */
async function runWith(decide: Decider | undefined, decideTimeoutMs?: number): Promise<{ decidedBy: (string | undefined)[]; amounts: (number | undefined)[]; texts: (string | undefined)[] }> {
  const { url, stop } = await startShowcase({
    mode: "simulated",
    closeAfter: 14,
    releaseAfter: 4,
    roundMs: 150,
    agentGapMs: 100,
    ...(decide ? { decide } : {}),
    ...(decideTimeoutMs ? { decideTimeoutMs } : {}),
  });
  try {
    const get = async <T>(path: string, body?: unknown): Promise<T> => (await (await fetch(url + path, body === undefined ? {} : { method: "POST", body: JSON.stringify(body) })).json()) as T;
    type State = { beacon: BeaconInfo; run: { phase: string; auctionHash: string; forecastHash: string; agents: { publicKey: string; decidedBy?: string }[] } };
    const started = await get<State>("/demo/start", {});
    let state = started;
    for (let i = 0; i < 300 && state.run.phase !== "released"; i++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      state = await get<State>("/demo/state");
    }
    assert.equal(state.run.phase, "released");
    const verifier = { acceptedBeacons: [started.beacon] };
    const auction = await verifyAuction(await get<AuctionInputs>(`/api/policies/${state.run.auctionHash}/evidence`), verifier);
    const statements = await verifyStatements(await get<StatementInputs>(`/api/policies/${state.run.forecastHash}/evidence`), verifier);
    assert.equal(auction.ok, true, JSON.stringify(auction.checks));
    return {
      decidedBy: state.run.agents.map((a) => a.decidedBy),
      amounts: state.run.agents.map((a) => auction.bids.find((b) => b.submitter === a.publicKey && b.status === "valid")?.amount),
      texts: state.run.agents.map((a) => statements.statements.find((x) => x.author === a.publicKey)?.text),
    };
  } finally {
    stop();
  }
}

test("showcase: a language model's decisions are sealed as given, and the page is told what decided", async () => {
  const seen: { name: string; ceiling: number }[] = [];
  const result = await runWith(async (agent, slot, ceiling) => {
    seen.push({ name: agent.name, ceiling });
    return { bid: slot.minBid + 1000 * (seen.length + 1), prediction: `  ${agent.name} says\nhello  ` };
  });
  assert.deepEqual(seen.map((s) => s.name).sort(), ["Company A", "Company B", "Company C"]);
  for (const [i, agent] of AGENTS.entries()) {
    const asked = seen.find((s) => s.name === agent.name)!;
    assert.ok(asked.ceiling >= agent.ceiling[0] && asked.ceiling <= agent.ceiling[1], "each agent is given a private ceiling in its range");
    assert.equal(result.decidedBy[i], "model");
    assert.equal(result.texts[i], `${agent.name} says hello`, "whitespace in the rationale is tidied");
  }
  assert.deepEqual([...result.amounts].sort(), [SLOT.minBid + 2000, SLOT.minBid + 3000, SLOT.minBid + 4000]);
});

test("showcase: a model that fails, stalls or returns junk is replaced by the script, agent by agent", async () => {
  const result = await runWith(async (agent, slot) => {
    if (agent.name === "Company A") throw new Error("API down");
    if (agent.name === "Company B") return { bid: slot.maxBid * 50, prediction: "We bid fifty times the maximum." };
    return new Promise(() => {}); // Company C: never answers
  }, 400);
  assert.deepEqual(result.decidedBy, ["script", "script", "script"]);
  for (const [i, agent] of AGENTS.entries()) {
    const amount = result.amounts[i]!;
    assert.ok(amount >= SLOT.minBid && amount <= agent.ceiling[1], `${agent.name} bid ${amount}`);
    assert.ok(result.texts[i]!.length > 10);
  }
});

test("showcase: without a model the scripts decide", async () => {
  assert.deepEqual((await runWith(undefined)).decidedBy, ["script", "script", "script"]);
});

test("a model's answer is accepted only if it is a whole amount in range with a rationale", () => {
  const ok = { bid: 600_000, prediction: "We think this wins." };
  assert.deepEqual(acceptDecision(SLOT, ok), ok);
  assert.equal(acceptDecision(SLOT, { ...ok, bid: SLOT.maxBid })?.bid, SLOT.maxBid);
  for (const bad of [null, "600000", [], { bid: 600_000 }, { ...ok, bid: "600000" }, { ...ok, bid: 600_000.5 }, { ...ok, bid: SLOT.minBid - 1 }, { ...ok, bid: SLOT.maxBid + 1 }, { ...ok, bid: -1 }, { ...ok, bid: Number.NaN }, { ...ok, prediction: "   " }, { ...ok, prediction: 7 }]) {
    assert.equal(acceptDecision(SLOT, bad), undefined, JSON.stringify(bad));
  }
  const long = acceptDecision(SLOT, { ...ok, prediction: "x".repeat(5000) })!;
  assert.ok(long.prediction.length <= 320);
});

test("the Claude decider sends one well-formed request and reads the answer; failures throw", async () => {
  // A stand-in for the Messages API. This checks our side of the conversation;
  // only a run with a real key shows the real API accepts it.
  const requests: { path: string; key: string | undefined; body: Record<string, unknown> }[] = [];
  let mode: "ok" | "refusal" | "error" | "prose" = "ok";
  const api = createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk: Buffer) => (raw += chunk.toString()));
    request.on("end", () => {
      requests.push({ path: request.url ?? "", key: (request.headers["x-api-key"] as string | undefined) ?? request.headers.authorization?.replace(/^Bearer /, ""), body: JSON.parse(raw) as Record<string, unknown> });
      if (mode === "error") {
        response.writeHead(401, { "content-type": "application/json" });
        return response.end(JSON.stringify({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }));
      }
      const text = mode === "prose" ? "I would bid about four hundred thousand." : JSON.stringify({ bid: 512_000, rationale: "We bid what the forecast supports." });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ id: "msg_test", type: "message", role: "assistant", model: "claude-haiku-5-5", content: mode === "refusal" ? [] : [{ type: "text", text }], stop_reason: mode === "refusal" ? "refusal" : "end_turn", stop_sequence: null, usage: { input_tokens: 10, output_tokens: 10 } }));
    });
  });
  await new Promise<void>((resolve) => api.listen(0, "127.0.0.1", resolve));
  try {
    const decide = claudeDecider({ apiKey: "test-key", baseURL: `http://127.0.0.1:${(api.address() as AddressInfo).port}`, timeoutMs: 3000 });
    const agent = AGENTS[1]!;
    assert.deepEqual(await decide(agent, SLOT, 650_000), { bid: 512_000, prediction: "We bid what the forecast supports." });
    assert.equal(requests.length, 1);
    const sent = requests[0]!;
    assert.match(sent.path, /\/v1\/messages/);
    assert.equal(sent.key, "test-key");
    assert.equal(sent.body.model, "claude-haiku-5-5");
    assert.equal(sent.body.fallbacks, undefined, "no server-side fallback is offered for this model");
    assert.equal((sent.body.output_config as { effort: string; format: { type: string } }).effort, "low");
    assert.equal((sent.body.output_config as { format: { type: string } }).format.type, "json_schema");
    assert.equal(sent.body.thinking, undefined, "thinking is left to the model's default");
    assert.equal(sent.body.temperature, undefined);
    const prompt = JSON.stringify([sent.body.system, sent.body.messages]);
    assert.ok(prompt.includes("Company B") && prompt.includes("£650,000") && prompt.includes("£400,000") && prompt.includes("£800,000"));
    const quiet = console.error;
    console.error = () => {};
    try {
      for (const failing of ["refusal", "prose", "error"] as const) {
        mode = failing;
        await assert.rejects(decide(agent, SLOT, 500_000), failing);
      }
    } finally {
      console.error = quiet;
    }
  } finally {
    api.close();
  }
});
