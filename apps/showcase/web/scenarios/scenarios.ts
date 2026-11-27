/**
 * The scenario demos' offer panel. The visitor joins the round with its
 * invitation and seals their offer in this browser with @mattering/client,
 * through Mattering's public API: the amount never leaves the page unsealed.
 * Once the round opens, this script works the result out again from the
 * evidence, including how a tie was drawn, rather than taking the page's word.
 */
import { QUICKNET, generateKeyPair, hashLabelled, verifyAuction, type AuctionInputs, type BeaconInfo } from "@mattering/core";
import { bidOpenerWithFileKeys } from "@mattering/core/recipients";
import { Mattering, MatteringApiError, type Participant, type ParticipantSecrets } from "@mattering/client";

type Name = "rental" | "funding";
const NAME = document.documentElement.dataset.scenario as Name;
const panel = document.getElementById("offer")!;

/** How each scenario talks about amounts. */
const STYLE: Record<Name, { you: string; offer: string; step: number; presets: number[]; money: (n: number) => string; detail: (n: number) => string; winWord: string; start: string; plural: string; headline: (who: string, amount: string, you: boolean) => string; then: (who: string) => string }> = {
  rental: {
    you: "You",
    offer: "offer",
    step: 25,
    presets: [2400, 2375, 2350, 2300],
    money: (n) => `£${n.toLocaleString("en-GB")} pcm`,
    detail: () => "",
    winWord: "gets the flat, subject to checks",
    start: "Open the offers round",
    plural: "offers",
    headline: (who, amount, you) => `${who} ${you ? "get" : "gets"} the flat at ${amount}`,
    then: (who) => `${who === "You" ? "You go" : `${who} goes`} on to referencing and right-to-rent checks.`,
  },
  funding: {
    you: "Your fund",
    offer: "quote",
    step: 5,
    presets: [650, 700, 750, 850],
    money: (n) => `${n} bps`,
    detail: (n) => `£${((250_000 * n) / 10_000).toLocaleString("en-GB", { maximumFractionDigits: 0 })} discount; pays £${(250_000 - (250_000 * n) / 10_000).toLocaleString("en-GB", { maximumFractionDigits: 0 })} today`,
    winWord: "funds the invoice",
    start: "Open the auction",
    plural: "quotes",
    headline: (who, amount) => `${who} wins at ${amount}`,
    then: (who) => `${who} funds the invoice.`,
  },
};
const S = STYLE[NAME];

// --- where things live -----------------------------------------------------------

/** Hosted, each visitor's browser session has a room of its own, as in the other demos; on a laptop the base is empty. */
const template = document.documentElement.dataset.roomBase;
function roomBase(): string {
  if (!template) return "";
  let id = sessionStorage.getItem("mattering-room");
  if (!id) {
    id = crypto.randomUUID();
    sessionStorage.setItem("mattering-room", id);
  }
  return template.replace("{id}", id);
}
/** Whether this browser session has a room yet. Looking at the page does not make one. */
const hasRoom = (): boolean => !template || sessionStorage.getItem("mattering-room") !== null;

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const r = await fetch(`${roomBase()}${path}`, { method, headers: { "content-type": "application/json" }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const json = (await r.json()) as T & { error?: string };
  if (!r.ok) throw new Error(json.error ?? `HTTP ${r.status}`);
  return json;
}

// --- state ----------------------------------------------------------------------------

interface Bid { participant: string | null; label: string; amount?: number; status: string }
interface Run {
  id: number;
  name: Name;
  sessionId: string;
  invitation: string;
  terms: { minBid: number; maxBid: number; rule: string; reserve?: number; unit: string };
  phase: string;
  round: { round: number; closesAt: string; opensAt: string; releaseRound: number; bids: number } | null;
  others: { label: string; sealed: boolean; publicKey: string }[];
  failed?: string;
  outcome?: { winner: { label: string; amount: number } | null; reserveMet?: boolean; bids: Bid[] };
  evidence?: { rounds: AuctionInputs[]; fileKeys?: Record<string, string> };
}
interface State { mode: "live" | "simulated"; beacon: BeaconInfo; run: Run | null }

let state: State | undefined;
let me: Participant | undefined;
let myOffer: number | undefined;
let checked: { runId: number; html: string } | undefined;
let error = "";

const client = () => new Mattering({ baseUrl: `${location.origin}/api/v1`, acceptedBeacons: state?.mode === "simulated" ? [state.beacon] : [QUICKNET], pollMs: 1000 });
const saved = (sessionId: string): { secrets: ParticipantSecrets; offer?: number } | undefined => JSON.parse(sessionStorage.getItem(`mattering-scenario-${sessionId}`) ?? "null") ?? undefined;
const save = (sessionId: string, v: { secrets: ParticipantSecrets; offer?: number }) => sessionStorage.setItem(`mattering-scenario-${sessionId}`, JSON.stringify(v));

const secondsTo = (iso: string): number => Math.max(0, Math.ceil((Date.parse(iso) - Date.now()) / 1000));
const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

// --- drawing --------------------------------------------------------------------------

function render(): void {
  const run = state?.run;
  if (panel.dataset.view?.startsWith("result:") && !(run && run.phase === "finished" && panel.dataset.view === `result:${run.id}`)) panel.dataset.view = "";
  const formShown = panel.dataset.view?.startsWith("form:");
  if (formShown && !(run && run.phase === "open" && myOffer === undefined && run.round && secondsTo(run.round.closesAt) > 0)) panel.dataset.view = "";
  if (!run || run.name !== NAME) return renderIdle();
  if (run.failed) return void (panel.innerHTML = `<p class="error">The round could not finish: ${esc(run.failed)}</p>${again()}`);
  if (run.phase === "finished") return renderResult(run);
  if (["cancelled", "expired"].includes(run.phase)) return void (panel.innerHTML = `<p>The round ${run.phase === "expired" ? "expired" : "was cancelled"}.</p>${again()}`);
  const others = `<ul class="others">${run.others.map((o) => `<li><span>${esc(o.label)}</span>${o.sealed ? '<span class="done">Sealed</span>' : '<span class="wait">Deciding…</span>'}</li>`).join("")}</ul>`;
  const round = run.round;
  const open = run.phase === "open" && round && secondsTo(round.closesAt) > 0;
  if (open && myOffer === undefined) {
    // The form stays put while it is on screen, so a click is never lost to a redraw: only the clock and the others change.
    const key = `form:${run.id}:${error}`;
    if (panel.dataset.view === key) {
      panel.querySelector(".countdown")!.textContent = `Offers close in ${secondsTo(round!.closesAt)} s`;
      panel.querySelector(".others")!.outerHTML = others;
      return;
    }
    panel.dataset.view = key;
    panel.innerHTML = `<p class="countdown">Offers close in ${secondsTo(round!.closesAt)} s</p>
<label for="amount">Your ${S.offer}, ${esc(range(run))}</label>
<div class="amount-row"><input id="amount" type="number" inputmode="numeric" min="${run.terms.minBid}" max="${run.terms.maxBid}" step="${S.step}" value="${S.presets[0]}"><span class="unit">${esc(run.terms.unit)}</span></div>
<p class="hint" id="amount-detail">${S.detail(S.presets[0]!)}</p>
<div class="presets">${S.presets.map((p) => `<button type="button" data-preset="${p}">${S.money(p)}</button>`).join("")}</div>
<button class="primary" type="button" data-action="seal">Seal my ${S.offer}</button>
${error ? `<p class="error">${esc(error)}</p>` : ""}
<p class="hint">Others in this round:</p>${others}`;
    return;
  }
  const mine = myOffer !== undefined ? `<p class="sealed-note">Your ${S.offer} of <strong>${S.money(myOffer)}</strong> is sealed. It was sealed in this browser; nobody, the ${NAME === "rental" ? "agent" : "desk"} included, can read it before the round opens.</p>` : `<p>You did not make an ${S.offer} in time.</p>`;
  const when = round ? (run.phase === "open" ? `<p class="countdown">Offers close in ${secondsTo(round.closesAt)} s</p>` : `<p class="countdown">Closed. The offers open when the public clock reaches round ${round.releaseRound}${secondsTo(round.opensAt) ? `, in about ${secondsTo(round.opensAt)} s` : ""}.</p>`) : "";
  panel.innerHTML = `${when}${mine}<p class="hint">Others in this round:</p>${others}`;
}

const range = (run: Run): string => (run.terms.rule === "highest-bid" ? `from ${S.money(run.terms.minBid)} up to ${S.money(run.terms.maxBid)}` : `from ${S.money(run.terms.minBid)}; ${run.terms.reserve ? `at most ${S.money(run.terms.reserve)} to win` : ""}`);
const again = (): string => `<button class="primary" type="button" data-action="start">Run it again</button>`;

function renderIdle(): void {
  if (panel.dataset.idle === "1") return;
  panel.dataset.idle = "1";
  panel.innerHTML = `<p class="offer-intro">${NAME === "rental" ? "Offers for this flat are taken in one sealed round. Open it, and you and four other applicants (simulated by this demonstration) each make one offer, up to the advertised rent." : "Open the auction, and your fund and three other funders (simulated by this demonstration) each quote one discount. The lowest within the reserve funds the invoice."}</p><button class="primary" type="button" data-action="start">${S.start}</button>${error ? `<p class="error">${esc(error)}</p>` : '<p class="hint">About a minute. Your ${S.offer} is sealed in this browser.</p>'}`;
}

function renderResult(run: Run): void {
  if (panel.dataset.view === `result:${run.id}`) return;
  panel.dataset.view = `result:${run.id}`;
  const o = run.outcome!;
  const winner = o.winner;
  const head = winner ? `<p class="result-head">${esc(S.headline(winner.label, S.money(winner.amount), winner.label === S.you))}</p><p>${esc(S.then(winner.label))}${NAME === "funding" ? ` ${S.detail(winner.amount)}.` : ""}</p>` : `<p class="result-head">No winner</p><p>${o.reserveMet === false ? "No quote was within the reserve." : "There was no valid offer."}</p>`;
  const rows = o.bids.map((b) => `<tr class="${winner && b.label === winner.label ? "win" : ""}${b.label === S.you ? " you" : ""}"><td>${esc(b.label === S.you ? S.you : b.label)}</td><td class="num">${b.amount !== undefined ? S.money(b.amount) : "–"}</td></tr>`).join("");
  panel.innerHTML = `${head}
<p class="hint">What the ${NAME === "rental" ? "agent" : "desk"} sees once the ${S.plural} open, shown here so you can see the whole round. Each ${NAME === "rental" ? "applicant" : "funder"} sees only the winning ${S.offer} and their own.</p>
<table class="bids"><thead><tr><th>${NAME === "rental" ? "Applicant" : "Funder"}</th><th class="num">${S.offer[0]!.toUpperCase()}${S.offer.slice(1)}</th></tr></thead><tbody>${rows}</tbody></table>
<div id="checked">${checked?.runId === run.id ? checked.html : '<p class="hint">Checking the result in your browser…</p>'}</div>
${again()}`;
  if (checked?.runId !== run.id) void check(run);
}

// --- checking in the browser -------------------------------------------------------------

const toHex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const fromHex = (h: string): Uint8Array => Uint8Array.from(h.match(/../g)!.map((x) => parseInt(x, 16)));

/** Work the result out from the evidence and the disclosed keys, and explain a draw if there was one. */
async function check(run: Run): Promise<void> {
  const inputs = run.evidence!.rounds[0]!;
  const verifier = { acceptedBeacons: state!.mode === "simulated" ? [state!.beacon] : [QUICKNET] };
  const result = await verifyAuction(inputs, verifier, bidOpenerWithFileKeys(run.evidence!.fileKeys ?? {}));
  const mine = me ? generateKeyPair(me.secrets().signingKey!).publicKey : "";
  const who = (key: string) => (key === mine ? S.you : (run.others.find((x) => x.publicKey === key)?.label ?? "Someone"));
  const passed = result.checks.filter((c) => c.ok).length;
  const agrees = result.ok && (result.winner?.amount ?? null) === (run.outcome!.winner?.amount ?? null) && (!result.winner || who(result.winner.submitter) === run.outcome!.winner!.label);
  let draw = "";
  if (result.winner) {
    const tied = result.bids.filter((b) => b.status === "valid" && b.amount === result.winner!.amount);
    if (tied.length > 1) {
      // The same draw as the verifier's: the lowest hash of the release round's signature and each bid's envelope id.
      const keyOf = (id: string) => toHex(hashLabelled("mattering/tie-break/v1", new Uint8Array([...fromHex(inputs.release.signature), ...fromHex(id)])));
      const drawn = tied.map((b) => ({ label: who(b.submitter), key: keyOf(b.envelopeId) })).sort((a, b) => (a.key < b.key ? -1 : 1));
      draw = `<div class="draw"><strong>${tied.length} ${NAME === "rental" ? "applicants" : "funders"} tied at ${S.money(result.winner.amount)}.</strong> The draw used the public clock's signature for round ${inputs.release.round}, which nobody could know before the offers were sealed. Each tied ${S.offer} got a number from that signature, and the lowest won:<br>${drawn.map((d, i) => `${i === 0 ? "<strong>" : ""}${esc(d.label)}: ${d.key.slice(0, 10)}…${i === 0 ? " wins</strong>" : ""}`).join("<br>")}</div>`;
    }
  }
  const html = `${draw}<p class="${agrees ? "checked" : "error"}">${agrees ? `Checked in your browser: all ${passed} checks passed, and the evidence gives the same result.` : "Your browser could not confirm this result from the evidence."}</p><details><summary class="hint">Show the checks</summary><ul class="checks">${result.checks.map((c) => `<li>${c.ok ? "Passed" : "Failed"}: ${esc(c.name)}</li>`).join("")}</ul></details>`;
  checked = { runId: run.id, html };
  const el = document.getElementById("checked");
  if (el) el.innerHTML = html;
}

// --- actions ------------------------------------------------------------------------------

async function start(): Promise<void> {
  error = "";
  me = undefined;
  myOffer = undefined;
  checked = undefined;
  panel.dataset.idle = "";
  panel.dataset.view = "";
  panel.innerHTML = '<p class="hint">Opening the round…</p>';
  try {
    state = await call<State>("POST", "/scenario/start", { name: NAME });
    const run = state.run!;
    // Join with the invitation, from this browser: the SDK makes your key here, and keeps it here.
    me = await client().join(run.invitation);
    save(run.sessionId, { secrets: me.secrets() });
  } catch (e) {
    error = (e as Error).message;
    panel.dataset.idle = "";
  }
  render();
}

async function seal(): Promise<void> {
  const input = document.getElementById("amount") as HTMLInputElement | null;
  const amount = Number(input?.value);
  const run = state?.run;
  if (!run || !me) return;
  if (!Number.isInteger(amount) || amount < run.terms.minBid || amount > run.terms.maxBid) {
    error = `Your ${S.offer} must be a whole number ${range(run)}.`;
    return render();
  }
  error = "";
  panel.querySelector<HTMLButtonElement>('[data-action="seal"]')!.disabled = true;
  try {
    // Sealed here, under the round's policy, which the SDK checks first; only the envelope and a signature are sent.
    await me.bid(amount);
    myOffer = amount;
    save(run.sessionId, { secrets: me.secrets(), offer: amount });
  } catch (e) {
    error = e instanceof MatteringApiError ? e.message : (e as Error).message;
  }
  render();
}

panel.addEventListener("click", (event) => {
  const target = event.target as HTMLElement;
  const action = target.closest<HTMLElement>("[data-action]")?.dataset.action;
  if (action === "start") void start();
  if (action === "seal") void seal();
  const preset = target.closest<HTMLElement>("[data-preset]")?.dataset.preset;
  if (preset) {
    const input = document.getElementById("amount") as HTMLInputElement;
    input.value = preset;
    document.getElementById("amount-detail")!.textContent = S.detail(Number(preset));
  }
});
panel.addEventListener("input", (event) => {
  if ((event.target as HTMLElement).id === "amount") document.getElementById("amount-detail")!.textContent = S.detail(Number((event.target as HTMLInputElement).value));
});

// --- following along -------------------------------------------------------------------------

async function poll(): Promise<void> {
  try {
    state = await call<State>("GET", "/scenario/state");
    const run = state.run;
    if (run && run.name === NAME && !me) {
      // Pick up a round this browser joined before a reload.
      const s = saved(run.sessionId);
      if (s) {
        me = client().resume(s.secrets);
        myOffer = s.offer;
      }
    }
  } catch {
    // The room may not exist yet: nothing to show until the visitor starts.
  }
  render();
}
// Hosted, a room exists only once the visitor starts; don't create one just by looking.
if (hasRoom()) void poll();
else renderIdle();
setInterval(() => {
  if (hasRoom()) void poll();
}, 1000);
