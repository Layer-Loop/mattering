/**
 * The Sealed Room, browser side. Sealing a visitor's bid, opening the bids and
 * verifying the auction all happen here, with the same library the server and
 * the tests use. The server is asked for evidence, never for a verdict.
 */
import {
  MatteringError,
  QUICKNET,
  generateKeyPair,
  open,
  prepareBid,
  sameOutcome,
  verifyAuction,
  verifyStatements,
  type AuctionInputs,
  type AuctionPolicy,
  type AuctionResult,
  type BeaconInfo,
  type Envelope,
  type KeyPair,
  type Release,
  type StatementInputs,
  type StatementPolicy,
  type StatementsResult,
} from "@mattering/core";

interface RunState {
  id: number;
  auction: AuctionPolicy;
  auctionHash: string;
  forecast: StatementPolicy;
  forecastHash: string;
  closeAt: number;
  releaseAt: number;
  agents: { name: string; tagline: string; series: number; publicKey: string; submitted: boolean }[];
  phase: "open" | "closed" | "released";
  cosigned: boolean;
  entries: { submitter: string; envelopeId: string }[];
}
interface State {
  mode: "live" | "simulated";
  beacon: BeaconInfo;
  slot: { title: string; detail: string; minBid: number; maxBid: number };
  serverTime: number;
  run: RunState | null;
}

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const escape = (text: string): string => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const pounds = (amount: number): string => "£" + amount.toLocaleString("en-GB");

async function getJson<T>(path: string, body?: unknown): Promise<{ ok: boolean; status: number; json: T }> {
  const response = await fetch(path, body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { ok: response.ok, status: response.status, json: (await response.json()) as T };
}

let state: State | undefined;
let skew = 0;
let startedAt = 0;
let visitor: { runId: number; keys: KeyPair; amount: number; submitted: boolean } | undefined;
let outcome: { runId: number; auction: AuctionResult; statements: StatementsResult; inputs: AuctionInputs } | undefined;
let working = false;
const ciphers = new Map<string, string>();

/** The clock this browser accepts. In live mode it is compiled into the page, not taken from the server. */
function verifier(): { acceptedBeacons: BeaconInfo[] } {
  return { acceptedBeacons: [state!.mode === "live" ? QUICKNET : state!.beacon] };
}

async function evidence<T>(hash: string): Promise<T> {
  return (await getJson<T>(`/api/policies/${hash}/evidence`)).json;
}

async function resolveOutcome(run: RunState): Promise<void> {
  if (working || outcome?.runId === run.id) return;
  working = true;
  try {
    const inputs = await evidence<AuctionInputs>(run.auctionHash);
    const auction = await verifyAuction(inputs, verifier());
    const statements = await verifyStatements(await evidence<StatementInputs>(run.forecastHash), verifier());
    outcome = { runId: run.id, auction, statements, inputs };
    showChecks(auction);
  } finally {
    working = false;
  }
}

const CHECK_TEXT: Record<string, string> = {
  "policy-well-formed": "The auction's rules are intact",
  "beacon-accepted": "The clock is the one this browser expects",
  "closing-checkpoint-signed-by-witness": "The auctioneer signed the final list of bids",
  "closing-checkpoint-is-for-this-policy": "That list belongs to this auction",
  "closed-at-the-close-round": "Bidding closed at the agreed time, not before",
  "closing-checkpoint-cosigned-before-release": "An independent party countersigned the list before any bid could be read",
  "log-matches-closing-checkpoint": "The list we were given is the list that was signed",
  "release-valid": "The key that opens the bids is the genuine one for the agreed time",
  "every-on-time-bid-judged": "Every bid that arrived in time was opened and checked",
};

function showChecks(result: AuctionResult): void {
  $("checks").innerHTML =
    result.checks.map((c) => `<li><span class="${c.ok ? "mark-ok" : "mark-no"}">${c.ok ? "✓" : "✗"}</span><span>${escape(CHECK_TEXT[c.name] ?? c.name)}</span></li>`).join("") +
    `<li class="muted">Checked in this browser at ${new Date().toLocaleTimeString()}.</li>`;
}

function nameOf(run: RunState, key: string): string {
  if (visitor?.runId === run.id && visitor.keys.publicKey === key) return "You";
  return run.agents.find((a) => a.publicKey === key)?.name ?? "An unknown bidder";
}

function render(): void {
  if (!state) return;
  const { slot, run } = state;
  $("lot-title").textContent = slot.title;
  $("lot-detail").textContent = `${slot.detail} Bids from ${pounds(slot.minBid)} to ${pounds(slot.maxBid)}. Highest bid wins.`;
  const mode = $("mode");
  mode.hidden = state.mode === "live";
  mode.textContent = "Simulated clock";
  $("trust-clock").textContent =
    state.mode === "live"
      ? "The drand network, run by a group of independent organisations. If enough of them colluded, bids could be opened early."
      : "In this offline mode the clock is simulated on this machine, so whoever runs the machine could open bids early. Online, it is the public drand network.";
  $<HTMLButtonElement>("start").textContent = run ? "Start a new auction" : "Start the auction";
  for (const id of ["clock", "bids-section", "cheat-section", "verify-section"]) $(id).hidden = !run;
  if (!run) return;

  // Clock.
  const now = Date.now() + skew;
  const target = run.phase === "open" ? run.closeAt : run.releaseAt;
  const seconds = Math.max(0, Math.ceil((target - now) / 1000));
  const released = run.phase === "released";
  $("phase-label").textContent = released ? "Opened" : run.phase === "open" ? "Bidding open" : "Closed, still sealed";
  $("count").textContent = released ? "Done" : seconds > 0 ? `${seconds}s` : "…";
  $("count-what").textContent = released ? "" : run.phase === "open" ? "until bidding closes" : "until every bid opens";
  $("phase-note").textContent = released
    ? "The key was published and every bid opened at the same moment. No bidder had to come back to reveal anything."
    : run.phase === "open"
      ? "Bids are being sealed. The key that opens them does not exist yet."
      : run.cosigned
        ? "No more bids. The final list has been signed by the auctioneer and countersigned by an independent party, while nobody can read it."
        : "No more bids. Waiting for the final list to be signed.";
  for (const [id, phase] of [["step-open", "open"], ["step-closed", "closed"], ["step-released", "released"]] as const) {
    const order = { open: 0, closed: 1, released: 2 };
    $(id).className = order[phase] === order[run.phase] ? "on" : order[phase] < order[run.phase] ? "done" : "";
  }
  const total = run.releaseAt - startedAt;
  $("bar").style.width = `${released ? 100 : Math.min(100, Math.max(0, ((now - startedAt) / total) * 100))}%`;
  $("close-mark").style.left = `${((run.closeAt - startedAt) / total) * 100}%`;

  // Bids.
  const result = outcome?.runId === run.id ? outcome : undefined;
  const cards = run.agents.map((a) => ({ name: a.name, tagline: a.tagline, colour: `var(--s${a.series})`, key: a.publicKey, submitted: a.submitted }));
  if (visitor?.runId === run.id && visitor.submitted) cards.push({ name: "You", tagline: run.phase === "released" ? "You sealed this bid in your browser. It opened with the others." : `You sealed a bid in this browser. Until the bids open, only you know it is ${pounds(visitor.amount)}.`, colour: "var(--s4)", key: visitor.keys.publicKey, submitted: true });
  $("bids").innerHTML = cards
    .map((card) => {
      const entry = run.entries.find((e) => e.submitter === card.key);
      const bid = result?.auction.bids.find((b) => b.submitter === card.key);
      const said = result?.statements.statements.find((s) => s.author === card.key);
      let envelope: string;
      if (bid?.amount !== undefined) {
        const won = result?.auction.winner?.submitter === card.key;
        envelope = `<div class="envelope ${bid.status === "valid" ? "" : "invalid"}"><p class="amount">${pounds(bid.amount)}</p>${won ? '<span class="win">Winner</span>' : ""}${bid.status === "valid" ? "" : `<p class="reason">Not counted: ${escape(bid.reason ?? "invalid")}</p>`}</div>`;
      } else if (entry) {
        envelope = `<div class="envelope sealed"><p class="state">Sealed</p><p class="cipher">${escape(ciphers.get(entry.envelopeId) ?? "")}</p></div>`;
        if (!ciphers.has(entry.envelopeId)) {
          ciphers.set(entry.envelopeId, "");
          void getJson<Envelope>(`/api/envelopes/${entry.envelopeId}`).then(({ json }) => ciphers.set(entry.envelopeId, json.ciphertext.split("\n").slice(4, 6).join("").slice(0, 96) + "…"));
        }
      } else {
        envelope = `<div class="envelope"><p class="state muted">${run.phase === "open" ? "Deciding…" : "No bid"}</p></div>`;
      }
      const quote = said?.text ? `<p class="said">Sealed with the bid: “${escape(said.text)}”</p>` : "";
      return `<article class="card" style="--c:${card.colour}"><h3>${escape(card.name)}</h3><p class="tag">${escape(card.tagline)}</p>${envelope}${quote}</article>`;
    })
    .join("");

  // Join form.
  const canJoin = run.phase === "open" && !(visitor?.runId === run.id);
  $("join").hidden = !(run.phase === "open") || (visitor?.runId === run.id && visitor.submitted);
  $<HTMLInputElement>("amount").min = String(slot.minBid);
  $<HTMLInputElement>("amount").max = String(slot.maxBid);
  $<HTMLButtonElement>("join").querySelector("button")!.disabled = !canJoin;
  $<HTMLButtonElement>("verify").disabled = !released;
  if (released) void resolveOutcome(run);
}

async function poll(): Promise<void> {
  try {
    const { json } = await getJson<State>("/demo/state");
    skew = json.serverTime - Date.now();
    if (json.run && json.run.id !== state?.run?.id) {
      startedAt = startedAt && state?.run?.id === json.run.id ? startedAt : Date.now() + skew;
      for (const id of ["out-peek", "out-late", "out-rewrite", "out-winner"]) setOut(id, "", "");
      $("checks").innerHTML = "";
      $("join-note").textContent = "";
    }
    state = json;
    render();
  } catch {
    // the server is restarting or gone; keep showing what we have
  }
}

// --- actions -------------------------------------------------------------------

$("start").addEventListener("click", () => {
  void (async () => {
    $<HTMLButtonElement>("start").disabled = true;
    outcome = undefined;
    visitor = undefined;
    startedAt = 0;
    await getJson("/demo/start", {});
    startedAt = Date.now() + skew;
    await poll();
    $<HTMLButtonElement>("start").disabled = false;
  })();
});

$("join").addEventListener("submit", (event) => {
  event.preventDefault();
  void (async () => {
    const run = state?.run;
    if (!run) return;
    const amount = Number($<HTMLInputElement>("amount").value);
    const keys = generateKeyPair();
    visitor = { runId: run.id, keys, amount, submitted: false };
    const bid = await prepareBid(run.auction, amount, keys);
    const sent = JSON.stringify(bid);
    const response = await getJson<{ error?: string }>("/api/submissions", bid);
    if (response.ok) {
      visitor.submitted = true;
      $("join-note").textContent = `Sealed and accepted. What was sent contains the amount: ${sent.includes(`"amount"`) ? "yes (this should not happen)" : "no"}.`;
    } else {
      visitor = undefined;
      $("join-note").textContent = `Refused: ${response.json.error ?? "unknown reason"}.`;
    }
    render();
  })();
});

function setOut(id: string, kind: "" | "refused" | "wait" | "alarm", text: string): void {
  const el = $(id);
  el.className = `out ${kind}`;
  el.textContent = text;
}

const cheats: Record<string, (run: RunState) => Promise<void>> = {
  async peek(run) {
    const entry = run.entries[0];
    if (!entry) return setOut("out-peek", "wait", "No bid has been sealed yet. Try again in a few seconds.");
    if (run.phase === "released") return setOut("out-peek", "wait", "The bids are open now, so there is nothing left to peek at. Start a new auction and try while they are sealed.");
    const envelope = (await getJson<Envelope>(`/api/envelopes/${entry.envelopeId}`)).json;
    const latest = (await getJson<Release>("/demo/latest")).json;
    try {
      await open(envelope, { round: envelope.round, signature: latest.signature }, verifier());
      setOut("out-peek", "alarm", "The bid opened early. This should not be possible.");
    } catch (error) {
      if (!(error instanceof MatteringError)) throw error;
      setOut("out-peek", "refused", `Refused. We tried to open the bid from ${nameOf(run, entry.submitter)} with the newest key in existence. It does not fit: the key for this envelope has not been created yet.`);
    }
  },
  async late(run) {
    if (run.phase === "open") return setOut("out-late", "wait", "Bidding is still open, so this would be an ordinary bid. Try again after it closes.");
    const bid = await prepareBid(run.auction, run.auction.maxBid, generateKeyPair());
    const response = await getJson<{ error?: string }>("/api/submissions", bid);
    if (response.ok) setOut("out-late", "alarm", "The late bid was accepted. This should not be possible.");
    else setOut("out-late", "refused", `Refused. A bid of ${pounds(run.auction.maxBid)} was sealed and sent, and the auctioneer turned it away: bidding closed at the agreed time.`);
  },
  async rewrite(run) {
    if (run.phase !== "released") return setOut("out-rewrite", "wait", "This cheat only makes sense once the bids can be read. Try again after they open.");
    const { json } = await getJson<{ shillAmount: number; cosignerSaid: string; evidence: AuctionInputs }>("/demo/forge", {});
    const result = await verifyAuction(json.evidence, verifier());
    if (result.ok) setOut("out-rewrite", "alarm", "The rewritten list was accepted. This should not be possible.");
    else setOut("out-rewrite", "refused", `Rejected. The auctioneer added a bid of ${pounds(json.shillAmount)} and signed a new list with its real key. This browser refused it: the independent cosigner had already signed the original list before any bid could be read, and will not sign a second one.`);
  },
  async winner(run) {
    const result = outcome?.runId === run.id ? outcome : undefined;
    if (run.phase !== "released" || !result) return setOut("out-winner", "wait", "There is no result to lie about yet. Try again after the bids open.");
    const valid = result.auction.bids.filter((b) => b.status === "valid" && b.amount !== undefined).sort((a, b) => a.amount! - b.amount!);
    const loser = valid[0];
    const real = result.auction.winner;
    if (!loser || !real || loser.submitter === real.submitter) return setOut("out-winner", "wait", "There is only one valid bid, so there is no other winner to announce.");
    const fresh = await verifyAuction(result.inputs, verifier());
    if (sameOutcome(fresh, { submitter: loser.submitter, amount: loser.amount! })) setOut("out-winner", "alarm", "The false announcement was accepted. This should not be possible.");
    else setOut("out-winner", "refused", `Exposed. We announced ${nameOf(run, loser.submitter)} at ${pounds(loser.amount!)}. Recomputing from the evidence gives ${nameOf(run, real.submitter)} at ${pounds(real.amount)}, and anyone can do the same.`);
  },
};

for (const button of document.querySelectorAll<HTMLButtonElement>("[data-cheat]")) {
  button.addEventListener("click", () => {
    const run = state?.run;
    const name = button.dataset.cheat!;
    if (!run) return;
    button.disabled = true;
    setOut(`out-${name}`, "wait", "Trying…");
    void cheats[name]!(run)
      .catch((error: Error) => setOut(`out-${name}`, "alarm", `Something went wrong: ${error.message}`))
      .finally(() => (button.disabled = false));
  });
}

$("verify").addEventListener("click", () => {
  void (async () => {
    const run = state?.run;
    if (!run) return;
    $("checks").innerHTML = '<li class="muted">Fetching the evidence and checking…</li>';
    const inputs = await evidence<AuctionInputs>(run.auctionHash);
    showChecks(await verifyAuction(inputs, verifier()));
  })();
});

void poll();
setInterval(() => void poll(), 500);
