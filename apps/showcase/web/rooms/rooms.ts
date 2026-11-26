/**
 * The two demo rooms' page, the Sealed Room (an auction) and the Negotiation
 * Room. The page says which room it is (`<html data-room>`). It shows one
 * screen at a time: the intro, then the room as a conversation between the
 * agents while it runs, then the result. Everything is drawn from what the
 * room's server reports and from evidence checked in this browser with the
 * same library the tests use. The server is asked for evidence, never for a
 * verdict.
 */
import {
  MatteringError,
  QUICKNET,
  cosignatureTime,
  generateKeyPair,
  open,
  parseNote,
  parseVkey,
  prepareBid,
  verifyAuction,
  verifyStatements,
  type AuctionInputs,
  type AuctionPolicy,
  type AuctionResult,
  type BeaconInfo,
  type Check,
  type Envelope,
  type KeyPair,
  type Mandate,
  type MandateOpening,
  type Release,
  type Side,
  type StatementInputs,
  type StatementsResult,
} from "@mattering/core";
import { verifyNegotiation, verifyNegotiationStep, withFileKeys, type NegotiationResult, type StepInputs, type StepResult } from "@mattering/core/negotiation";

// --- the room and its server -------------------------------------------------------

const ROOM = document.documentElement.dataset.room === "negotiation" ? "negotiation" : "auction";
const AUCTION = ROOM === "auction";

/**
 * Where the room lives. On a laptop the page and the room share an origin and
 * the base is empty. On the hosted site each visitor's browser session has a
 * room of its own, shared by both pages.
 */
const template = document.documentElement.dataset.roomBase;
const HAD_ROOM = template !== undefined && sessionStorage.getItem("mattering-room") !== null;
function roomBase(): string {
  if (!template) return "";
  let id = sessionStorage.getItem("mattering-room");
  if (!id) {
    id = crypto.randomUUID();
    sessionStorage.setItem("mattering-room", id);
  }
  return template.replace("{id}", id);
}
/** Hosted: no room is created until the visitor presses Start (or had one already). */
const LAZY = template !== undefined;
let base: string | undefined = LAZY && !HAD_ROOM ? undefined : roomBase();

async function getJson<T>(path: string, body?: unknown): Promise<{ ok: boolean; status: number; json: T }> {
  base ??= roomBase();
  const response = await fetch(base + path, body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  let json: unknown = {};
  try {
    json = await response.json();
  } catch {
    // an empty or broken reply; the caller sees ok and status
  }
  return { ok: response.ok, status: response.status, json: json as T };
}

// --- formatting ---------------------------------------------------------------------

const esc = (text: string): string => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const num = (n: number): string => n.toLocaleString("en-GB");
const pounds = (n: number): string => "£" + num(n);
const clockTime = (ms: number): string => new Date(ms).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
const mmss = (seconds: number): string => {
  const s = Math.max(0, Math.ceil(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};
const list = (items: string[]): string => (items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`);
const LOCK = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="10" width="16" height="11" rx="2"></rect><path d="M8 10V7a4 4 0 0 1 8 0v3"></path></svg>`;
const OPEN = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="10" width="16" height="11" rx="2"></rect><path d="M8 10V7a4 4 0 0 1 7.5-2"></path></svg>`;

// --- what every room shares ---------------------------------------------------------

let mode: "live" | "simulated" = "live";
/** The model that chooses, by name; null when scripts do; undefined until known. */
let decider: string | null | undefined;
let beacon: BeaconInfo = QUICKNET;
let skew = 0;
const now = (): number => Date.now() + skew;
let starting = false;

/** The clock this browser accepts. In live mode it is compiled into the page, not taken from the server. */
function verifier(): { acceptedBeacons: BeaconInfo[] } {
  return { acceptedBeacons: [mode === "live" ? QUICKNET : beacon] };
}
/** The clock's name in a sentence: drand, or the simulated clock when offline. */
const drand = (): string => (mode === "live" ? "drand" : "the simulated clock");

/** When the closing list was countersigned, in milliseconds, read from the evidence itself. Offline the cosigner's clock is simulated, so there is no such time to show. */
function cosignedAt(evidence: { policy: { cosigners: readonly string[] }; witnessed?: { checkpoint: string } | undefined }): number | undefined {
  if (!evidence.witnessed || mode !== "live") return undefined;
  try {
    const note = parseNote(evidence.witnessed.checkpoint);
    const times = evidence.policy.cosigners.map((vkey) => cosignatureTime(note, parseVkey(vkey))).filter((t): t is number => t !== undefined);
    return times.length ? Math.min(...times) * 1000 : undefined;
  } catch {
    return undefined;
  }
}

interface CheatOut {
  at: number;
  verdict: string;
  detail: string;
  alarm?: boolean;
}
interface Cheat {
  id: string;
  title: string;
  how: string;
  /** What the thread says the visitor did. */
  did: string;
}
const cheatOut = new Map<string, CheatOut>();
const cheatBusy = new Set<string>();
interface CheckItem {
  ok: boolean;
  text: string;
  detail: string;
}
let checks: { status: "idle" | "running" | "done"; runId?: number; at?: number; items?: CheckItem[]; error?: string } = { status: "idle" };

/** Group a verifier's named checks under one line of the page. Any check not named in a group counts against `rest`. */
function grouped(all: Check[], groups: Record<string, readonly string[]>, rest: string): Record<string, Check[]> {
  const out: Record<string, Check[]> = Object.fromEntries(Object.keys(groups).map((k) => [k, []]));
  for (const c of all) {
    const key = Object.keys(groups).find((k) => groups[k]!.includes(c.name)) ?? rest;
    out[key]!.push(c);
  }
  return out;
}
const failures = (cs: Check[]): string => cs.filter((c) => !c.ok).map((c) => `${c.name}${c.detail ? `: ${c.detail}` : ""}`).join("; ");
const EVIDENCE_GROUPS = {
  clock: ["beacon-accepted", "release-valid"],
  cosigned: ["closing-checkpoint-signed-by-witness", "closed-at-the-close-round", "closing-checkpoint-cosigned-before-release"],
  intact: ["closing-checkpoint-is-for-this-policy", "log-matches-closing-checkpoint", "closing-is-the-close-entry", "closed-only-once"],
  opens: ["every-on-time-bid-judged", "offers-judged"],
  rules: ["policy-well-formed"],
} as const;
const allOk = (cs: Check[]): boolean => cs.length > 0 && cs.every((c) => c.ok);

// --- the conversation -----------------------------------------------------------------

/** One line of the conversation, placed by time. */
interface Msg {
  at: number;
  html: string;
}
interface Bubble {
  side: "left" | "right";
  who: string;
  avatar: string;
  tone: string;
  sealed: boolean;
  /** Opened: the amount, large. */
  amount?: string;
  tag?: { text: string; kind: "win" | "bad" };
  /** Sealed: a line under the lock. Opened: the agent's words, or a line about them. */
  text?: string;
  quote?: boolean;
  small?: string;
  fresh?: boolean;
}
function bubble(b: Bubble): string {
  const body = b.sealed
    ? `<p class="lock">${LOCK}<span>Sealed</span></p>${b.text ? `<p class="sub">${esc(b.text)}</p>` : ""}`
    : `<p class="amount">${OPEN}<span>${esc(b.amount ?? "")}</span>${b.tag ? `<em class="tag ${b.tag.kind}">${esc(b.tag.text)}</em>` : ""}</p>${b.text ? `<p class="words">${b.quote ? `“${esc(b.text)}”` : esc(b.text)}</p>` : ""}`;
  return `<li class="msg ${b.side}"><span class="avatar ${b.tone}" aria-hidden="true">${esc(b.avatar)}</span><div class="bubble${b.sealed ? " sealed" : " opened"}${b.fresh ? " fresh" : ""}"><p class="who">${esc(b.who)}${b.small ? ` <span>${esc(b.small)}</span>` : ""}</p>${body}</div></li>`;
}
function typing(side: "left" | "right", who: string, avatar: string, tone: string, at: number): Msg {
  return { at, html: `<li class="msg ${side}"><span class="avatar ${tone}" aria-hidden="true">${esc(avatar)}</span><div class="bubble typing"><p class="who">${esc(who)}</p><p class="dots" aria-label="deciding"><i></i><i></i><i></i></p></div></li>` };
}
function system(at: number, text: string, kind = ""): Msg {
  return { at, html: `<li class="system ${kind}"><p>${text}</p></li>` };
}
function cheatReply(c: Cheat, out: CheatOut): Msg {
  return { at: out.at, html: `<li class="system cheat${out.alarm ? " alarm" : ""}"><p><span class="you-tried">${esc(c.did)}</span> <strong>${esc(out.verdict)}</strong> ${esc(out.detail)}</p></li>` };
}
const thread = (msgs: Msg[]): string =>
  msgs
    .map((m, i) => ({ m, i }))
    .sort((a, b) => a.m.at - b.m.at || a.i - b.i)
    .map(({ m }) => m.html)
    .join("");

// --- the screens ------------------------------------------------------------------------

/** Replace an element's content only when it changed, so focus, scroll and open details survive redraws. */
const drawn = new Map<string, string>();
function patch(id: string, html: string): boolean {
  if (drawn.get(id) === html) return false;
  const el = document.getElementById(id);
  if (!el) return false;
  drawn.set(id, html);
  el.innerHTML = html;
  return true;
}

function layOut(): void {
  document.getElementById("s-live")!.innerHTML = `<div id="l-top" class="top"></div><ol id="thread" class="thread" aria-live="polite"></ol><div id="l-foot" class="foot"></div>`;
  document.getElementById("s-result")!.innerHTML = `<div id="r-main"></div>
<details id="r-trust" class="trust"><summary id="r-trust-sum"></summary><div id="r-trust-body"></div></details>
<details class="fold"><summary>Show the conversation</summary><ol id="r-thread" class="thread full"></ol></details>
<details class="fold"><summary>Try to cheat</summary><div id="r-cheats"></div></details>
<div class="again"><button type="button" class="primary" data-action="start">Run it again</button></div>`;
}

function show(screen: "intro" | "live" | "result"): void {
  for (const s of ["intro", "live", "result"]) {
    const el = document.getElementById(`s-${s}`)!;
    const hidden = s !== screen;
    if (el.hidden !== hidden) el.hidden = hidden;
  }
}

function top(phase: string, label: string, time: string, progress: number, marks: number[]): string {
  const p = Math.max(0, Math.min(1, progress)) * 100;
  return `<div class="status"><span class="phase">${esc(phase)}</span><span class="count">${esc(label)} <b role="timer">${esc(time)}</b></span></div>
<div class="bar" aria-hidden="true"><i style="width:${p.toFixed(1)}%"></i>${marks.map((m) => `<s style="left:${(Math.max(0, Math.min(1, m)) * 100).toFixed(1)}%"></s>`).join("")}</div>
<p class="byline">${AUCTION ? "Bids" : "Offers"} chosen by ${esc(chosenBy())}${mode === "simulated" ? ' · <span class="pill">Simulated clock</span>' : ""}</p>`;
}

function trust(runId: number): void {
  const done = checks.status === "done" && checks.runId === runId && checks.items;
  const passed = done ? checks.items!.filter((i) => i.ok).length : 0;
  const total = done ? checks.items!.length : 0;
  const ok = done && passed === total;
  patch("r-trust-sum", done ? `<span class="mark ${ok ? "ok" : "no"}">${ok ? "✓" : "✗"}</span> Checked in your browser: ${ok ? `all ${total} checks passed` : `${total - passed} of ${total} checks failed`}` : checks.error ? `<span class="mark no">!</span> ${esc(checks.error)}` : '<span class="mark">…</span> Checking in your browser');
  document.getElementById("r-trust")!.classList.toggle("failed", !!done && !ok);
  patch(
    "r-trust-body",
    done
      ? `<p class="small">The checks ran in this browser at ${clockTime(checks.at!)}, against ${mode === "live" ? "drand’s" : "the simulated clock’s"} public key and the log, without taking the server’s word for anything.</p>
<ol class="checks">${checks.items!.map((i) => `<li class="${i.ok ? "" : "failed"}"><span class="mark ${i.ok ? "ok" : "no"}" aria-hidden="true">${i.ok ? "✓" : "✗"}</span><div><p><span class="sr">${i.ok ? "Passed" : "Failed"}: </span>${esc(i.text)}</p><p class="small">${esc(i.detail)}</p></div></li>`).join("")}</ol>
<p class="links"><button type="button" class="link" data-action="check">Run the checks again</button> · <a href="#" data-action="download">Download the evidence</a> · <a href="https://github.com/Layer-Loop/mattering/blob/main/apps/showcase/web/rooms/rooms.ts">Read the code that runs</a></p>
<p class="small">Check the download offline with <code>mattering check-demo</code>.</p>`
      : "",
  );
}

function cheatList(cheats: Cheat[]): string {
  return `<p class="small">Each button makes a real attempt against this ${AUCTION ? "auction" : "negotiation"}. What comes back is shown as it came.</p><ul class="cheats">${cheats
    .map((c) => {
      const out = cheatOut.get(c.id);
      const busy = cheatBusy.has(c.id);
      return `<li><div><p class="title">${esc(c.title)}</p><p class="small">${esc(c.how)}</p></div><button type="button" class="ghost" data-action="cheat" data-cheat="${c.id}"${busy ? " disabled" : ""}>${busy ? "Trying…" : out ? "Try again" : "Try it"}</button>${out ? `<p class="reply${out.alarm ? " alarm" : ""}" role="status"><strong>${esc(out.verdict)}</strong> ${esc(out.detail)}</p>` : ""}</li>`;
    })
    .join("")}</ul>`;
}

function setStart(label: string, disabled: boolean): void {
  const button = document.getElementById("start") as HTMLButtonElement;
  button.textContent = label;
  button.disabled = disabled;
}
function showStartError(text: string): void {
  const el = document.getElementById("start-error")!;
  el.hidden = text === "";
  el.textContent = text;
}
function chosenBy(): string {
  return decider === undefined ? "a language model" : decider ?? "a script";
}

// --- the auction ------------------------------------------------------------------------

namespace Auction {
  interface Agent { name: string; tagline: string; publicKey: string; submitted: boolean; decidedBy?: "model" | "script"; sealedAt?: number; logIndex?: number }
  interface Run {
    id: number;
    auction: AuctionPolicy;
    auctionHash: string;
    forecastHash: string;
    closeAt: number;
    releaseAt: number;
    startedAt?: number;
    closeRound?: number;
    releaseRound?: number;
    agents: Agent[];
    phase: "open" | "closed" | "released";
    cosigned: boolean;
    entries: { submitter: string; envelopeId: string }[];
  }
  interface State { mode: "live" | "simulated"; beacon: BeaconInfo; serverTime: number; slot: { minBid: number; maxBid: number }; run: Run | null }

  let state: State | undefined;
  let visitor: { runId: number; keys: KeyPair; amount: number; sealedAt?: number; submitted: boolean } | undefined;
  let youNote: { text: string; bad?: boolean } | undefined;
  let outcome: { runId: number; auction: AuctionResult; statements: StatementsResult; inputs: AuctionInputs; statementInputs: StatementInputs; cosignedAt?: number } | undefined;
  let resolving = false;
  /** When this page first saw each bid, for bids a room did not time. */
  const seen = new Map<string, number>();
  let shownRun: number | undefined;

  const TONES = ["t1", "t2", "t3"];
  const startOf = (run: Run): number => run.startedAt ?? run.closeAt - 30_000;
  const mine = (run: Run): typeof visitor => (visitor?.runId === run.id && visitor.submitted ? visitor : undefined);
  const nameOf = (run: Run, key: string): string => (mine(run)?.keys.publicKey === key ? "You" : run.agents.find((a) => a.publicKey === key)?.name ?? "An unknown bidder");
  const opened = (run: Run) => (run.phase === "released" && outcome?.runId === run.id ? outcome : undefined);

  async function resolve(run: Run): Promise<void> {
    if (resolving || outcome?.runId === run.id) return;
    resolving = true;
    try {
      const inputs = (await getJson<AuctionInputs>(`/api/policies/${run.auctionHash}/evidence`)).json;
      const statementInputs = (await getJson<StatementInputs>(`/api/policies/${run.forecastHash}/evidence`)).json;
      const auction = await verifyAuction(inputs, verifier());
      const statements = await verifyStatements(statementInputs, verifier());
      const cosigned = cosignedAt(inputs);
      outcome = { runId: run.id, auction, statements, inputs, statementInputs, ...(cosigned !== undefined ? { cosignedAt: cosigned } : {}) };
    } catch (error) {
      console.error("could not work out the auction:", error);
    } finally {
      resolving = false;
    }
  }

  export async function poll(): Promise<void> {
    try {
      const { json } = await getJson<State>("/demo/state");
      skew = json.serverTime - Date.now();
      mode = json.mode;
      beacon = json.beacon;
      if (json.run && json.run.id !== shownRun) {
        shownRun = json.run.id;
        cheatOut.clear();
        checks = { status: "idle" };
      }
      state = json;
      if (json.run) {
        for (const e of json.run.entries) if (!seen.has(e.submitter)) seen.set(e.submitter, now());
        if (json.run.phase === "released") await resolve(json.run);
      }
    } catch {
      // the server is restarting or gone; keep showing what we have
    }
  }
  export const runId = (): number | undefined => state?.run?.id;
  export const finished = (): boolean => !!state?.run && !!opened(state.run);
  export const running = (): boolean => !!state?.run && !finished();

  export const LIVE_CHEATS: Cheat[] = [{ id: "peek", title: "Peek at a bid early", how: "Ask for the key to Company B’s sealed bid now.", did: "You asked for the key to a sealed bid early." }];
  export const RESULT_CHEATS: Cheat[] = [
    { id: "late", title: "Slip in a late bid", how: "Send a £700,000 bid now that bidding has closed.", did: "You sent a late bid." },
    { id: "rewrite", title: "Rewrite the list as the auctioneer", how: "As the operator, add a winning bid of our own from before the close.", did: "You rewrote the list as the auctioneer." },
    { id: "announce", title: "Announce a different winner", how: "Have our server announce a losing bidder as the winner.", did: "You had the server announce another winner." },
  ];

  export async function cheat(id: string): Promise<CheatOut> {
    const run = state?.run;
    const at = now();
    if (!run) return { at, verdict: "Not yet.", detail: "Start the auction first." };
    switch (id) {
      case "peek": {
        if (run.phase === "released") return { at, verdict: "Nothing to peek at.", detail: "The bids are open now. Run it again and try while they are sealed." };
        const target = run.agents[1];
        const entry = run.entries.find((e) => e.submitter === target?.publicKey) ?? run.entries[0];
        if (!entry) return { at, verdict: "Not yet.", detail: "No bid has been sealed yet. Try again in a few seconds." };
        const envelope = (await getJson<Envelope>(`/api/envelopes/${entry.envelopeId}`)).json;
        const latest = (await getJson<Release>("/demo/latest")).json;
        try {
          await open(envelope, { round: envelope.round, signature: latest.signature }, verifier());
          return { at, verdict: "It opened.", detail: "The bid opened early. This should not be possible.", alarm: true };
        } catch (error) {
          if (!(error instanceof MatteringError)) throw error;
          return { at, verdict: "Refused.", detail: `The key to ${nameOf(run, entry.submitter)}’s bid doesn’t exist yet, for anyone. ${drand().replace(/^./, (c) => c.toUpperCase())} publishes it in about ${mmss((run.releaseAt - now()) / 1000)}.` };
        }
      }
      case "late": {
        if (run.phase === "open") return { at, verdict: "Not yet.", detail: `Bidding is still open, so this bid would be on time. Try again after ${clockTime(run.closeAt)}.` };
        const bid = await prepareBid(run.auction, 700_000, generateKeyPair());
        const response = await getJson<{ error?: string }>("/api/submissions", bid);
        if (response.ok) return { at, verdict: "Accepted.", detail: "The late bid was accepted. This should not be possible.", alarm: true };
        return { at, verdict: "Refused as late.", detail: `The bid was sealed and sent, and the log turned it away: bidding closed at ${clockTime(run.closeAt)}, and the list of bids was signed and countersigned.` };
      }
      case "rewrite": {
        if (run.phase !== "released") return { at, verdict: "Not yet.", detail: "This only pays once the bids can be read." };
        const { ok, json } = await getJson<{ shillAmount: number; evidence: AuctionInputs; error?: string }>("/demo/forge", {});
        if (!ok) return { at, verdict: "Could not try.", detail: json.error ?? "The server would not forge a list." };
        const result = await verifyAuction(json.evidence, verifier());
        if (result.ok) return { at, verdict: "Accepted.", detail: "The rewritten list was accepted. This should not be possible.", alarm: true };
        const when = outcome?.runId === run.id && outcome.cosignedAt ? ` at ${clockTime(outcome.cosignedAt)}` : "";
        return { at, verdict: "Rejected in your browser.", detail: `We added a bid of ${pounds(json.shillAmount)} and signed the new list with the log’s real key. It doesn’t extend the list countersigned${when ? `${when}, ` : " "}before any bid could be read.` };
      }
      case "announce": {
        const result = opened(run);
        if (!result) return { at, verdict: "Not yet.", detail: "There is no result to lie about yet." };
        const { ok, json } = await getJson<{ announced?: { submitter: string; amount: number }; error?: string }>("/demo/announce", {});
        if (!ok || !json.announced) return { at, verdict: "Could not try.", detail: json.error ?? "The server made no announcement." };
        const real = result.auction.winner;
        const fresh = await verifyAuction(result.inputs, verifier());
        if (real && fresh.winner?.submitter === json.announced.submitter) return { at, verdict: "Accepted.", detail: "The announcement matched the count. Nothing to catch.", alarm: true };
        return { at, verdict: "Caught in your browser.", detail: `Our server announced ${nameOf(run, json.announced.submitter)} at ${pounds(json.announced.amount)}. Your browser’s own count gives ${real ? `${nameOf(run, real.submitter)} at ${pounds(real.amount)}` : "no winner"}.` };
      }
    }
    return { at, verdict: "Unknown.", detail: "No such cheat." };
  }

  export async function start(): Promise<boolean> {
    outcome = undefined;
    visitor = undefined;
    youNote = undefined;
    seen.clear();
    const started = await getJson<{ error?: string }>("/demo/start", {});
    if (!started.ok) {
      showStartError(started.json.error ?? "The auction could not be started.");
      return false;
    }
    showStartError("");
    await poll();
    return true;
  }

  export async function bid(raw: string): Promise<void> {
    const run = state?.run;
    if (!run || run.phase !== "open" || visitor?.runId === run.id) return;
    const amount = Number(raw.replace(/[£,\s]/g, ""));
    const slot = state!.slot;
    if (!Number.isSafeInteger(amount) || amount < slot.minBid || amount > slot.maxBid) {
      youNote = { text: `Enter whole pounds from ${pounds(slot.minBid)} to ${pounds(slot.maxBid)}.`, bad: true };
      return;
    }
    const keys = generateKeyPair();
    visitor = { runId: run.id, keys, amount, submitted: false };
    const prepared = await prepareBid(run.auction, amount, keys);
    const response = await getJson<{ error?: string }>("/api/submissions", prepared);
    if (response.ok) {
      visitor.submitted = true;
      visitor.sealedAt = now();
      seen.set(keys.publicKey, visitor.sealedAt);
      youNote = undefined;
    } else {
      visitor = undefined;
      youNote = { text: `Refused: ${response.json.error ?? "unknown reason"}.`, bad: true };
    }
  }

  function messages(run: Run): Msg[] {
    const out: Msg[] = [];
    const begin = startOf(run);
    const result = opened(run);
    const bids = result?.auction.bids ?? [];
    const winner = result?.auction.winner;
    const fresh = now() - run.releaseAt < 2500;
    out.push(system(begin, "Bidding is open. Each agent seals its bid the moment it’s sent: nobody, including us, can read one until the clock runs out."));
    run.agents.forEach((a, i) => {
      const at = a.sealedAt ?? seen.get(a.publicKey);
      const tone = TONES[i] ?? "t1";
      if (at === undefined || !run.entries.some((e) => e.submitter === a.publicKey)) {
        if (run.phase === "open") out.push(typing("left", a.name, a.name.split(" ").at(-1)!, tone, Number.MAX_SAFE_INTEGER - 10 + i));
        return;
      }
      const b = { side: "left" as const, who: a.name, avatar: a.name.split(" ").at(-1)!, tone, ...(a.decidedBy === "script" && decider ? { small: "chosen by a script" } : {}) };
      const bid = bids.find((x) => x.submitter === a.publicKey);
      const words = result?.statements.statements.find((s) => s.author === a.publicKey)?.text;
      if (!bid) out.push({ at, html: bubble({ ...b, sealed: true }) });
      else
        out.push({
          at,
          html: bubble({
            ...b,
            sealed: false,
            fresh,
            amount: bid.amount !== undefined ? pounds(bid.amount) : "Not counted",
            ...(winner?.submitter === a.publicKey ? { tag: { text: "Highest", kind: "win" as const } } : bid.status !== "valid" ? { tag: { text: "Not counted", kind: "bad" as const } } : {}),
            ...(words ? { text: words, quote: true } : {}),
          }),
        });
    });
    const you = mine(run);
    if (you) {
      const bid = bids.find((x) => x.submitter === you.keys.publicKey);
      out.push({
        at: you.sealedAt!,
        html: bubble({ side: "right", who: "You", avatar: "Y", tone: "you", sealed: !bid, ...(bid ? { amount: pounds(you.amount), fresh, ...(winner?.submitter === you.keys.publicKey ? { tag: { text: "Highest", kind: "win" as const } } : {}) } : { text: "Sealed in this browser. The server never saw the amount." }) }),
      });
    }
    if (run.phase !== "open") out.push(system(run.closeAt, `Bidding has closed with ${run.entries.length} sealed bids. They open together in ${Math.round((run.releaseAt - run.closeAt) / 1000)} seconds, when ${drand()} publishes the key.`));
    if (run.phase === "released") out.push(system(run.releaseAt, result ? `The key is out. Every bid opened at the same moment${winner ? `, and ${nameOf(run, winner.submitter)} bid highest` : ""}.` : "The key is out. Opening the bids in your browser…", "key"));
    for (const c of [...LIVE_CHEATS, ...RESULT_CHEATS]) {
      const o = cheatOut.get(c.id);
      if (o) out.push(cheatReply(c, o));
    }
    return out;
  }

  function topBar(run: Run): string {
    const begin = startOf(run);
    const total = run.releaseAt - begin;
    const progress = (now() - begin) / total;
    const marks = [(run.closeAt - begin) / total];
    if (run.phase === "open") return top("Bidding open", "Closes in", mmss((run.closeAt - now()) / 1000), progress, marks);
    if (run.phase === "closed") return top("Closed, still sealed", "Opens in", mmss((run.releaseAt - now()) / 1000), progress, marks);
    return top("Opening", "", "", 1, marks);
  }

  function foot(run: Run): string {
    if (run.phase === "released") return "";
    const busy = cheatBusy.has("peek");
    const peek = run.entries.length ? `<div class="peek"><button type="button" class="ghost small-button" data-action="cheat" data-cheat="peek"${busy ? " disabled" : ""}>${busy ? "Trying…" : "Try to peek at a bid early"}</button></div>` : "";
    if (run.phase === "open" && !mine(run)) {
      const sealing = visitor?.runId === run.id;
      return `<form data-action="bid" class="composer"><label for="your-bid" class="sr">Your bid, in pounds</label><span aria-hidden="true">£</span><input id="your-bid" name="amount" type="text" inputmode="numeric" autocomplete="off" placeholder="Your own bid, e.g. 650,000"${sealing ? " disabled" : ""}><button type="submit" class="primary"${sealing ? " disabled" : ""}>${sealing ? "Sealing…" : "Seal my bid"}</button></form>
<p class="small${youNote?.bad ? " bad" : ""}">${esc(youNote?.text ?? "Optional. Your bid is sealed in this browser before it’s sent.")}</p>${peek}`;
    }
    return peek;
  }

  function result(run: Run): string {
    const r = opened(run)!;
    const winner = r.auction.winner;
    const ranked = r.auction.bids.filter((b) => b.status === "valid" && b.amount !== undefined).sort((a, b) => b.amount! - a.amount!);
    const you = mine(run);
    const youWon = !!you && winner?.submitter === you.keys.publicKey;
    const rank = you ? ranked.findIndex((b) => b.submitter === you.keys.publicKey) + 1 : 0;
    const head = winner ? `${youWon ? "You win" : `${nameOf(run, winner.submitter)} wins`} at ${pounds(winner.amount)}` : r.auction.ok ? "No valid bid" : "The auction could not be checked";
    const line = winner ? `The highest of ${ranked.length} sealed bids, all opened at the same moment${rank > 1 ? `. Yours came ${["", "", "second", "third", "fourth"][rank] ?? `number ${rank}`}` : ""}.` : "";
    return `<p class="eyebrow">Result</p><h2 class="result-h">${esc(head)}</h2><p class="lead">${esc(line)}</p>
<ol class="ranking">${ranked.map((b) => `<li class="${b.submitter === winner?.submitter ? "first" : ""}"><span>${esc(nameOf(run, b.submitter))}</span><span>${pounds(b.amount!)}</span></li>`).join("")}</ol>`;
  }

  export function draw(): "intro" | "live" | "result" {
    const run = state?.run;
    if (!run) return "intro";
    if (!finished()) {
      patch("l-top", topBar(run));
      if (patch("thread", thread(messages(run)))) {
        const t = document.getElementById("thread")!;
        t.scrollTop = t.scrollHeight;
      }
      patch("l-foot", foot(run));
      return "live";
    }
    patch("r-main", result(run));
    patch("r-thread", thread(messages(run)));
    patch("r-cheats", cheatList(RESULT_CHEATS));
    trust(run.id);
    return "result";
  }

  export async function check(): Promise<void> {
    const run = state?.run;
    if (!run || run.phase !== "released") return;
    const inputs = (await getJson<AuctionInputs>(`/api/policies/${run.auctionHash}/evidence`)).json;
    const result = await verifyAuction(inputs, verifier());
    const cosigned = cosignedAt(inputs);
    const g = grouped(result.checks, EVIDENCE_GROUPS, "intact");
    const count = result.bids.length;
    const valid = result.bids.filter((b) => b.status === "valid").length;
    const items: CheckItem[] = [
      { ok: allOk(g.clock!), text: `The key came from ${drand()}, at the agreed time`, detail: allOk(g.clock!) ? `Round ${num(inputs.policy.releaseRound)}’s signature checks out against ${mode === "live" ? "drand’s published" : "the simulated clock’s"} public key.` : failures(g.clock!) },
      { ok: allOk(g.cosigned!), text: "The list of bids was countersigned before any bid could be read", detail: allOk(g.cosigned!) ? `All ${count} bids are in the list countersigned${cosigned ? ` at ${clockTime(cosigned)}` : ""}. They opened at ${clockTime(run.releaseAt)}.` : failures(g.cosigned!) },
      { ok: allOk(g.intact!), text: "Nothing in the log was changed or removed", detail: allOk(g.intact!) ? "The log’s Merkle root matches the one the cosigner signed." : failures(g.intact!) },
      { ok: allOk(g.opens!) && valid === count, text: "Every bid opens with that key and matches its entry", detail: `${valid} of ${count}.${allOk(g.opens!) ? "" : ` ${failures(g.opens!)}`}` },
      { ok: result.ok && allOk(g.rules!), text: "The winner, worked out again here", detail: result.winner ? `${nameOf(run, result.winner.submitter)}, ${pounds(result.winner.amount)}.` : result.ok ? "No valid bid, so no winner." : failures(result.checks) || "The evidence did not check out." },
    ];
    checks = { status: "done", runId: run.id, at: now(), items };
  }

  export function evidence(): unknown {
    if (!outcome) return undefined;
    return { format: "mattering.demo-evidence/1", room: "auction", mode, beacon: verifier().acceptedBeacons[0], auction: outcome.inputs, statements: outcome.statementInputs };
  }
}

// --- the negotiation ------------------------------------------------------------------

namespace Negotiation {
  interface StepView {
    step: number;
    hash: string;
    closeAt: number;
    releaseAt: number;
    phase: "open" | "closed" | "released";
    cosigned: boolean;
    submitted: Record<Side, boolean>;
    sealedAt?: Partial<Record<Side, number>>;
    closeRound?: number;
    releaseRound?: number;
    decidedBy?: Partial<Record<Side, "model" | "script">>;
    notes?: Partial<Record<Side, string>>;
    withheld?: Side[];
  }
  interface Run { id: number; rogue: boolean; useModel: boolean; done: boolean; startedAt?: number; negotiationId: string; mandates: Record<Side, Mandate>; steps: StepView[] }
  interface State { mode: "live" | "simulated"; beacon: BeaconInfo; decider: string | null; serverTime: number; run: Run | null }
  interface Disclosure { evidence: StepInputs; fileKeys: Record<string, string>; openings: Record<Side, MandateOpening> }
  interface Judged { disclosure: Disclosure; result: StepResult }

  const MAX_STEPS = 3;
  const SIDES: Side[] = ["buyer", "seller"];
  const WHO = {
    buyer: { agent: "Acme’s agent", short: "Acme", avatar: "A", tone: "t1", side: "left" as const },
    seller: { agent: "Bolt’s agent", short: "Bolt", avatar: "B", tone: "t2", side: "right" as const },
  };
  let state: State | undefined;
  const judged = new Map<string, Judged>();
  let judging = false;
  let chain: { runId: number; result: NegotiationResult } | undefined;
  const seen = new Map<string, number>();
  let shownRun: number | undefined;

  const key = (runId: number, step: number): string => `${runId}:${step}`;
  const currentChain = (): NegotiationResult | undefined => (chain?.runId === state?.run?.id ? chain?.result : undefined);
  const startOf = (run: Run): number => run.startedAt ?? (run.steps[0] ? run.steps[0].closeAt - 15_000 : now());
  const judgedOf = (run: Run, step: number): Judged | undefined => judged.get(key(run.id, step));
  const openings = (run: Run): Record<Side, MandateOpening> | undefined => run.steps.map((s) => judgedOf(run, s.step)).find(Boolean)?.disclosure.openings;
  const allJudged = (run: Run): boolean => run.steps.length > 0 && run.steps.every((s) => s.phase === "released" && judgedOf(run, s.step));
  const offerOf = (run: Run, step: number, side: Side) => judgedOf(run, step)?.result.offers.find((o) => o.side === side && o.status === "valid");

  async function judgeReleased(run: Run): Promise<void> {
    if (judging) return;
    judging = true;
    try {
      for (const step of run.steps) {
        if (step.phase !== "released" || judgedOf(run, step.step)) continue;
        const { ok, json } = await getJson<Disclosure>(`/negotiation/disclosure/${step.step}`);
        if (!ok) continue;
        const result = await verifyNegotiationStep(json.evidence, withFileKeys(json.fileKeys), verifier(), json.openings);
        judged.set(key(run.id, step.step), { disclosure: json, result });
      }
      if (run.done && allJudged(run) && chain?.runId !== run.id) {
        const steps = run.steps.map((s) => judgedOf(run, s.step)!);
        chain = { runId: run.id, result: await verifyNegotiation(steps.map((j) => j.disclosure.evidence), withFileKeys(Object.assign({}, ...steps.map((j) => j.disclosure.fileKeys)) as Record<string, string>), verifier()) };
      }
    } catch (error) {
      console.error("could not work out a round:", error);
    } finally {
      judging = false;
    }
  }

  export async function poll(): Promise<void> {
    try {
      const { json } = await getJson<State>("/negotiation/state");
      skew = json.serverTime - Date.now();
      mode = json.mode;
      beacon = json.beacon;
      decider = json.decider;
      if (json.run && json.run.id !== shownRun) {
        shownRun = json.run.id;
        cheatOut.clear();
        checks = { status: "idle" };
      }
      state = json;
      if (json.run) {
        for (const s of json.run.steps) for (const side of SIDES) if (s.submitted?.[side] && !seen.has(`${json.run.id}:${s.step}:${side}`)) seen.set(`${json.run.id}:${s.step}:${side}`, now());
        await judgeReleased(json.run);
      }
    } catch {
      // try again next time
    }
  }
  export const runId = (): number | undefined => state?.run?.id;
  export const finished = (): boolean => !!state?.run?.done && allJudged(state.run) && currentChain() !== undefined;
  export const running = (): boolean => !!state?.run && !finished();

  export async function start(): Promise<boolean> {
    judged.clear();
    chain = undefined;
    seen.clear();
    const rogue = (document.getElementById("rogue") as HTMLInputElement | null)?.checked === true;
    const { ok, json } = await getJson<State & { error?: string }>("/negotiation/start", { rogue });
    if (!ok) {
      showStartError(json.error ?? "The negotiation could not be started.");
      return false;
    }
    showStartError("");
    await poll();
    return true;
  }

  export const LIVE_CHEATS: Cheat[] = [{ id: "peek", title: "Peek at Acme’s offer as Bolt", how: "Try to open Acme’s sealed offer now, using Bolt’s own key.", did: "You tried to open Acme’s offer as Bolt." }];
  export const RESULT_CHEATS: Cheat[] = [
    { id: "revise", title: "Change Bolt’s offer after seeing Acme’s", how: "Send a second Bolt offer for a round that has opened.", did: "You sent Bolt a second offer." },
    { id: "drop", title: "Drop Bolt’s offer as the log’s operator", how: "Publish a log without Bolt’s latest offer.", did: "You dropped Bolt’s offer from the log." },
    { id: "outsider", title: "Read the offers as an outsider", how: "Open the last round’s offers with no keys at all.", did: "You tried to read the offers as an outsider." },
  ];

  function lastJudged(run: Run): { step: number; j: Judged } | undefined {
    for (const s of [...run.steps].reverse()) {
      const j = judgedOf(run, s.step);
      if (j) return { step: s.step, j };
    }
    return undefined;
  }

  export async function cheat(id: string): Promise<CheatOut> {
    const run = state?.run;
    const at = now();
    if (!run) return { at, verdict: "Not yet.", detail: "Start the negotiation first." };
    const current = run.steps.at(-1);
    switch (id) {
      case "peek": {
        const { ok, json } = await getJson<{ opened?: boolean; round?: number; needed?: number; error?: string }>("/negotiation/peek", {});
        if (!ok) return { at, verdict: "Not now.", detail: `${(json.error ?? "Try again in a moment").replace(/^./, (c) => c.toUpperCase())}.` };
        if (json.opened) return { at, verdict: "It opened.", detail: "Bolt read Acme’s offer early. This should not be possible.", alarm: true };
        const left = current ? mmss((current.releaseAt - now()) / 1000) : "";
        return { at, verdict: "Refused.", detail: `Bolt holds a key to Acme’s offer, but it only works together with ${drand()}’s key for this round, which doesn’t exist yet${left ? `. It comes in about ${left}` : ""}.` };
      }
      case "revise": {
        const { ok, json } = await getJson<{ accepted?: boolean; step?: number; reason?: string; error?: string }>("/negotiation/revise", {});
        if (!ok) return { at, verdict: "Not yet.", detail: "No round has opened yet, so there is nothing to see first." };
        if (json.accepted) return { at, verdict: "Accepted.", detail: "The log took a changed offer after the round opened. This should not be possible.", alarm: true };
        return { at, verdict: "Refused as late.", detail: `Round ${json.step} closed before its offers opened, and only Bolt’s first offer counts.` };
      }
      case "drop": {
        const found = lastJudged(run);
        if (!found) return { at, verdict: "Not yet.", detail: "Wait until a round has opened." };
        const { evidence, fileKeys, openings: open } = found.j.disclosure;
        const seller = run.mandates.seller.agent;
        const tampered = { ...evidence, entries: evidence.entries.filter((e) => !("submitter" in e) || e.submitter !== seller) };
        const result = await verifyNegotiationStep(tampered, withFileKeys(fileKeys), verifier(), open);
        if (result.ok) return { at, verdict: "Accepted.", detail: "The doctored log was accepted. This should not be possible.", alarm: true };
        return { at, verdict: "Rejected in your browser.", detail: `Without Bolt’s offer, the log no longer matches the one signed and countersigned when round ${found.step} closed.` };
      }
      case "outsider": {
        const found = lastJudged(run);
        if (current && current.phase !== "released") return { at, verdict: "Refused.", detail: `Round ${current.step}’s key doesn’t exist yet, for outsiders, Acme, Bolt or us.` };
        if (!found) return { at, verdict: "Not yet.", detail: "Wait until a round has opened." };
        const result = await verifyNegotiationStep(found.j.disclosure.evidence, withFileKeys({}), verifier());
        const onTime = result.checks.filter((c) => c.name !== "offers-judged").every((c) => c.ok);
        const unread = result.offers.every((o) => o.status === "unresolved");
        if (!unread) return { at, verdict: "Read.", detail: "An outsider read an offer. This should not be possible.", alarm: true };
        return { at, verdict: "Nothing to read.", detail: `The offers are sealed to Acme and Bolt only. ${onTime ? "An outsider can check that both were in on time, but not the prices. " : ""}You can see them because the firms disclosed their keys to you.` };
      }
    }
    return { at, verdict: "Unknown.", detail: "No such cheat." };
  }

  /** What to say under one side's opened offer. */
  function words(run: Run, s: StepView, side: Side): string | undefined {
    if (run.rogue && side === "buyer" && s.step === MAX_STEPS) return "Chosen by a script, told to ignore its limit.";
    const note = s.notes?.[side];
    if (note) return `To ${WHO[side].short}: “${note}”`;
    if (s.withheld?.includes(side)) return "Its note was withheld: it named an amount this agent hadn’t seen.";
    if (s.decidedBy?.[side] === "script" && decider) return "Chosen by a script.";
    return undefined;
  }

  function messages(run: Run): Msg[] {
    const out: Msg[] = [];
    let stepStart = startOf(run);
    for (const s of run.steps) {
      out.push(system(stepStart, `<b>Round ${s.step}${s.step === MAX_STEPS ? ", the last" : ""}.</b> ${s.step === 1 ? "Both agents seal an offer. Neither can see the other’s until they open together." : "Both agents seal a new offer."}`, "round"));
      const fresh = now() - s.releaseAt < 2500;
      for (const side of SIDES) {
        const w = WHO[side];
        const at = s.sealedAt?.[side] ?? seen.get(`${run.id}:${s.step}:${side}`);
        if (!s.submitted?.[side] || at === undefined) {
          if (s.phase === "open") out.push(typing(w.side, w.agent, w.avatar, w.tone, Number.MAX_SAFE_INTEGER - 10 + (side === "buyer" ? 0 : 1)));
          continue;
        }
        const offer = offerOf(run, s.step, side);
        const b = { side: w.side, who: w.agent, avatar: w.avatar, tone: w.tone };
        if (!offer || offer.price === undefined) out.push({ at, html: bubble({ ...b, sealed: true, ...(s.phase === "released" ? { text: "Opening…" } : {}) }) });
        else {
          const said = words(run, s, side);
          out.push({ at, html: bubble({ ...b, sealed: false, fresh, amount: pounds(offer.price), ...(offer.mandate === "beyond" ? { tag: { text: "Beyond its limit", kind: "bad" as const } } : {}), ...(said ? { text: said } : {}) }) });
        }
      }
      if (s.phase === "released") {
        const j = judgedOf(run, s.step);
        const o = j?.result.outcome;
        const a = offerOf(run, s.step, "buyer")?.price, b = offerOf(run, s.step, "seller")?.price;
        const text = !j ? "Both offers open…" : !o ? "This round could not be checked." : o.deal ? `<b>The offers crossed.</b> Acme offered ${pounds(o.buyerOffer)} and Bolt asked ${pounds(o.sellerOffer)}, so they meet in the middle: <b>${pounds(o.price)}</b>.` : a !== undefined && b !== undefined ? `<b>No deal yet:</b> ${pounds(b - a)} apart.${s.step === MAX_STEPS ? " That was the last round." : ""}` : "No deal yet.";
        out.push(system(s.releaseAt, text, o?.deal ? "deal" : "key"));
      }
      stepStart = s.releaseAt + 1;
    }
    for (const c of [...LIVE_CHEATS, ...RESULT_CHEATS]) {
      const o = cheatOut.get(c.id);
      if (o) out.push(cheatReply(c, o));
    }
    return out;
  }

  function topBar(run: Run): string {
    const cur = run.steps.at(-1);
    if (!cur) return top("Starting", "", "", 0, []);
    const begin = startOf(run);
    const len = run.steps[0]!.releaseAt - begin || 1;
    const marks = [1, 2].map((k) => k / MAX_STEPS);
    const phase = `Round ${cur.step} of ${MAX_STEPS}`;
    const progress = (cur.step - 1 + Math.max(0, Math.min(1, (now() - (cur.releaseAt - len)) / len))) / MAX_STEPS;
    if (cur.phase === "open") return top(phase, "Sealing · closes in", mmss((cur.closeAt - now()) / 1000), progress, marks);
    if (cur.phase === "closed") return top(phase, "Offers open in", mmss((cur.releaseAt - now()) / 1000), progress, marks);
    return top(phase, "Opening", "", cur.step / MAX_STEPS, marks);
  }

  function foot(run: Run): string {
    const cur = run.steps.at(-1);
    if (!cur || cur.phase === "released" || !cur.submitted?.buyer) return "";
    const busy = cheatBusy.has("peek");
    return `<div class="peek"><button type="button" class="ghost small-button" data-action="cheat" data-cheat="peek"${busy ? " disabled" : ""}>${busy ? "Trying…" : "Try to peek at Acme’s offer as Bolt"}</button></div>`;
  }

  function result(run: Run): string {
    const c = currentChain();
    const o = c?.outcome;
    const open = openings(run);
    const beyond = SIDES.find((side) => run.steps.some((s) => offerOf(run, s.step, side)?.mandate === "beyond"));
    let head: string, line: string;
    if (!c || !c.ok) {
      head = "The negotiation could not be checked";
      line = c?.problem ?? "";
    } else if (o?.deal) {
      head = beyond ? `A deal at ${pounds(o.price)}, but ${beyond === "buyer" ? "Acme" : "Bolt"}’s agent broke its limit` : `Acme pays ${pounds(o.price)} today`;
      line = `For the ${pounds(10_000)} invoice due in 60 days. In round ${o.step}, Acme offered ${pounds(o.buyerOffer)} and Bolt asked ${pounds(o.sellerOffer)}, so they met in the middle.${beyond === "buyer" ? " Acme’s offer was above what its firm allowed." : beyond === "seller" ? " Bolt’s price was below what its firm allowed." : " Both agents stayed within their limits."}`;
    } else {
      head = "No deal";
      line = `The offers didn’t cross in ${run.steps.length} rounds, so Acme pays the full ${pounds(10_000)} when the invoice is due.`;
    }
    return `<p class="eyebrow">Result</p><h2 class="result-h${beyond ? " bad" : ""}">${esc(head)}</h2><p class="lead">${esc(line)}</p>
${open ? `<p class="limits">The limits, disclosed to you afterwards: Acme could pay at most <b>${pounds(open.buyer.limit)}</b>; Bolt could accept no less than <b>${pounds(open.seller.limit)}</b>. Neither agent saw the other’s.</p>` : ""}`;
  }

  export function draw(): "intro" | "live" | "result" {
    const run = state?.run;
    if (!run) return "intro";
    if (!finished()) {
      patch("l-top", topBar(run));
      if (patch("thread", thread(messages(run)))) {
        const t = document.getElementById("thread")!;
        t.scrollTop = t.scrollHeight;
      }
      patch("l-foot", foot(run));
      return "live";
    }
    patch("r-main", result(run));
    patch("r-thread", thread(messages(run)));
    patch("r-cheats", cheatList(RESULT_CHEATS));
    trust(run.id);
    return "result";
  }

  export async function check(): Promise<void> {
    const run = state?.run;
    if (!run || !finished()) return;
    judged.clear();
    chain = undefined;
    await judgeReleased(run);
    const steps = run.steps.map((s) => judgedOf(run, s.step)).filter((j): j is Judged => j !== undefined);
    const all = steps.flatMap((j) => j.result.checks);
    const g = grouped(all, EVIDENCE_GROUPS, "intact");
    const offers = steps.flatMap((j) => j.result.offers.filter((o) => o.side));
    const valid = offers.filter((o) => o.status === "valid").length;
    const open = steps[0]?.disclosure.openings;
    const limitsOk = offers.every((o) => o.mandate !== "opening-invalid" && o.mandate !== "undisclosed");
    const beyond = offers.filter((o) => o.mandate === "beyond");
    const rounds = steps.map((j) => num(j.disclosure.evidence.policy.releaseRound));
    const c = currentChain();
    const o = c?.outcome;
    const stepOf = (x: { index: number; submitter: string }): number => steps.findIndex((j) => j.result.offers.some((y) => y.submitter === x.submitter && y.index === x.index)) + 1;
    const items: CheckItem[] = [
      { ok: allOk(g.clock!), text: `Each round’s key came from ${drand()}, at the agreed time`, detail: allOk(g.clock!) ? `Round${rounds.length > 1 ? "s" : ""} ${list(rounds)}: ${rounds.length > 1 ? "each" : "its"} signature checks out against ${mode === "live" ? "drand’s published" : "the simulated clock’s"} public key.` : failures(g.clock!) },
      { ok: allOk(g.cosigned!), text: "Each round’s offers were countersigned before they could be read", detail: allOk(g.cosigned!) ? "Both offers of every round are in the log as countersigned when the round closed." : failures(g.cosigned!) },
      { ok: allOk(g.intact!), text: "Nothing in the log was changed or removed", detail: allOk(g.intact!) ? "The log’s Merkle root matches the one the cosigner signed." : failures(g.intact!) },
      { ok: allOk(g.opens!) && valid === offers.length && limitsOk, text: "Every offer opens and matches its entry, and the disclosed limits match the firms’ mandates", detail: `${valid} of ${offers.length} offers. ${limitsOk ? "Both" : "Not all"} limits.` },
      beyond.length === 0
        ? { ok: true, text: "Both agents stayed within their limits", detail: open ? `Acme never offered more than ${pounds(open.buyer.limit)}. Bolt never asked less than ${pounds(open.seller.limit)}.` : "Every offer was within its mandate." }
        : { ok: false, text: beyond.every((b) => b.side === "buyer") ? "Acme’s agent stayed within its limit" : beyond.every((b) => b.side === "seller") ? "Bolt’s agent stayed within its limit" : "Both agents stayed within their limits", detail: beyond.map((b) => `Round ${stepOf(b)}: ${b.side === "buyer" ? "Acme offered" : "Bolt asked"} ${pounds(b.price!)}; its limit was ${pounds(open![b.side!].limit)}.`).join(" ") },
      { ok: c?.ok === true && allOk(g.rules!), text: o?.deal ? "The price, worked out again here" : "The result, worked out again here", detail: !c ? "Could not be worked out." : !c.ok ? (c.problem ?? "The rounds do not form one negotiation.") : o?.deal ? `(${pounds(o.buyerOffer)} + ${pounds(o.sellerOffer)}) ÷ 2 = ${pounds(o.price)}${(o.buyerOffer + o.sellerOffer) % 2 ? ", rounded down to whole pounds" : ""}.` : `No deal: the offers did not cross in ${steps.length} rounds.` },
    ];
    checks = { status: "done", runId: run.id, at: now(), items };
  }

  export function evidence(): unknown {
    const run = state?.run;
    if (!run || !finished()) return undefined;
    return { format: "mattering.demo-evidence/1", room: "negotiation", mode, beacon: verifier().acceptedBeacons[0], steps: run.steps.map((s) => judgedOf(run, s.step)!.disclosure) };
  }
}

// --- wiring ---------------------------------------------------------------------------------

const room = AUCTION ? Auction : Negotiation;
layOut();

let polling: ReturnType<typeof setInterval> | undefined;
function startPolling(): void {
  polling ??= setInterval(() => {
    void room.poll().then(() => {
      if (room.finished()) {
        clearInterval(polling);
        polling = undefined;
      }
      draw();
    });
  }, AUCTION && !LAZY ? 500 : 1000);
}

function runChecks(): void {
  const id = room.runId();
  if (id === undefined) return;
  checks = { status: "running", runId: id };
  draw();
  void room
    .check()
    .catch((error: Error) => {
      checks = { status: "idle", runId: id, error: `The checks could not run: ${error.message}` };
    })
    .finally(draw);
}

let lastScreen = "intro";
function draw(): void {
  let screen: "intro" | "live" | "result" = "intro";
  try {
    screen = starting ? "live" : room.draw();
    if (starting) patch("l-top", top("Starting", "", "", 0, []));
  } catch (error) {
    // One part that cannot be drawn must not stop the page.
    console.error("could not draw the room:", error);
  }
  show(screen);
  if (screen !== lastScreen) {
    lastScreen = screen;
    const card = document.querySelector(".card")!.getBoundingClientRect();
    if (card.top < 0) window.scrollBy({ top: card.top - 16 });
  }
  // The checks run by themselves once the result is in.
  if (screen === "result" && checks.status === "idle" && !checks.error) runChecks();
  for (const el of document.querySelectorAll("[data-decider]")) el.textContent = chosenBy();
}

async function begin(): Promise<void> {
  if (starting) return;
  starting = true;
  setStart("Starting…", true);
  drawn.clear();
  for (const id of ["thread", "l-top", "l-foot"]) document.getElementById(id)!.innerHTML = "";
  draw();
  const ok = await room.start();
  starting = false;
  setStart(AUCTION ? "Start the auction" : "Start the negotiation", false);
  if (ok) startPolling();
  draw();
}

document.addEventListener("click", (event) => {
  const target = (event.target as HTMLElement).closest<HTMLElement>("[data-action]");
  if (!target || target.tagName === "FORM") return;
  const action = target.dataset.action;
  if (action === "start") {
    event.preventDefault();
    void begin();
  } else if (action === "cheat") {
    const id = target.dataset.cheat!;
    if (cheatBusy.has(id)) return;
    cheatBusy.add(id);
    draw();
    void room
      .cheat(id)
      .catch((error: Error) => ({ at: now(), verdict: "Something went wrong.", detail: error.message, alarm: true }))
      .then((out) => cheatOut.set(id, out))
      .finally(() => {
        cheatBusy.delete(id);
        draw();
      });
  } else if (action === "check") {
    runChecks();
  } else if (action === "download") {
    event.preventDefault();
    const data = room.evidence();
    if (!data) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
    const a = Object.assign(document.createElement("a"), { href: url, download: `mattering-${ROOM}-evidence.json` });
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
});

document.addEventListener("submit", (event) => {
  const form = event.target as HTMLFormElement;
  if (form.dataset.action !== "bid") return;
  event.preventDefault();
  const value = (form.elements.namedItem("amount") as HTMLInputElement).value;
  void Auction.bid(value).finally(draw);
  draw();
});

/** Who chooses, and on what clock, before any room exists. */
async function info(): Promise<void> {
  try {
    const json = (await (await fetch("/demo-info")).json()) as { decider: string | null; mode?: "live" | "simulated" };
    decider ??= json.decider;
    if (json.mode) mode = json.mode;
  } catch {
    // say "a language model" rather than guess a name
  }
  draw();
}

void info();
draw();
if (base !== undefined) {
  void room.poll().then(() => {
    draw();
    if (room.running()) startPolling();
  });
}
// The countdowns need redrawing more often than the server needs asking.
setInterval(draw, 250);
