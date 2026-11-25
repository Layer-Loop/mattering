/**
 * The Negotiation Room's page. It takes evidence and the firms' disclosures
 * from the server, never a verdict: every step is worked out here with the
 * same library the tests use.
 */
import { QUICKNET, type BeaconInfo, type Mandate, type MandateOpening, type MandateStatus, type Side } from "@mattering/core";
import { verifyNegotiation, verifyNegotiationStep, withFileKeys, type StepInputs, type StepResult } from "@mattering/core/negotiation";

interface StepView {
  step: number;
  hash: string;
  closeAt: number;
  releaseAt: number;
  phase: "open" | "closed" | "released";
  cosigned: boolean;
  submitted: Record<Side, boolean>;
  decidedBy: Partial<Record<Side, "model" | "script">>;
  notes: Partial<Record<Side, string>>;
}
interface State {
  mode: "live" | "simulated";
  beacon: BeaconInfo;
  ownCosigner?: string;
  /** The model that will choose offers, by name, or null when the scripts do. */
  decider: string | null;
  invoice: { item: string; unit: string; minPrice: number; maxPrice: number };
  firms: Record<Side, { organisation: string; agent: string; role: string }>;
  serverTime: number;
  run: { id: number; rogue: boolean; useModel: boolean; done: boolean; negotiationId: string; mandates: Record<Side, Mandate>; steps: StepView[] } | null;
}
interface Disclosure {
  evidence: StepInputs;
  fileKeys: Record<string, string>;
  openings: Record<Side, MandateOpening>;
}
interface Judged {
  disclosure: Disclosure;
  result: StepResult;
}

const SIDES: Side[] = ["buyer", "seller"];

/**
 * Where the room lives. On a laptop the page and the room share an origin and
 * the base is empty. On the hosted site each visitor's browser session has a
 * room of its own, the same one the auction page uses.
 */
function roomBase(): string {
  const template = document.documentElement.dataset.roomBase;
  if (!template) return "";
  let id = sessionStorage.getItem("mattering-room");
  if (!id) {
    id = crypto.randomUUID();
    sessionStorage.setItem("mattering-room", id);
  }
  return template.replace("{id}", id);
}
const BASE = roomBase();
/** Hosted: do not create a room until the visitor starts a negotiation. */
const LAZY = BASE !== "";
/** Shown before any room exists: the deal is fixed, and who decides comes from /demo-info. */
const PRESTART = {
  title: "Early payment of invoice INV-2041",
  detail: "Pay invoice INV-2041 (£10,000, due in 60 days) today: the amount paid now. Offers from £9,000 to £10,000. If Acme's offer is at least Bolt's, they meet in the middle; otherwise they try again, up to three steps.",
};
let polling: ReturnType<typeof setInterval> | undefined;
const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const escape = (text: string): string => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const pounds = (amount: number): string => "£" + amount.toLocaleString("en-GB");
const short = (hex: string): string => hex.slice(0, 10) + "…";

let state: State | undefined;
let skew = 0;
/** Judged steps, by run and step number. */
const judged = new Map<string, Judged>();
let judging = false;

async function getJson<T>(path: string, body?: unknown): Promise<{ ok: boolean; json: T }> {
  const response = await fetch(BASE + path, body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { ok: response.ok, json: (await response.json()) as T };
}

/** The clock this browser accepts. In live mode it is compiled into the page, not taken from the server. */
function verifier(): { acceptedBeacons: BeaconInfo[] } {
  return { acceptedBeacons: [state!.mode === "live" ? QUICKNET : state!.beacon] };
}

const key = (runId: number, step: number): string => `${runId}:${step}`;

async function judgeReleased(): Promise<void> {
  const run = state?.run;
  if (!run || judging) return;
  judging = true;
  try {
    for (const step of run.steps) {
      if (step.phase !== "released" || judged.has(key(run.id, step.step))) continue;
      const { ok, json } = await getJson<Disclosure>(`/negotiation/disclosure/${step.step}`);
      if (!ok) continue;
      const result = await verifyNegotiationStep(json.evidence, withFileKeys(json.fileKeys), verifier(), json.openings);
      judged.set(key(run.id, step.step), { disclosure: json, result });
    }
  } finally {
    judging = false;
  }
}

const MANDATE_TEXT: Record<MandateStatus, string> = {
  within: "within its mandate",
  beyond: "BEYOND its mandate",
  undisclosed: "mandate limit not disclosed",
  "opening-invalid": "the disclosed limit does not match the mandate",
};

function partyCards(run: NonNullable<State["run"]>): string {
  const lastJudged = [...run.steps].reverse().map((s) => judged.get(key(run.id, s.step))).find(Boolean);
  return SIDES.map((side, i) => {
    const firm = state!.firms[side];
    const mandate = run.mandates[side];
    const limit = lastJudged?.disclosure.openings[side].limit;
    const direction = side === "buyer" ? "pay at most" : "accept no less than";
    return `<article class="card" style="--c: var(--s${i + 1})">
      <p class="eyebrow">${side === "buyer" ? "Pays early" : "Is paid early"}</p>
      <h3>${escape(firm.agent)}</h3>
      <p class="tag">${escape(firm.role)}. Acts for <strong>${escape(mandate.organisationName)}</strong>, whose key <code>${short(mandate.organisation)}</code> signed its mandate.</p>
      <div class="envelope ${limit === undefined ? "sealed" : ""}">
        <p class="state">${limit === undefined ? `May ${direction}: sealed` : `May ${direction} ${pounds(limit)}`}</p>
        <p class="cipher">${limit === undefined ? `commitment ${short(mandate.limit)} · the other side cannot read it` : "disclosed by the firm after the step opened; it matches the commitment"}</p>
      </div>
    </article>`;
  }).join("");
}

function stepCard(run: NonNullable<State["run"]>, step: StepView, now: number): string {
  const j = judged.get(key(run.id, step.step));
  const status = step.phase === "open" ? `Sealing · closes in ${Math.max(0, Math.ceil((step.closeAt - now) / 1000))}s` : step.phase === "closed" ? `Closed${step.cosigned ? " and countersigned" : ""} · opens in ${Math.max(0, Math.ceil((step.releaseAt - now) / 1000))}s` : "Opened";
  const offers = SIDES.map((side, i) => {
    const offer = j?.result.offers.find((o) => o.side === side);
    const firm = state!.firms[side];
    let inner: string;
    if (offer?.status === "valid") {
      const m = offer.mandate;
      const note = step.notes[side];
      inner = `<p class="amount">${pounds(offer.price!)}</p>${m ? `<p class="${m === "within" ? "chip-ok" : "reason"}">${MANDATE_TEXT[m]}</p>` : ""}${note ? `<p class="said">“${escape(note)}”</p>` : ""}`;
    } else if (offer) inner = `<p class="state">${offer.status}</p><p class="reason">${escape(offer.reason ?? "")}</p>`;
    else inner = `<p class="state">${step.submitted[side] ? "Sealed" : "Deciding…"}</p><p class="cipher">${step.submitted[side] ? "readable only by the two firms, and only once this step opens" : ""}</p>`;
    const by = step.decidedBy[side];
    const chip = by === "model" ? `<span class="by-chip model">chosen by ${escape(state!.decider ?? "a language model")}</span>` : by === "script" ? `<span class="by-chip">chosen by a script</span>` : "";
    return `<div class="offer" style="--c: var(--s${i + 1})"><p class="who">${escape(firm.agent)} ${chip}</p><div class="envelope ${offer ? "" : "sealed"}">${inner}</div></div>`;
  }).join("");
  const outcome = j?.result.outcome;
  const line = !j ? "" : !j.result.ok ? `<p class="reason">Could not be checked: ${escape(j.result.checks.find((c) => !c.ok)?.detail ?? "")}</p>` : outcome!.deal ? `<p class="deal">Deal at ${pounds(outcome!.price)}: the offers crossed, so the price is the midpoint.</p>` : `<p class="muted">No deal at this step: ${escape(outcome!.reason)}.</p>`;
  return `<article class="panel step"><div class="step-head"><h3>Step ${step.step}</h3><span class="muted">${status}</span></div><div class="offers">${offers}</div>${line}</article>`;
}

function render(): void {
  if (!state) return;
  const { invoice, run } = state;
  $("deal-title").textContent = "Early payment of invoice INV-2041";
  $("deal-detail").textContent = `${invoice.item}. Offers from ${pounds(invoice.minPrice)} to ${pounds(invoice.maxPrice)}. If Acme's offer is at least Bolt's, they meet in the middle; otherwise they try again, up to three steps.`;
  const mode = $("mode");
  mode.hidden = state.mode === "live";
  mode.textContent = "Simulated clock";
  $("trust-clock").textContent = state.mode === "live" ? "The drand network, run by a group of independent organisations. If enough of them colluded, offers could be opened early." : "In this offline mode the clock is simulated on this machine, so whoever runs the machine could open offers early. Online, it is the public drand network.";
  // Say who chooses the offers before anything starts, and for the negotiation shown.
  const model = state.decider;
  const usingModel = run ? run.useModel && model !== null : model !== null;
  $("who-decides").innerHTML = usingModel
    ? `Offers ${run ? "are" : "will be"} chosen by <strong>${escape(model!)}</strong>, held to each agent's mandate. If it fails, or answers beyond the mandate, a script chooses instead, and the offer says so.`
    : `Offers ${run ? "are" : "will be"} chosen by <strong>a script</strong>${model === null ? ": no language model is configured. Set ANTHROPIC_API_KEY to have Claude choose them." : "."}`;
  $<HTMLButtonElement>("start").textContent = run ? "Start a new negotiation" : "Start the negotiation";
  for (const id of ["parties-section", "steps-section", "cheat-section", "verify-section"]) $(id).hidden = !run;
  if (!run) return;
  const own = state.ownCosigner !== undefined;
  $("trust-cosigners").textContent = own ? "to be independent of the log's operator. In this demonstration the cosigner runs on the same machine, so it is not." : "to be independent of the log's operator and of each other.";
  const now = Date.now() + skew;
  $("parties").innerHTML = partyCards(run);
  $("steps").innerHTML = run.steps.map((s) => stepCard(run, s, now)).join("");
  const last = run.steps.at(-1);
  const finalJudged = run.done && last ? judged.get(key(run.id, last.step)) : undefined;
  const result = $("result");
  result.hidden = !finalJudged;
  if (finalJudged?.result.outcome) {
    const o = finalJudged.result.outcome;
    const rogue = finalJudged.result.offers.find((x) => x.mandate === "beyond");
    result.innerHTML = o.deal
      ? `<p class="eyebrow">Agreed</p><h3>Acme pays ${pounds(o.price)} today for the ${pounds(10_000)} invoice</h3><p class="muted">Acme offered ${pounds(o.buyerOffer)} and Bolt asked ${pounds(o.sellerOffer)}, each sealed before seeing the other's.</p>${rogue ? `<p class="reason">Acme's agent offered ${pounds(rogue.price!)}, beyond the ${pounds(finalJudged.disclosure.openings.buyer.limit)} its mandate allowed. The deal is on record, and Acme can prove its agent exceeded its authority: the limit was fixed in the mandate before the negotiation began.</p>` : `<p class="chip-ok">Both agents stayed within their mandates.</p>`}`
      : `<p class="eyebrow">No agreement</p><h3>The offers never crossed</h3>`;
  }
}

async function poll(): Promise<void> {
  try {
    const { json } = await getJson<State>("/negotiation/state");
    state = json;
    skew = json.serverTime - Date.now();
    await judgeReleased();
    render();
  } catch {
    // try again next tick
  }
}

function setOut(id: string, kind: "" | "refused" | "wait" | "alarm", text: string): void {
  const el = $(id);
  el.className = `out ${kind}`;
  el.textContent = text;
}

function lastJudged(): { step: number; j: Judged } | undefined {
  const run = state?.run;
  if (!run) return undefined;
  for (const s of [...run.steps].reverse()) {
    const j = judged.get(key(run.id, s.step));
    if (j) return { step: s.step, j };
  }
  return undefined;
}

const CHEATS: Record<string, () => Promise<void>> = {
  async peek() {
    const { ok, json } = await getJson<{ opened?: boolean; round?: number; needed?: number; error?: string }>("/negotiation/peek", {});
    if (!ok) return setOut("out-peek", "wait", json.error ?? "Try again in a moment.");
    if (json.opened) return setOut("out-peek", "alarm", "Bolt read Acme's offer early. This should not be possible.");
    setOut("out-peek", "refused", `Refused. Bolt holds a key for the offer, but the newest beacon signature is for round ${json.round}, and the offer opens only with round ${json.needed}'s, which does not exist yet.`);
  },
  async revise() {
    const { ok, json } = await getJson<{ accepted?: boolean; step?: number; reason?: string; error?: string }>("/negotiation/revise", {});
    if (!ok) return setOut("out-revise", "wait", json.error ?? "Try again once a step has opened.");
    if (json.accepted) return setOut("out-revise", "alarm", "The log took a changed offer after the step opened. This should not be possible.");
    setOut("out-revise", "refused", `Refused. Step ${json.step} closed before its offers opened, so a new offer is late, and the record already holds Bolt's first one.`);
  },
  async drop() {
    const found = lastJudged();
    if (!found) return setOut("out-drop", "wait", "Wait until a step has opened.");
    const { evidence, fileKeys, openings } = found.j.disclosure;
    const seller = state!.run!.mandates.seller.agent;
    const tampered = { ...evidence, entries: evidence.entries.filter((e) => !("submitter" in e) || e.submitter !== seller) };
    const result = await verifyNegotiationStep(tampered, withFileKeys(fileKeys), verifier(), openings);
    if (result.ok) return setOut("out-drop", "alarm", "The doctored record was accepted. This should not be possible.");
    setOut("out-drop", "refused", `Rejected. Without Bolt's offer the record no longer matches the one the operator signed at the close of step ${found.step}, which a cosigner countersigned before any offer could be read.`);
  },
  async outsider() {
    const found = lastJudged();
    if (!found) return setOut("out-outsider", "wait", "Wait until a step has opened.");
    const result = await verifyNegotiationStep(found.j.disclosure.evidence, withFileKeys({}), verifier());
    const onTime = result.checks.filter((c) => c.name !== "offers-judged").every((c) => c.ok);
    const unread = result.offers.every((o) => o.status === "unresolved");
    setOut("out-outsider", unread ? "refused" : "alarm", unread ? `Nothing to read. ${onTime ? "An outsider can check that both offers were in on time and the record was countersigned, " : ""}but the prices open only to the two firms, or to whoever they give the keys to, as they did to you.` : "An outsider read an offer. This should not be possible.");
  },
};

async function verifyAll(): Promise<void> {
  const run = state?.run;
  if (!run) return;
  judged.clear();
  await judgeReleased();
  const steps = run.steps.map((s) => judged.get(key(run.id, s.step))).filter((j): j is Judged => j !== undefined);
  const items: string[] = [];
  const mark = (ok: boolean, text: string): string => `<li><span class="${ok ? "mark-ok" : "mark-no"}">${ok ? "✓" : "✗"}</span><span>${escape(text)}</span></li>`;
  for (const [i, j] of steps.entries()) {
    const failed = j.result.checks.filter((c) => !c.ok);
    items.push(mark(failed.length === 0, `Step ${i + 1}: both offers were in before the close, the record was countersigned before either could be read, and both open to what the firms disclosed${failed.length ? ` (failed: ${failed.map((c) => c.name).join(", ")})` : ""}`));
    for (const o of j.result.offers) if (o.mandate) items.push(mark(o.mandate === "within", `Step ${i + 1}: ${state!.firms[o.side!].agent} offered ${pounds(o.price!)}, ${MANDATE_TEXT[o.mandate]}`));
  }
  if (run.done && steps.length === run.steps.length) {
    // Finally: the steps form one negotiation, and the result follows from them.
    const chain = await verifyNegotiation(steps.map((j) => j.disclosure.evidence), withFileKeys(Object.assign({}, ...steps.map((j) => j.disclosure.fileKeys)) as Record<string, string>), verifier());
    items.push(mark(chain.ok, chain.ok ? `The ${steps.length} steps form one negotiation, each starting after the last opened, and the result follows from them` : `The steps do not form one negotiation: ${chain.problem}`));
  }
  $("checks").innerHTML = items.join("") + `<li class="muted">Checked in this browser at ${new Date().toLocaleTimeString()}.</li>`;
}

/** Before a hosted room exists: the deal, and who will choose the offers, without creating a room. */
async function renderPrestart(): Promise<void> {
  $("deal-title").textContent = PRESTART.title;
  $("deal-detail").textContent = PRESTART.detail;
  let decider: string | null | undefined;
  try {
    decider = ((await (await fetch("/demo-info")).json()) as { decider: string | null }).decider;
  } catch {
    // say nothing about the model rather than guess
  }
  if (state) return; // a negotiation started meanwhile; render() says who decides
  $("who-decides").innerHTML = decider
    ? `Offers will be chosen by <strong>${escape(decider)}</strong>, held to each agent's mandate. If it fails, or answers beyond the mandate, a script chooses instead, and the offer says so.`
    : decider === null ? "Offers will be chosen by <strong>a script</strong>." : "";
}

function startPolling(): void {
  polling ??= setInterval(() => void poll(), 1000);
}

$("start").addEventListener("click", async () => {
  judged.clear();
  for (const id of ["out-peek", "out-revise", "out-drop", "out-outsider"]) setOut(id, "", "");
  $("checks").innerHTML = "";
  const { ok, json } = await getJson<State & { error?: string }>("/negotiation/start", { rogue: $<HTMLInputElement>("rogue").checked });
  if (!ok) return alert(json.error ?? "Could not start.");
  state = json;
  render();
  startPolling();
});
for (const button of document.querySelectorAll<HTMLButtonElement>("[data-cheat]")) {
  button.addEventListener("click", async () => {
    button.disabled = true;
    try {
      await CHEATS[button.dataset.cheat!]!();
    } finally {
      button.disabled = false;
    }
  });
}
$("verify").addEventListener("click", () => void verifyAll());

if (LAZY) void renderPrestart();
else {
  void poll();
  startPolling();
}
setInterval(render, 250);
