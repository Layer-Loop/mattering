/**
 * A language model choosing the negotiating agents' offers: what it is told,
 * what is accepted from it, and that the mandate binds it as it binds the
 * script. The model is a stand-in; nothing here calls the real API.
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import type { BeaconInfo, MandateOpening, Side } from "@mattering/core";
import { verifyNegotiation, verifyNegotiationStep, withFileKeys, type StepInputs } from "@mattering/core/negotiation";
import { acceptOffer, amountsIn, claudeNegotiator, modelLabel, type OfferAsk, type OfferDecider } from "../apps/showcase/src/llm.ts";
import { startShowcase } from "../apps/showcase/src/server.ts";

type StepView = { step: number; phase: string; decidedBy: Partial<Record<Side, string>>; notes: Partial<Record<Side, string>>; withheld: Side[] };
type State = { beacon: BeaconInfo; decider: string | null; run: { done: boolean; useModel: boolean; steps: StepView[] } | null };
type Disclosure = { evidence: StepInputs; fileKeys: Record<string, string>; openings: Record<Side, MandateOpening> };

const ask = (over: Partial<OfferAsk> = {}): OfferAsk => ({ side: "buyer", organisation: "Acme Treasury Ltd", role: "Pays early", item: "INV", minPrice: 9_000, maxPrice: 10_000, faceValue: 10_000, step: 1, maxSteps: 3, limit: 9_750, history: [], ...over });

test("a model's offer is accepted only if whole, in range, within the mandate, with a note", () => {
  assert.deepEqual(acceptOffer(ask(), { offer: 9_600, note: "  We open  low. " }), { offer: 9_600, note: "We open low." });
  assert.equal(acceptOffer(ask(), { offer: 9_750, note: "At our limit." })?.offer, 9_750);
  assert.equal(acceptOffer(ask(), { offer: 9_751, note: "Over." }), undefined, "a buyer may not offer past its limit");
  assert.equal(acceptOffer(ask({ side: "seller", limit: 9_650 }), { offer: 9_649, note: "Under." }), undefined, "a seller may not go below its limit");
  for (const bad of [null, "9600", { offer: "9600", note: "x" }, { offer: 9_600.5, note: "x" }, { offer: 8_999, note: "x" }, { offer: 10_001, note: "x" }]) {
    assert.equal(acceptOffer(ask(), bad), undefined, JSON.stringify(bad));
  }
  // An offer without a usable note still counts; there is just nothing to show.
  assert.deepEqual(acceptOffer(ask(), { offer: 9_600 }), { offer: 9_600 });
  assert.deepEqual(acceptOffer(ask(), { offer: 9_600, note: "   " }), { offer: 9_600 });
  assert.ok(acceptOffer(ask(), { offer: 9_600, note: "x".repeat(2000) })!.note!.length <= 280);
});

test("a note may state only amounts the agent has seen; anything else is withheld, and the offer still counts", () => {
  assert.deepEqual(amountsIn("Up from £9,400 to 9600, under our £9.74k cap; step 2 of 3, a 4% discount"), [9_400, 9_600, 9_740]);
  const seen = ask({ step: 2, history: [{ step: 1, mine: 9_400, theirs: 9_900 }] });
  // Its own earlier offer, the other side's opened one, its limit, the face value, and this offer: all seen.
  assert.deepEqual(acceptOffer(seen, { offer: 9_600, note: "They asked £9,900 to our £9,400, so we move to £9,600, under our £9,750 cap and the £10,000 face value." }), {
    offer: 9_600,
    note: "They asked £9,900 to our £9,400, so we move to £9,600, under our £9,750 cap and the £10,000 face value.",
  });
  // A guess at the other side's sealed offer, or an invented figure, is withheld.
  assert.deepEqual(acceptOffer(seen, { offer: 9_600, note: "Bolt is now at £9,800, so we go to £9,600." }), { offer: 9_600, noteWithheld: true });
  assert.deepEqual(acceptOffer(ask(), { offer: 9_600, note: "They opened at £9,950." }), { offer: 9_600, noteWithheld: true }, "at step 1 nothing about the other side has been seen");
});

test("the page names the model as people read it", () => {
  assert.equal(modelLabel("claude-haiku-5-5"), "Claude Haiku 5.5");
  assert.equal(modelLabel("claude-opus-5-5"), "Claude Opus 5.5");
  assert.equal(modelLabel("claude-sonnet-5"), "Claude Sonnet 5");
  assert.equal(modelLabel("some-other-model"), "some-other-model");
});

async function run(negotiate: OfferDecider) {
  const { url, stop } = await startShowcase({ mode: "simulated", roundMs: 150, negotiationCloseAfter: 10, negotiationReleaseAfter: 4, agentGapMs: 150, negotiate, negotiateLabel: "Claude Haiku 5.5", decideTimeoutMs: 400 });
  const get = async <T>(path: string, body?: unknown): Promise<T> => (await (await fetch(url + path, body === undefined ? {} : { method: "POST", body: JSON.stringify(body) })).json()) as T;
  try {
    const started = await get<State>("/negotiation/start", {});
    let state = started;
    for (let i = 0; i < 600 && !state.run!.done; i++) {
      await new Promise((r) => setTimeout(r, 50));
      state = await get<State>("/negotiation/state");
    }
    assert.equal(state.run!.done, true);
    const disclosures = await Promise.all(state.run!.steps.map((s) => get<Disclosure>(`/negotiation/disclosure/${s.step}`)));
    const verifier = { acceptedBeacons: [started.beacon] };
    const results = await Promise.all(disclosures.map((d) => verifyNegotiationStep(d.evidence, withFileKeys(d.fileKeys), verifier, d.openings)));
    const chain = await verifyNegotiation(disclosures.map((d) => d.evidence), withFileKeys(Object.assign({}, ...disclosures.map((d) => d.fileKeys)) as Record<string, string>), verifier);
    return { state, results, chain, openings: disclosures[0]!.openings };
  } finally {
    stop();
  }
}

test("the model's offers are sealed as given, and each agent sees its own limit and the earlier offers", async () => {
  const asks: OfferAsk[] = [];
  const { state, results, chain, openings } = await run(async (a) => {
    asks.push(a);
    // Open far apart, then both go to their limits, which overlap.
    return a.step === 1 ? { offer: a.side === "buyer" ? 9_500 : 9_900, note: `${a.side} opens.` } : { offer: a.limit, note: `${a.side} goes to its limit.` };
  });
  assert.equal(state.run!.useModel, true);
  assert.equal(state.decider, "Claude Haiku 5.5", "the page is told which model chooses");
  assert.equal(results.length, 2);
  assert.deepEqual(results[0]!.outcome, { deal: false, reason: "the offers did not cross" });
  assert.equal(chain.ok, true, chain.problem);
  assert.deepEqual(chain.outcome, { deal: true, price: Math.floor((openings.buyer.limit + openings.seller.limit) / 2), buyerOffer: openings.buyer.limit, sellerOffer: openings.seller.limit, step: 2 });
  for (const s of state.run!.steps) {
    assert.deepEqual(s.decidedBy, { buyer: "model", seller: "model" });
    assert.match(s.notes.buyer ?? "", /^buyer/, "notes are published once the step opens");
  }
  // Each side was told its own limit only, and at step 2 what both sides offered at step 1.
  for (const side of ["buyer", "seller"] as const) {
    const mine = asks.filter((a) => a.side === side);
    assert.deepEqual(mine.map((a) => a.limit), [openings[side].limit, openings[side].limit]);
    assert.deepEqual(mine[1]!.history, [{ step: 1, mine: side === "buyer" ? 9_500 : 9_900, theirs: side === "buyer" ? 9_900 : 9_500 }]);
  }
  for (const r of results) assert.deepEqual(r.offers.map((o) => o.mandate), ["within", "within"]);
});

test("a note naming a price the agent could not have seen is withheld, and the page is told so", async () => {
  const { state } = await run(async (a) => (a.step === 1
    ? { offer: a.side === "buyer" ? 9_500 : 9_900, note: a.side === "buyer" ? "Bolt will surely ask £9,955." : "We open at £9,900." }
    : { offer: a.limit, note: "At our limit." }));
  const first = state.run!.steps[0]!;
  assert.deepEqual(first.decidedBy, { buyer: "model", seller: "model" }, "the offer itself still counts");
  assert.deepEqual(first.withheld, ["buyer"]);
  assert.equal(first.notes.buyer, undefined);
  assert.equal(first.notes.seller, "We open at £9,900.");
});

test("an offer beyond the mandate, junk, or silence is replaced by the script, side by side", async () => {
  const { state, results } = await run(async (a) => {
    if (a.side === "buyer") return { offer: a.limit + 500, note: "We really want this." }; // beyond its mandate
    if (a.step === 1) return { offer: "a lot", note: "x" }; // junk
    return new Promise(() => {}); // never answers
  });
  for (const s of state.run!.steps) assert.deepEqual(s.decidedBy, { buyer: "script", seller: "script" });
  for (const r of results) assert.equal(r.offers.every((o) => o.mandate === "within"), true, "the script stays within the mandate");
});

test("the Claude negotiator sends one well-formed request with the agent's limit and history; failures throw", async () => {
  const requests: Record<string, unknown>[] = [];
  let mode: "ok" | "refusal" | "error" = "ok";
  const api = createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk: Buffer) => (raw += chunk.toString()));
    request.on("end", () => {
      requests.push(JSON.parse(raw) as Record<string, unknown>);
      if (mode === "error") {
        response.writeHead(529, { "content-type": "application/json" });
        return response.end(JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "overloaded" } }));
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ id: "msg_test", type: "message", role: "assistant", model: "claude-haiku-5-5", content: mode === "refusal" ? [] : [{ type: "text", text: JSON.stringify({ offer: 9_640, note: "We move toward the middle." }) }], stop_reason: mode === "refusal" ? "refusal" : "end_turn", stop_sequence: null, usage: { input_tokens: 10, output_tokens: 10 } }));
    });
  });
  await new Promise<void>((resolve) => api.listen(0, "127.0.0.1", resolve));
  try {
    const negotiate = claudeNegotiator({ apiKey: "test-key", baseURL: `http://127.0.0.1:${(api.address() as AddressInfo).port}`, timeoutMs: 3000 });
    const asked = ask({ step: 3, history: [{ step: 1, mine: 9_500, theirs: 9_900 }, { step: 2, mine: 9_550, theirs: 9_850 }] });
    assert.deepEqual(await negotiate(asked), { offer: 9_640, note: "We move toward the middle." });
    const sent = requests[0]!;
    assert.equal(sent.model, "claude-haiku-5-5");
    assert.equal(sent.fallbacks, undefined, "no server-side fallback is offered for this model");
    assert.equal((sent.output_config as { effort: string }).effort, "low");
    assert.equal((sent.output_config as { format: { type: string } }).format.type, "json_schema");
    const prompt = JSON.stringify([sent.system, sent.messages]);
    for (const expected of [
      "Acme Treasury Ltd", "£9,750", "at most", "midpoint",
      // Every price seen, step by step, and nothing else about the other side.
      "Prices seen so far", "Step 1: you offered £9,500; the other side offered £9,900", "Step 2: you offered £9,550; the other side offered £9,850",
      "never describe, guess or imply it", "mention only prices you have been shown as seen",
      // The last step's stakes, said plainly.
      "step 3 of 3", "It is the last step", "no deal at all", "any deal within the mandate as better than no deal",
    ]) assert.ok(prompt.includes(expected), expected);
    const quiet = console.error;
    console.error = () => {};
    try {
      for (const failing of ["refusal", "error"] as const) {
        mode = failing;
        await assert.rejects(negotiate(asked), failing);
      }
    } finally {
      console.error = quiet;
    }
  } finally {
    api.close();
  }
});
