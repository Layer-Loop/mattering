/**
 * The two demo rooms' page, the Sealed Room (an auction) and the Negotiation
 * Room. The page says which room it is (`<html data-room>`); everything live
 * is drawn here from what the room's server reports and from evidence checked
 * in this browser with the same library the tests use. The server is asked
 * for evidence, never for a verdict.
 *
 * Laid out after the Claude Design "Mattering demo rooms" designs: a dark band
 * with the clock, a chart of sealed tracks and the cheats, then the checks.
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
const short = (hex: string): string => `${hex.slice(0, 4)} ${hex.slice(4, 8)}…`;
const r2 = (n: number): number => Math.round(n * 100) / 100;
const ordinal = (n: number): string => ["first", "second", "third", "fourth", "fifth"][n - 1] ?? `number ${n}`;
const list = (items: string[]): string => (items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`);

// --- what every room shares ---------------------------------------------------------

let mode: "live" | "simulated" = "live";
/** The model that chooses, by name; null when scripts do; undefined until known. */
let decider: string | null | undefined;
let beacon: BeaconInfo = QUICKNET;
let skew = 0;
const now = (): number => Date.now() + skew;
const narrow = (): boolean => window.matchMedia("(max-width: 720px)").matches;

/** The clock this browser accepts. In live mode it is compiled into the page, not taken from the server. */
function verifier(): { acceptedBeacons: BeaconInfo[] } {
  return { acceptedBeacons: [mode === "live" ? QUICKNET : beacon] };
}

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

/** The clock's name in a sentence: drand, or the simulated clock when offline. */
const drand = (): string => (mode === "live" ? "drand" : "the simulated clock");
const Drand = (): string => (mode === "live" ? "drand" : "The simulated clock");

/** The drand round now, and seconds to the next, when the clock is drand's. */
function drandLine(): string {
  if (mode !== "live") return "simulated clock on the server";
  const t = now() / 1000;
  const round = Math.floor((t - QUICKNET.genesisTime) / QUICKNET.period) + 1;
  const next = QUICKNET.genesisTime + round * QUICKNET.period - t;
  return `drand quicknet round ${num(round)} · next in ${Math.max(1, Math.ceil(next))} s`;
}

interface CheatOut {
  at: number;
  verdict: string;
  detail: string;
  alarm?: boolean;
}
const cheatOut = new Map<string, CheatOut>();
const cheatBusy = new Set<string>();
interface CheckItem {
  ok: boolean;
  text: string;
  detail: string;
}
let checks: { status: "idle" | "running" | "done"; at?: number; items?: CheckItem[]; error?: string } = { status: "idle" };

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

// --- chart model ----------------------------------------------------------------------

interface Dot { cx: number; r: number; bg: string; border: string; label: string; fs: number; fw: number; color: string }
interface Row {
  name: string;
  chooser: string;
  aria: string;
  bars: { x: number; w: number }[];
  marks: number[];
  caps: number[];
  stamps: { x: number; label: string }[];
  refs: { x: number; label: string; color: string }[];
  trail?: { x: number; w: number };
  dots: Dot[];
  sealed?: { text: string; top: number; quiet?: boolean };
}
interface Chart {
  kicker: string;
  headline: string;
  dek: string;
  limitKey: boolean;
  labelW: number;
  valueW: number;
  mergeW: number;
  valueGap: number;
  rows: Row[];
  ticks: { x: number; label: string; shift: string }[];
  events: { x: number; label: string; shift: string; dashed?: boolean; color: string }[];
  hatches: { x: number; w: number }[];
  now?: { x: number; label: string };
  valueTitle: string;
  vTicks: { x: number; label: string; shift: string }[];
  vRefs: { x: number; label: string }[];
  merges: { x: number; y: number; stroke: string; w: number; dash?: string }[];
  end?: string;
  result: { done: false; eyebrow: string; title: string; body: string } | { done: true; eyebrow: string; amount: string; title: string; body: string; accent: string; list?: string[] };
  table?: { r: string; a: string; b: string; o: string; aColor: string; bColor: string; oColor: string }[];
  notesTitle?: string;
  notes: { who: string; html: string }[];
  chooserLine?: string;
  source: string;
}

function frame(rows: number): Pick<Chart, "labelW" | "valueW" | "mergeW" | "valueGap"> & { plotH: number } {
  const n = narrow();
  return { labelW: n ? 66 : 168, valueW: n ? 100 : 250, mergeW: n ? 0 : 56, valueGap: n ? 10 : 20, plotH: 56 * rows };
}
function dot(cx: number, r: number, bg: string, border: string, label: string, o: { fs?: number; fw?: number; color?: string; hide?: boolean } = {}): Dot {
  return { cx, r, bg, border, label: o.hide ? "" : label, fs: o.fs ?? 11, fw: o.fw ?? 400, color: o.color ?? "var(--ink)" };
}
function timeTicks(dom: number): Chart["ticks"] {
  const step = dom <= 60 ? 10 : 25;
  const ticks: Chart["ticks"] = [];
  for (let s = 0; s < dom - 2; s += step) ticks.push({ x: r2((s / dom) * 100), label: `${s} s`, shift: s === 0 ? "0" : "-50%" });
  return ticks;
}

function drawChart(c: Chart): string {
  const plotH = 56 * c.rows.length;
  const wrapW = c.valueW + c.mergeW;
  const mid = plotH / 2;
  const paths = c.merges.map((s) => {
    const d = `M${s.x} ${s.y} C ${s.x + (wrapW - s.x) * 0.55} ${s.y}, ${wrapW - (wrapW - s.x) * 0.3} ${mid}, ${wrapW} ${mid}`;
    return `<path d="${d}" stroke="${s.stroke}" stroke-width="${s.w}" stroke-dasharray="${s.dash ?? "none"}"></path>`;
  });
  const showSub = !narrow();
  const labels = c.rows.map((r) => `<div class="row" aria-label="${esc(r.aria)}"><b>${esc(r.name)}</b>${showSub ? `<span>chosen by ${esc(r.chooser)}</span>` : ""}</div>`).join("");
  const lanes = c.rows.map((r) => `<div class="lane">${r.bars.map((b) => `<i class="bar" style="left:${b.x}%;width:${b.w}%"></i>`).join("")}${r.marks.map((x) => `<i class="mark" style="left:${x}%"></i>`).join("")}${r.caps.map((x) => `<i class="cap" style="left:${x}%"></i>`).join("")}${r.stamps.map((s) => `<span class="stamp" style="left:${s.x}%">${s.label}</span>`).join("")}</div>`).join("");
  const valueLanes = c.rows.map((r) => `<div class="lane">${r.refs.map((f) => `<i class="limit" style="left:${f.x}px;border-color:${f.color}"></i><span class="limit-label" style="left:${f.x}px;color:${f.color}">${esc(f.label)}</span>`).join("")}${r.trail ? `<i class="trail" style="left:${r.trail.x}px;width:${r.trail.w}px"></i>` : ""}${r.dots.map((o) => `<i class="dot" style="top:${30 - o.r}px;left:${o.cx - o.r}px;width:${o.r * 2}px;height:${o.r * 2}px;background:${o.bg};border-color:${o.border}"></i>${o.label ? `<span class="dot-label" style="left:${o.cx}px;font-size:${o.fs}px;font-weight:${o.fw};color:${o.color}">${esc(o.label)}</span>` : ""}`).join("")}${r.sealed ? `<span class="sealed-text${r.sealed.quiet ? " quiet" : ""}" style="top:${r.sealed.top}px">${esc(r.sealed.text)}</span>` : ""}</div>`).join("");
  const res = c.result;
  const result = res.done
    ? `<div class="done" role="status"><p class="eyebrow" style="color:${res.accent}">${esc(res.eyebrow)}</p><p class="r-amount" style="color:${res.accent}">${esc(res.amount)}</p><p class="r-title">${esc(res.title)}</p><p class="r-body">${esc(res.body)}</p>${res.list ? `<ul>${res.list.map((l) => `<li>${esc(l)}</li>`).join("")}</ul>` : ""}</div>`
    : `<div><p class="eyebrow">${esc(res.eyebrow)}</p><p class="r-title">${esc(res.title)}</p><p class="r-body">${esc(res.body)}</p></div>`;
  const n = narrow();
  const table = c.table?.length
    ? `<div class="round-table" role="table" aria-label="Offers by round"><div role="row"><span role="columnheader">Round</span><span role="columnheader">Acme</span><span role="columnheader">Bolt</span></div>${c.table.map((t) => `<div role="row"><span role="rowheader"><b>${t.r}</b></span><span role="cell" class="num" style="color:${t.aColor}">${t.a}</span><span role="cell" class="num" style="color:${t.bColor}">${t.b}</span><span role="cell" class="out" style="color:${t.oColor}">${t.o}</span></div>`).join("")}</div>`
    : "";
  return `<figure class="tracks" aria-labelledby="tracks-h">
<figcaption><p class="eyebrow">${esc(c.kicker)}</p><h2 id="tracks-h">${esc(c.headline)}</h2><p class="dek">${esc(c.dek)}</p></figcaption>
<ul class="key-list" aria-label="Key"><li><i class="k-sent"></i>${AUCTION ? "Bid sent" : "Offer sent"}</li><li><i class="k-sealed"></i>Sealed: nobody can read it yet</li><li><i class="k-wait"></i>Waiting for the clock</li><li><i class="k-open"></i>Opened</li>${c.limitKey ? "<li><i class=\"k-limit\"></i>Firm’s limit: disclosed to you; the other agent can’t see it</li>" : ""}</ul>
<div class="chart-row">
<div class="chart">
<div class="labels" style="width:${c.labelW}px"><div style="height:52px"></div>${labels}</div>
<div class="plot" aria-hidden="true">
<div class="axis"><span class="title">${n ? "Seconds" : "Seconds from start"}</span>${c.now ? `<span class="now" style="left:${c.now.x}%">${c.now.label}</span>` : ""}${c.events.map((e) => `<span class="event" style="left:${e.x}%;transform:${e.shift};color:${e.color}">${e.label}</span>`).join("")}${c.ticks.map((k) => `<span class="tick" style="left:${k.x}%;transform:translateX(${k.shift})">${k.label}</span>`).join("")}</div>
<div class="area" style="height:${plotH}px">${c.hatches.map((h) => `<i class="hatch" style="left:${h.x}%;width:${h.w}%"></i>`).join("")}${c.ticks.map((k) => `<i class="gridline" style="left:${k.x}%"></i>`).join("")}${c.events.map((e) => `<i class="eventline${e.dashed ? " dashed" : ""}" style="left:${e.x}%;border-color:${e.color}"></i>`).join("")}${lanes}${c.now ? `<i class="nowline" style="left:${c.now.x}%"></i>` : ""}</div>
</div>
${c.valueW > 0 ? `<div class="values" aria-hidden="true" style="width:${wrapW}px;margin-left:${c.valueGap}px">
<div class="axis" style="width:${c.valueW}px"><span class="title">${esc(c.valueTitle)}</span>${c.vRefs.map((v) => `<span class="event" style="left:${v.x}px;transform:translateX(-50%)">${esc(v.label)}</span>`).join("")}${c.vTicks.map((k) => `<span class="tick" style="left:${k.x}px;transform:translateX(${k.shift})">${k.label}</span>`).join("")}</div>
<div class="area" style="height:${plotH}px;width:${c.valueW}px">${c.vTicks.map((k) => `<i class="gridline" style="left:${k.x}px"></i>`).join("")}${c.vRefs.map((v) => `<i class="refline" style="left:${v.x}px"></i>`).join("")}${valueLanes}</div>
<svg width="${wrapW}" height="${plotH}" viewBox="0 0 ${wrapW} ${Math.max(1, plotH)}" fill="none" stroke-linecap="round">${paths.join("")}${c.end ? `<circle cx="${wrapW}" cy="${mid}" r="4" fill="${c.end}"></circle>` : ""}</svg>
</div>` : ""}
</div>
<div class="result" style="${n ? "" : `min-height:${52 + plotH}px;padding-top:52px;padding-left:8px`}">${result}</div>
</div>
${table}
<div class="tracks-foot">
${c.notes.length ? `<div><h3>${esc(c.notesTitle ?? "")}</h3><ul>${c.notes.map((x) => `<li><strong>${esc(x.who)}:</strong> ${x.html}</li>`).join("")}</ul></div>` : ""}
${c.chooserLine && n ? `<p class="chooser-line">${esc(c.chooserLine)}</p>` : ""}
<p class="source">${esc(c.source)}</p>
</div>
</figure>`;
}

// --- shared pieces of the band ----------------------------------------------------------

interface ClockModel {
  label: string;
  time: string;
  sub: string;
  idle?: boolean;
  opened?: boolean;
  roundLabel?: string;
  announce: string;
}
function drawClockTop(k: ClockModel): string {
  return `<div class="clock-top">
<div><p class="label">${esc(k.label)}</p><p class="time${k.idle ? " idle" : ""}${k.opened ? " opened" : ""}" role="timer">${esc(k.time)}</p><p class="sub">${esc(k.sub)}</p></div>
<div class="side"><div class="pills">${k.roundLabel ? `<span class="pill">${esc(k.roundLabel)}</span>` : ""}${mode === "simulated" ? '<span class="pill outline">Simulated clock · offline</span>' : ""}</div><p class="drand">${esc(k.idle ? (mode === "live" ? "drand quicknet · 3 s rounds" : "simulated clock on the server") : drandLine())}</p></div>
</div>
<p class="sr" aria-live="polite">${esc(k.announce)}</p>`;
}
function drawLog(entries: { at: number; text: string; ref: string }[]): string {
  const sorted = [...entries].sort((a, b) => b.at - a.at);
  return `<div class="log-head"><h3 id="log-h">Public log, latest first</h3><span>${sorted.length > 4 ? "scroll for older" : ""}</span></div>
<div class="log-list" tabindex="0" aria-labelledby="log-h">${sorted.length ? `<ol>${sorted.map((l) => `<li><span>${clockTime(l.at)}</span><span>${esc(l.text)}</span><span>${esc(l.ref)}</span></li>`).join("")}</ol>` : "<p>Entries appear here as they are logged.</p>"}</div>`;
}
function drawCheats(intro: string, cheats: { id: string; title: string; how: string }[], started: boolean): string {
  return `<section class="cheats" aria-labelledby="cheat-row-h"><div class="cheats-head"><h2 id="cheat-row-h">Try to cheat</h2><p>${esc(intro)}</p></div><ul>${cheats
    .map((c) => {
      const out = cheatOut.get(c.id);
      const busy = cheatBusy.has(c.id);
      if (out) {
        return `<li class="cheat"><div class="cheat-out${out.alarm ? " alarm" : ""}" role="status"><h3>${esc(c.title)}</h3><p><strong>${esc(out.verdict)}</strong> ${esc(out.detail)}</p><div class="foot"><span>${clockTime(out.at)}</span><button type="button" class="link-button" data-action="cheat" data-cheat="${c.id}"${busy ? " disabled" : ""}>${busy ? "Trying…" : "Try again"}</button></div></div></li>`;
      }
      return `<li class="cheat"><div><h3>${esc(c.title)}</h3><p class="how">${esc(c.how)}</p></div><button type="button" class="ghost" data-action="cheat" data-cheat="${c.id}"${started && !busy ? "" : " disabled"}>${!started ? "Available after start" : busy ? "Trying…" : "Try it"}</button></li>`;
    })
    .join("")}</ul></section>`;
}
function drawChecks(ready: boolean, note: string): string {
  const done = checks.status === "done" && checks.items;
  const passed = done ? checks.items!.filter((i) => i.ok).length : 0;
  const total = done ? checks.items!.length : 0;
  const summary = done ? `You ran ${total} checks in this browser at ${clockTime(checks.at!)}. ${passed === total ? `All ${total} passed.` : `${passed} passed, ${total - passed} failed.`}` : "";
  return `<section class="checks" aria-labelledby="check-h">
<div><h2 id="check-h">Don’t trust this page</h2><p class="lead">Check it yourself. The checks run in your browser, against ${mode === "live" ? "drand’s" : "the simulated clock’s"} public key and the entries in the log, using code you can read.</p></div>
<div class="actions"><button type="button" class="primary" data-action="check"${ready && checks.status !== "running" ? "" : " disabled"}>${checks.status === "running" ? "Checking…" : done ? "Run the checks again" : "Check it yourself"}</button><a href="https://github.com/Layer-Loop/mattering/blob/main/apps/showcase/web/rooms/rooms.ts">Read the code that runs</a></div>
${!done ? `<p class="note">${esc(checks.error ?? note)}</p>` : ""}
${done ? `<div><p class="summary" role="status">${summary}</p><ol>${checks.items!.map((i) => `<li class="${i.ok ? "" : "failed"}"><span class="glyph" aria-hidden="true">${i.ok ? "✓" : "✗"}</span><div><p><span class="word">${i.ok ? "Passed" : "Failed"}:</span> ${esc(i.text)}</p><p>${esc(i.detail)}</p></div><span>${clockTime(checks.at!)}</span></li>`).join("")}</ol></div>
<p><a href="#" data-action="download">Download the evidence and check it offline</a></p>` : ""}
</section>`;
}

/** Replace an element's content only when it changed, so focus, scroll and open details survive redraws. */
const drawn = new Map<string, string>();
function patch(id: string, html: string): void {
  if (drawn.get(id) === html) return;
  const el = document.getElementById(id);
  if (!el) return;
  drawn.set(id, html);
  el.innerHTML = html;
}

/** The band's fixed parts, laid out once. */
function layOutBand(parts: string[]): void {
  const band = document.getElementById("band")!;
  band.innerHTML = `<div class="band-head" id="b-head"></div><section class="clock" aria-label="Clock"><div id="b-clock"></div><div class="log" id="b-log"></div></section>${parts.map((p) => `<div id="${p}"></div>`).join("")}`;
}
function drawHead(state: "ready" | "running" | "finished", status: string): void {
  patch("b-head", `<div><span class="state-word ${state}"><i aria-hidden="true"></i>${state === "ready" ? "Ready" : state === "running" ? "Running" : "Finished"}</span><span class="status">${esc(status)}</span></div><div><span class="clock-name">${mode === "live" ? "Clock: drand quicknet · 3 s rounds" : "Clock: simulated on the server"}</span></div>`);
}
function setStart(label: string, disabled: boolean, hint?: string): void {
  const button = document.getElementById("start") as HTMLButtonElement;
  button.textContent = label;
  button.disabled = disabled;
  if (hint !== undefined) document.getElementById("start-hint")!.textContent = hint;
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

  const NAMES = ["Fernhill Coffee", "Kestrel Mobile", "Orla Travel"];
  let state: State | undefined;
  let visitor: { runId: number; keys: KeyPair; amount: number; sealedAt?: number; logIndex?: number; submitted: boolean; note?: string; bad?: boolean } | undefined;
  let outcome: { runId: number; auction: AuctionResult; statements: StatementsResult; inputs: AuctionInputs; statementInputs: StatementInputs; cosignedAt?: number } | undefined;
  let resolving = false;
  /** When this page first saw each bid, for bids a room did not time. */
  const seen = new Map<string, number>();
  let shownRun: number | undefined;

  const startOf = (run: Run): number => run.startedAt ?? run.closeAt - 30_000;
  const releaseRound = (run: Run): number => run.releaseRound ?? run.auction.releaseRound;
  const nameOf = (run: Run, key: string): string => (visitor?.runId === run.id && visitor.keys.publicKey === key ? "You" : run.agents.find((a) => a.publicKey === key)?.name ?? "An unknown bidder");
  const shortName = (name: string): string => name.split(" ")[0]!;

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
  export const finished = (): boolean => state?.run?.phase === "released" && outcome?.runId === state.run.id;
  export const running = (): boolean => state?.run !== null && state?.run !== undefined && !finished();

  function stage(run: Run | null | undefined): 0 | 1 | 2 | 3 {
    if (!run) return 0;
    if (run.phase === "open") return 1;
    if (run.phase === "closed") return 2;
    return 3;
  }

  const CHEATS = [
    { id: "peek", title: "Peek at a bid early", how: "Ask for the key to Kestrel’s envelope now." },
    { id: "late", title: "Slip in a late bid", how: "Send a £700,000 bid after bidding closes." },
    { id: "rewrite", title: "Rewrite the list as the auctioneer", how: "As the operator, add a winning bid of our own from before the close." },
    { id: "announce", title: "Announce a different winner", how: "Have our server announce a losing bidder as the winner." },
  ];

  export async function cheat(id: string): Promise<CheatOut> {
    const run = state?.run;
    if (!run) return { at: now(), verdict: "Not yet.", detail: "Start the auction first." };
    const at = now();
    switch (id) {
      case "peek": {
        if (run.phase === "released") return { at, verdict: "Nothing to peek at.", detail: "The bids are open now. Start again and try while they are sealed." };
        const kestrel = run.agents.find((a) => a.name.startsWith("Kestrel"));
        const entry = run.entries.find((e) => e.submitter === kestrel?.publicKey) ?? run.entries[0];
        if (!entry) return { at, verdict: "Not yet.", detail: "No bid has been sealed yet. Try again in a few seconds." };
        const envelope = (await getJson<Envelope>(`/api/envelopes/${entry.envelopeId}`)).json;
        const latest = (await getJson<Release>("/demo/latest")).json;
        try {
          await open(envelope, { round: envelope.round, signature: latest.signature }, verifier());
          return { at, verdict: "Opened.", detail: "The bid opened early. This should not be possible.", alarm: true };
        } catch (error) {
          if (!(error instanceof MatteringError)) throw error;
          return { at, verdict: "Refused.", detail: `We tried to open ${nameOf(run, entry.submitter)}’s bid with the newest key there is, from round ${num(latest.round)}. The key for this envelope does not exist yet: ${drand()} publishes it with round ${num(releaseRound(run))}, in about ${mmss((run.releaseAt - now()) / 1000)}.` };
        }
      }
      case "late": {
        if (run.phase === "open") return { at, verdict: "Not yet.", detail: `Bidding is still open, so this bid would be on time. Try again after ${clockTime(run.closeAt)}.` };
        const bid = await prepareBid(run.auction, 700_000, generateKeyPair());
        const response = await getJson<{ error?: string }>("/api/submissions", bid);
        if (response.ok) return { at, verdict: "Accepted.", detail: "The late bid was accepted. This should not be possible.", alarm: true };
        return { at, verdict: "Refused as late.", detail: `The bid was sealed and sent, and the log turned it away. Bidding closed at ${clockTime(run.closeAt)}, and the list of ${run.entries.length} bids was signed and countersigned.` };
      }
      case "rewrite": {
        if (run.phase !== "released") return { at, verdict: "Not yet.", detail: "This cheat only pays once the bids can be read. Try again after they open." };
        const { ok, json } = await getJson<{ shillAmount: number; evidence: AuctionInputs; error?: string }>("/demo/forge", {});
        if (!ok) return { at, verdict: "Could not try.", detail: json.error ?? "The server would not forge a list." };
        const result = await verifyAuction(json.evidence, verifier());
        if (result.ok) return { at, verdict: "Accepted.", detail: "The rewritten list was accepted. This should not be possible.", alarm: true };
        const when = outcome?.runId === run.id && outcome.cosignedAt ? ` at ${clockTime(outcome.cosignedAt)}` : "";
        return { at, verdict: "Rejected in your browser.", detail: `We added a bid of ${pounds(json.shillAmount)} and signed the new list with the log’s real key. It doesn’t extend the list countersigned${when ? `${when}, ` : " "}before any bid could be read.` };
      }
      case "announce": {
        const result = outcome?.runId === run.id ? outcome : undefined;
        if (run.phase !== "released" || !result) return { at, verdict: "Not yet.", detail: "There is no result to lie about yet. Try again after the bids open." };
        const { ok, json } = await getJson<{ announced?: { submitter: string; amount: number }; error?: string }>("/demo/announce", {});
        if (!ok || !json.announced) return { at, verdict: "Could not try.", detail: json.error ?? "The server made no announcement." };
        const real = result.auction.winner;
        const fresh = await verifyAuction(result.inputs, verifier());
        if (real && fresh.winner?.submitter === json.announced.submitter) return { at, verdict: "Accepted.", detail: "The announcement matched the count. Nothing to catch.", alarm: true };
        return { at, verdict: "Caught in your browser.", detail: `Our server announced ${nameOf(run, json.announced.submitter)} at ${pounds(json.announced.amount)}. Your browser’s own count of the opened bids gives ${real ? `${nameOf(run, real.submitter)} at ${pounds(real.amount)}` : "no winner"}, so it flags the announcement as false.` };
      }
    }
    return { at, verdict: "Unknown.", detail: "No such cheat." };
  }

  export async function start(): Promise<boolean> {
    outcome = undefined;
    visitor = undefined;
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
      visitor = undefined;
      youNote = { text: `Enter whole pounds from ${pounds(slot.minBid)} to ${pounds(slot.maxBid)}.`, bad: true };
      return;
    }
    const keys = generateKeyPair();
    visitor = { runId: run.id, keys, amount, submitted: false };
    const prepared = await prepareBid(run.auction, amount, keys);
    const response = await getJson<{ error?: string; index?: number }>("/api/submissions", prepared);
    if (response.ok) {
      visitor.submitted = true;
      visitor.sealedAt = now();
      if (typeof response.json.index === "number") visitor.logIndex = response.json.index;
      seen.set(keys.publicKey, visitor.sealedAt);
      youNote = undefined;
    } else {
      visitor = undefined;
      youNote = { text: `Refused: ${response.json.error ?? "unknown reason"}.`, bad: true };
    }
  }
  let youNote: { text: string; bad?: boolean } | undefined;

  function chart(run: Run | null | undefined): Chart {
    const s = stage(run);
    const f = frame(4);
    const n = narrow();
    const model = chosenBy();
    const opened = s === 3 && outcome?.runId === run?.id ? outcome : undefined;
    const startAt = run ? startOf(run) : 0;
    const closeS = run ? (run.closeAt - startAt) / 1000 : 30;
    const openS = run ? (run.releaseAt - startAt) / 1000 : 45;
    const dom = openS + 2;
    const X = (sec: number): number => r2((Math.max(0, Math.min(dom, sec)) / dom) * 100);
    const VX = (v: number): number => Math.round(((v - 400_000) / 500_000) * f.valueW * 10) / 10;
    const nowS = run ? (now() - startAt) / 1000 : 0;
    const merges: Chart["merges"] = [];
    const people: { who: string; key?: string; chooser: string; at?: number; you?: boolean }[] = (run?.agents ?? NAMES.map((name) => ({ name } as Agent))).map((a) => ({
      who: a.name,
      ...(a.publicKey ? { key: a.publicKey } : {}),
      chooser: a.decidedBy === "script" ? "a script" : model,
      ...(a.publicKey && (a.sealedAt ?? seen.get(a.publicKey)) !== undefined && run?.entries.some((e) => e.submitter === a.publicKey) ? { at: ((a.sealedAt ?? seen.get(a.publicKey))! - startAt) / 1000 } : {}),
    }));
    const mine = visitor?.runId === run?.id && visitor?.submitted ? visitor : undefined;
    people.push({ who: "You", ...(mine ? { key: mine.keys.publicKey, at: (mine.sealedAt! - startAt) / 1000 } : {}), chooser: "you", you: true });
    const bids = opened?.auction.bids ?? [];
    const winner = opened?.auction.winner;
    const rows: Row[] = people.map((p, i) => {
      const sent = p.at !== undefined;
      const b = bids.find((x) => x.submitter === p.key);
      const amount = b?.status === "valid" ? b.amount : undefined;
      const won = winner !== undefined && winner.submitter === p.key;
      const end = opened ? openS : nowS;
      const cy = i * 56 + 30;
      const dots: Dot[] = [];
      if (opened && amount !== undefined) {
        const cx = VX(amount);
        dots.push(won ? dot(cx, 8, "var(--teal)", "var(--surface)", pounds(amount), { fw: 700, fs: 12, color: "var(--teal-ink)", hide: n }) : dot(cx, 6, "var(--teal)", "var(--surface)", pounds(amount), { hide: n }));
        merges.push({ x: cx, y: cy, stroke: won ? "var(--teal)" : "var(--soft)", w: won ? 2.5 : 1 });
      } else if (sent && !opened) merges.push({ x: f.valueW, y: cy, stroke: "var(--line)", w: 1, dash: "3 4" });
      const stamp = sent ? `0:${String(Math.max(0, Math.round(p.at!))).padStart(2, "0")}` : "";
      return {
        name: n ? shortName(p.who) : p.who,
        chooser: p.chooser,
        aria: `${p.who}: ${sent ? (opened ? (amount !== undefined ? `${pounds(amount)}${won ? ", winner" : ""}` : "not counted") : `sealed bid sent at ${stamp}, nobody can read it yet`) : "no bid yet"}`,
        bars: sent ? [{ x: X(p.at!), w: r2(X(end) - X(p.at!)) }] : [],
        marks: sent ? [X(p.at!)] : [],
        caps: opened && sent ? [X(openS)] : [],
        stamps: sent && !n ? [{ x: X(p.at!), label: stamp }] : [],
        refs: [],
        dots,
        ...(s >= 1 && !opened ? { sealed: { text: sent ? (n ? "sealed" : "Sealed, amount unknown") : p.you ? "Not bid yet" : "No bid yet", top: 21, quiet: !sent } } : {}),
        ...(opened && sent && amount === undefined ? { sealed: { text: "Not counted", top: 21, quiet: true } } : {}),
      };
    });
    const total = people.filter((p) => p.at !== undefined).length;
    const ranked = bids.filter((b) => b.status === "valid" && b.amount !== undefined).sort((a, b) => b.amount! - a.amount!);
    const yourRank = mine ? ranked.findIndex((b) => b.submitter === mine.keys.publicKey) + 1 : 0;
    const youWon = mine !== undefined && winner?.submitter === mine.keys.publicKey;
    const yours = mine && yourRank > 1 ? ` Your ${pounds(mine.amount)} came ${ordinal(yourRank)}.` : "";
    const winName = winner && run ? nameOf(run, winner.submitter) : "";
    const left = run ? (run.closeAt - now()) / 1000 : 0;
    const toOpen = run ? (run.releaseAt - now()) / 1000 : 0;
    const headline: [string, string] =
      s === 0 ? ["No bids yet", "Press Start. Each bid will appear as a sealed bar from the moment it is sent, and all of them open together at the end."]
      : s === 1 ? [total === 0 ? "Bidding is open. No bid is in yet" : `${total === 1 ? "One bid is" : `${total} bids are`} in, and none of them can be read`, `Each bar is a sealed bid, drawn from the moment it was sent. They open together when ${drand()} publishes round ${num(releaseRound(run!))}.`]
      : s === 2 ? [`Bidding has closed. ${total} bids wait for the clock`, `Nobody, including us, has the key yet. It comes with ${drand()} round ${num(releaseRound(run!))} at about ${clockTime(run!.releaseAt)}.`]
      : opened ? [winner ? `${winName} ${youWon ? "win" : "wins"} at ${pounds(winner.amount)}` : opened.auction.ok ? "No valid bid" : "The auction could not be checked", winner ? `All ${total} bids opened at ${clockTime(run!.releaseAt)}.${yours}` : `The bids opened at ${clockTime(run!.releaseAt)}.`]
      : ["The bids are opening", "Fetching the evidence and counting the bids in this browser."];
    const result: Chart["result"] = opened && winner
      ? { done: true, eyebrow: "Winner, counted in this browser", amount: pounds(winner.amount), title: youWon ? "You, with the highest bid" : winName, body: youWon ? "Your bid beat all three agents." : `The highest bid.${yours}`, accent: "var(--teal)", ...(n ? { list: ranked.map((b) => `${shortName(nameOf(run!, b.submitter)).padEnd(9)}${pounds(b.amount!)}${b.submitter === winner.submitter ? "  winner" : ""}`) } : {}) }
      : { done: false, eyebrow: "Result", title: s === 0 ? "Not started" : `Opens at ${clockTime(run!.releaseAt)}`, body: "When the bids open, each one lands on the scale and your browser counts them here." };
    const notes = opened ? opened.statements.statements.filter((x) => x.text).map((x) => ({ who: nameOf(run!, x.author), html: `<q>${esc(x.text!)}</q>` })) : [];
    return {
      ...f,
      kicker: "The Sealed Room · spring prime-time package",
      headline: headline[0],
      dek: headline[1],
      limitKey: false,
      rows,
      ticks: timeTicks(dom),
      events: [
        { x: X(closeS), label: n ? "Close" : "Bids close", shift: "translateX(calc(-100% - 4px))", dashed: true, color: "var(--ink)" },
        { x: X(openS), label: "Open", shift: "translateX(-50%)", color: "var(--teal)" },
      ],
      hatches: [{ x: X(closeS), w: r2(X(openS) - X(closeS)) }],
      ...(s === 1 || s === 2 ? { now: { x: X(nowS), label: s === 1 ? (n ? mmss(left) : `now · ${mmss(left)} left`) : n ? mmss(toOpen) : `now · opens in ${mmss(toOpen)}` } } : {}),
      valueTitle: n ? "Bid" : "Bid, once opened",
      vTicks: [400, 600, 800].map((v, i) => ({ x: VX(v * 1000), label: `£${v}k`, shift: i === 0 ? "0" : "-50%" })),
      vRefs: [{ x: VX(800_000), label: "Ceiling" }],
      merges: n ? [] : merges,
      ...(opened && winner && !n ? { end: "var(--teal)" } : {}),
      result,
      ...(notes.length ? { notesTitle: "Agents’ notes, shown after opening" } : {}),
      notes,
      chooserLine: `The agents’ bids are chosen by ${model}. Yours is chosen by you.`,
      source: `Source: Mattering public log (this auction’s ${total} bids) and ${mode === "live" ? "drand quicknet" : "the simulated clock’s"} round ${run ? num(releaseRound(run)) : "…"}. Time in seconds from the start${run ? ` at ${clockTime(startAt)}` : ""}. The companies and amounts are invented.`,
    };
  }

  function clock(run: Run | null | undefined): ClockModel {
    const s = stage(run);
    if (s === 0 || !run) return { label: "Runs for about", time: "0:45", sub: "Starts when you press Start.", idle: true, announce: "" };
    const count = run.entries.length;
    if (s === 1) return { label: "Bidding closes in", time: mmss((run.closeAt - now()) / 1000), sub: `at ${clockTime(run.closeAt)}, then sealed until ${drand()} round ${num(releaseRound(run))}`, announce: `Bidding open. ${count} bids sealed.` };
    if (s === 2) return { label: "Bids open in", time: mmss((run.releaseAt - now()) / 1000), sub: `when ${drand()} publishes round ${num(releaseRound(run))}, about ${clockTime(run.releaseAt)}`, announce: "Bidding closed. All bids still sealed." };
    return { label: `All ${count} bids`, time: "Opened", sub: `at ${clockTime(run.releaseAt)}, when ${drand()} round ${num(releaseRound(run))} published the key.${finished() ? " Auction finished." : ""}`, opened: true, announce: finished() ? "Auction finished." : "Opened." };
  }

  function logEntries(run: Run | null | undefined): { at: number; text: string; ref: string }[] {
    if (!run) return [];
    const out: { at: number; text: string; ref: string }[] = [];
    for (const a of run.agents) {
      const at = a.sealedAt ?? seen.get(a.publicKey);
      if (at !== undefined && run.entries.some((e) => e.submitter === a.publicKey)) out.push({ at, text: `${shortName(a.name)}’s bid sealed and logged`, ref: a.logIndex !== undefined ? `#${num(a.logIndex)}` : "" });
    }
    if (visitor?.runId === run.id && visitor.submitted) out.push({ at: visitor.sealedAt!, text: "Your bid sealed in this browser and logged", ref: visitor.logIndex !== undefined ? `#${num(visitor.logIndex)}` : "" });
    if (run.phase !== "open") out.push({ at: run.closeAt, text: run.cosigned ? "Bidding closed. The list was signed and countersigned" : "Bidding closed. Waiting for the countersignature", ref: `${run.entries.length} bids` });
    if (run.phase === "released") out.push({ at: run.releaseAt, text: `${Drand()} round ${num(releaseRound(run))} published. All bids opened`, ref: "" });
    return out;
  }

  function you(run: Run | null | undefined): string {
    if (!run || run.phase === "released") return "";
    const mine = visitor?.runId === run.id ? visitor : undefined;
    if (mine?.submitted) {
      return `<div class="you" aria-label="Your bid: sealed"><div><h3>Your bid</h3><p class="what">Sealed in this browser at ${clockTime(mine.sealedAt!)}</p></div><div class="sealed"><p>Sealed. Nobody can read it yet, including us.</p></div><p class="chooser">chosen by <strong>you</strong></p></div>`;
    }
    if (run.phase !== "open") return "";
    const disabled = mine !== undefined;
    return `<div class="you"><div><h3>Your bid</h3><p class="what">Add a fourth track. Optional.</p></div>
<form data-action="bid"><label for="your-bid">Your bid, in pounds</label><div class="fields"><div class="money"><span aria-hidden="true">£</span><input id="your-bid" name="amount" type="text" inputmode="numeric" autocomplete="off" placeholder="e.g. 650,000"${disabled ? " disabled" : ""}></div><button type="submit"${disabled ? " disabled" : ""}>${disabled ? "Sealing…" : "Seal and submit"}</button></div>
<p class="note${youNote?.bad ? " bad" : ""}">${esc(youNote?.text ?? "It is sealed in your browser before it is sent. Nobody, including us, can see the amount until it opens.")}</p></form>
<p class="chooser">chosen by <strong>you</strong></p></div>`;
  }

  export function lay(): void {
    layOutBand(["b-tracks", "b-cheats", "b-you"]);
  }

  export function draw(): void {
    const run = state?.run;
    const s = stage(run);
    const done = finished();
    drawHead(s === 0 ? "ready" : done ? "finished" : "running", s === 0 ? "Waiting for you to press Start" : done ? `Finished · ${clockTime(startOf(run!))} to ${clockTime(run!.releaseAt)}` : `Running · started ${clockTime(startOf(run!))}`);
    const model = chosenBy();
    if (s === 0) setStart("Start the auction", false, `About 45 seconds. Bids are chosen by ${model}.`);
    else if (done) setStart("Start again", false, `Finished · ${clockTime(startOf(run!))} to ${clockTime(run!.releaseAt)}`);
    else setStart("Running…", true, `Running · started ${clockTime(startOf(run!))}`);
    patch("b-clock", drawClockTop(clock(run)));
    patch("b-log", drawLog(logEntries(run)));
    patch("b-tracks", drawChart(chart(run)));
    patch("b-cheats", drawCheats("Each button sends a real request to this running auction. What comes back is shown as it came.", CHEATS, s > 0));
    patch("b-you", you(run));
    patch("checks", drawChecks(s === 3 && outcome?.runId === run?.id, s === 0 ? "Available once you press Start." : "The checks run once the bids open."));
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
    const ok = (cs: Check[]): boolean => cs.length > 0 && cs.every((c) => c.ok);
    const items: CheckItem[] = [
      { ok: ok(g.clock!), text: `${mode === "live" ? "drand" : "The simulated clock’s"} round ${num(inputs.policy.releaseRound)} is genuine`, detail: ok(g.clock!) ? `Its signature checks out against ${mode === "live" ? "drand’s published" : "the simulated clock’s"} public key.` : failures(g.clock!) },
      { ok: ok(g.cosigned!), text: "The log was countersigned before any bid could be read", detail: ok(g.cosigned!) ? `All ${count} bids are in the list countersigned${cosigned ? ` at ${clockTime(cosigned)}` : ""}. They opened at ${clockTime(run.releaseAt)}.` : failures(g.cosigned!) },
      { ok: ok(g.intact!), text: "Nothing in the log was changed or removed", detail: ok(g.intact!) ? "The log’s Merkle root matches the one the cosigner signed." : failures(g.intact!) },
      { ok: ok(g.opens!) && valid === count, text: "Each bid opens with that round’s key and matches its entry", detail: `${valid} of ${count}.${ok(g.opens!) ? "" : ` ${failures(g.opens!)}`}` },
      { ok: result.ok && ok(g.rules!), text: "Winner worked out again here", detail: result.winner ? `${nameOf(run, result.winner.submitter)}, ${pounds(result.winner.amount)}.` : result.ok ? "No valid bid, so no winner." : failures(result.checks) || "The evidence did not check out." },
    ];
    checks = { status: "done", at: now(), items };
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
    logIndex?: Partial<Record<Side, number>>;
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
  const WHO = { buyer: { agent: "Acme’s treasury agent", short: "Acme", legal: "Acme Treasury Ltd", role: "Pays the invoice early, if the price is right" }, seller: { agent: "Bolt’s sales agent", short: "Bolt", legal: "Bolt Ltd", role: "Is paid early, at a discount" } } as const;
  let state: State | undefined;
  const judged = new Map<string, Judged>();
  let judging = false;
  let chain: { runId: number; result: NegotiationResult } | undefined;
  const seen = new Map<string, number>();
  let shownRun: number | undefined;

  const key = (runId: number, step: number): string => `${runId}:${step}`;
  const currentChain = (): NegotiationResult | undefined => (chain?.runId === state?.run?.id ? chain?.result : undefined);
  const startOf = (run: Run): number => run.startedAt ?? run.steps[0]!.closeAt - 15_000;
  const judgedOf = (run: Run, step: number): Judged | undefined => judged.get(key(run.id, step));
  const openings = (run: Run): Record<Side, MandateOpening> | undefined => run.steps.map((s) => judgedOf(run, s.step)).find(Boolean)?.disclosure.openings;
  const allJudged = (run: Run): boolean => run.steps.every((s) => s.phase === "released" && judgedOf(run, s.step));

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
      console.error("could not work out a step:", error);
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
  export const finished = (): boolean => !!state?.run?.done && allJudged(state.run);
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

  const CHEATS = [
    { id: "peek", title: "Peek at Acme’s offer as Bolt", how: "Try to open Acme’s current offer now, using Bolt’s own key." },
    { id: "revise", title: "Change Bolt’s offer after seeing Acme’s", how: "Send a second Bolt offer for a round that has opened." },
    { id: "drop", title: "Drop Bolt’s offer as the log’s operator", how: "Publish a log without Bolt’s latest offer." },
    { id: "outsider", title: "Read the offers as an outsider", how: "Open the latest round’s offers with no keys at all." },
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
        if (json.opened) return { at, verdict: "Opened.", detail: "Bolt read Acme’s offer early. This should not be possible.", alarm: true };
        const left = current ? mmss((current.releaseAt - now()) / 1000) : "";
        return { at, verdict: "Refused.", detail: `Bolt holds a key for Acme’s offer, but it only works with ${drand()} round ${num(json.needed!)}’s signature. The newest is round ${num(json.round!)}${left ? `; the one needed comes in about ${left}` : ""}.` };
      }
      case "revise": {
        const { ok, json } = await getJson<{ accepted?: boolean; step?: number; reason?: string; error?: string }>("/negotiation/revise", {});
        if (!ok) return { at, verdict: "Not yet.", detail: "Acme’s first offer is still sealed, so there is nothing to see first. Try again once a round has opened." };
        if (json.accepted) return { at, verdict: "Accepted.", detail: "The log took a changed offer after the round opened. This should not be possible.", alarm: true };
        return { at, verdict: "Refused as late.", detail: `Round ${json.step} closed before its offers opened, and only Bolt’s first offer for a round counts.` };
      }
      case "drop": {
        const found = lastJudged(run);
        if (!found) return { at, verdict: "Not yet.", detail: "Wait until a round has opened." };
        const { evidence, fileKeys, openings: open } = found.j.disclosure;
        const seller = run.mandates.seller.agent;
        const tampered = { ...evidence, entries: evidence.entries.filter((e) => !("submitter" in e) || e.submitter !== seller) };
        const result = await verifyNegotiationStep(tampered, withFileKeys(fileKeys), verifier(), open);
        if (result.ok) return { at, verdict: "Accepted.", detail: "The doctored log was accepted. This should not be possible.", alarm: true };
        return { at, verdict: "Rejected in your browser.", detail: `Without Bolt’s offer, the log no longer matches the one signed and countersigned at the close of round ${found.step}.` };
      }
      case "outsider": {
        const found = lastJudged(run);
        if (current && current.phase !== "released") return { at, verdict: "Refused.", detail: `Round ${current.step}’s key does not exist yet, for outsiders, Acme, Bolt or us. Everyone waits for ${drand()} round ${num(current.releaseRound ?? 0)}.` };
        if (!found) return { at, verdict: "Not yet.", detail: "Wait until a round has opened." };
        const result = await verifyNegotiationStep(found.j.disclosure.evidence, withFileKeys({}), verifier());
        const onTime = result.checks.filter((c) => c.name !== "offers-judged").every((c) => c.ok);
        const unread = result.offers.every((o) => o.status === "unresolved");
        if (!unread) return { at, verdict: "Read.", detail: "An outsider read an offer. This should not be possible.", alarm: true };
        return { at, verdict: "Nothing to read.", detail: `Round ${found.step} is open, but the offers are sealed to Acme and Bolt only. ${onTime ? "An outsider can check that both were in on time and countersigned, but not the prices. " : ""}You can see them because the firms disclosed their keys to you.` };
      }
    }
    return { at, verdict: "Unknown.", detail: "No such cheat." };
  }

  /** Each step's times, real for the steps that exist and estimated for those that may follow. */
  function timeline(run: Run): { step: number; closeAt: number; releaseAt: number; estimated: boolean }[] {
    const out = run.steps.map((s) => ({ step: s.step, closeAt: s.closeAt, releaseAt: s.releaseAt, estimated: false }));
    if (run.done) return out;
    const first = run.steps[0]!;
    const begin = startOf(run);
    const closeLen = first.closeAt - begin;
    const len = first.releaseAt - begin;
    while (out.length < MAX_STEPS) {
      const from = out.at(-1)!.releaseAt + 1500;
      out.push({ step: out.length + 1, closeAt: from + closeLen, releaseAt: from + len, estimated: true });
    }
    return out;
  }

  function outcomeOf(run: Run, step: number): StepResult["outcome"] | undefined {
    return judgedOf(run, step)?.result.outcome;
  }
  function offerOf(run: Run, step: number, side: Side): { price?: number; mandate?: string } | undefined {
    return judgedOf(run, step)?.result.offers.find((o) => o.side === side && o.status === "valid");
  }
  /** What to say for one side's note on an opened round. */
  function noteHtml(run: Run, s: StepView, side: Side): string {
    if (run.rogue && side === "buyer" && s.step === MAX_STEPS) return "<em>Chosen by a script, told to ignore its limit.</em>";
    const note = s.notes?.[side];
    if (note) return `<q>${esc(note)}</q>`;
    if (s.withheld?.includes(side)) return "<em>Note withheld: it named an amount this agent had not seen.</em>";
    if (s.decidedBy?.[side] === "script") return "<em>Chosen by a script.</em>";
    return "<em>No note.</em>";
  }

  function chart(run: Run | null | undefined): Chart {
    const f = frame(2);
    const n = narrow();
    if (n) Object.assign(f, { valueW: 0, mergeW: 0, valueGap: 0 });
    const model = run ? (run.useModel ? chosenBy() : "a script") : chosenBy();
    const begin = run ? startOf(run) : 0;
    const times = run ? timeline(run) : [0, 1, 2].map((i) => ({ step: i + 1, closeAt: 18_000 + i * 25_000, releaseAt: 24_000 + i * 25_000, estimated: true }));
    const dom = (times.at(-1)!.releaseAt - begin) / 1000 + 2;
    const X = (sec: number): number => r2((Math.max(0, Math.min(dom, sec)) / dom) * 100);
    const S = (ms: number): number => (ms - begin) / 1000;
    const steps = run?.steps ?? [];
    const opened = steps.filter((s) => s.phase === "released" && run && judgedOf(run, s.step)).length;
    const disclosed = run ? openings(run) : undefined;
    const prices = steps.flatMap((s) => SIDES.map((side) => (run ? offerOf(run, s.step, side)?.price : undefined))).filter((p): p is number => p !== undefined);
    const lo = Math.min(9_400, Math.floor((Math.min(...prices, ...(disclosed ? SIDES.map((x) => disclosed[x].limit) : [])) - 50) / 100) * 100);
    const VX = (v: number): number => Math.round(((v - lo) / (10_000 - lo)) * f.valueW * 10) / 10;
    const nowS = S(now());
    const merges: Chart["merges"] = [];
    const deal = run ? steps.map((s) => outcomeOf(run, s.step)).find((o) => o?.deal) : undefined;
    const beyondSide = run ? SIDES.find((side) => steps.some((s) => offerOf(run, s.step, side)?.mandate === "beyond")) : undefined;
    const pending = steps.length > opened && !(run?.done && allJudged(run));
    const rows: Row[] = SIDES.map((side, i) => {
      const bars: Row["bars"] = [], marks: number[] = [], caps: number[] = [], dots: Dot[] = [];
      for (const s of steps) {
        const sealed = s.sealedAt?.[side] ?? (run ? seen.get(`${run.id}:${s.step}:${side}`) : undefined);
        if (!s.submitted?.[side] || sealed === undefined) continue;
        const isOpen = s.phase === "released";
        const end = isOpen ? S(s.releaseAt) : nowS;
        bars.push({ x: X(S(sealed)), w: r2(X(end) - X(S(sealed))) });
        marks.push(X(S(sealed)));
        if (isOpen) caps.push(X(S(s.releaseAt)));
      }
      const cy = i * 56 + 30;
      if (!n && run) {
        steps.forEach((s, r) => {
          const offer = offerOf(run, s.step, side);
          if (offer?.price === undefined) return;
          const cx = VX(offer.price);
          const last = r === opened - 1;
          const beyond = offer.mandate === "beyond";
          const isDeal = outcomeOf(run, s.step)?.deal === true;
          const bg = beyond ? "var(--red)" : isDeal ? "var(--teal)" : last ? "var(--ink)" : "var(--surface)";
          const border = beyond || isDeal || last ? "var(--surface)" : "var(--soft)";
          dots.push(dot(cx, isDeal ? 7 : 5, bg, border, `${s.step}: ${num(offer.price)}`, { fs: 10, fw: last ? 700 : 400, color: beyond ? "var(--red)" : isDeal ? "var(--teal-ink)" : last ? "var(--ink)" : "var(--soft)" }));
          if (isDeal) merges.push({ x: cx, y: cy, stroke: beyond ? "var(--red)" : "var(--teal)", w: 2.5 });
        });
      }
      // Label the latest offer always, earlier ones only where their labels have room.
      const labelled: number[] = [];
      for (const o of [...dots].reverse()) {
        if (labelled.some((x) => Math.abs(x - o.cx) < 56)) o.label = "";
        else labelled.push(o.cx);
      }
      const xs = dots.map((o) => o.cx);
      if (pending && !n) merges.push({ x: f.valueW, y: cy, stroke: "var(--line)", w: 1, dash: "3 4" });
      const offersSeen = run ? steps.map((s) => offerOf(run, s.step, side)?.price).filter((p): p is number => p !== undefined) : [];
      const sealedText = pending ? `Round ${steps.length} offer sealed` : disclosed ? undefined : "Limit hidden";
      return {
        name: n ? WHO[side].short : WHO[side].agent,
        chooser: model,
        aria: `${WHO[side].agent}: ${offersSeen.length ? `offers ${offersSeen.map(num).join(", ")}` : "no offer opened yet"}${disclosed ? `; limit disclosed to you, ${num(disclosed[side].limit)}` : "; limit hidden"}`,
        bars,
        marks,
        caps,
        stamps: [],
        refs: disclosed && !n ? [{ x: VX(disclosed[side].limit), label: `limit £${num(disclosed[side].limit)}`, color: beyondSide === side ? "var(--red)" : "var(--ink)" }] : [],
        ...(xs.length > 1 ? { trail: { x: Math.min(...xs), w: Math.max(...xs) - Math.min(...xs) } } : {}),
        dots,
        ...(!n && run && sealedText ? { sealed: { text: sealedText, top: pending && opened === 0 ? 21 : 42 } } : {}),
      };
    });

    const table: NonNullable<Chart["table"]> = [];
    if (n && run) {
      for (const s of steps) {
        const o = outcomeOf(run, s.step);
        const a = offerOf(run, s.step, "buyer"), b = offerOf(run, s.step, "seller");
        const isOpen = !!judgedOf(run, s.step);
        const beyond = a?.mandate === "beyond";
        table.push({
          r: `Round ${s.step}`,
          a: isOpen && a?.price !== undefined ? `£${num(a.price)}${beyond ? " BEYOND" : ""}` : "sealed",
          b: isOpen && b?.price !== undefined ? `£${num(b.price)}` : "sealed",
          o: !isOpen ? `opens ${clockTime(s.releaseAt)}` : o?.deal ? `Crossed: deal at ${pounds(o.price)}` : a?.price !== undefined && b?.price !== undefined ? `${pounds(b.price - a.price)} apart` : "No deal",
          aColor: beyond ? "var(--red)" : isOpen ? "var(--ink)" : "var(--amber-ink)",
          bColor: isOpen ? "var(--ink)" : "var(--amber-ink)",
          oColor: o?.deal ? (beyond ? "var(--red)" : "var(--teal-ink)") : "var(--soft)",
        });
      }
    }

    const cur = steps.at(-1);
    const lastOpen = [...steps].reverse().find((s) => run && judgedOf(run, s.step));
    const lastA = run && lastOpen ? offerOf(run, lastOpen.step, "buyer")?.price : undefined;
    const lastB = run && lastOpen ? offerOf(run, lastOpen.step, "seller")?.price : undefined;
    const firstA = run && steps[0] ? offerOf(run, steps[0].step, "buyer")?.price : undefined;
    const firstB = run && steps[0] ? offerOf(run, steps[0].step, "seller")?.price : undefined;
    const done = run?.done && allJudged(run);
    let headline: [string, string];
    if (!run || !cur) headline = ["No offers yet", "Each round, both firms seal an offer. The two open together; if they cross, the price is the midpoint."];
    else if (done && deal?.deal) {
      headline = beyondSide === "buyer"
        ? [`A deal at ${pounds(deal.price)}, but Acme broke its limit`, `Acme’s last offer, ${pounds(deal.buyerOffer)}, was above the ${pounds(disclosed!.buyer.limit)} its firm allowed.`]
        : beyondSide === "seller"
          ? [`A deal at ${pounds(deal.price)}, but Bolt broke its limit`, `Bolt’s last price, ${pounds(deal.sellerOffer)}, was below the ${pounds(disclosed!.seller.limit)} its firm allowed.`]
          : [`The offers crossed in round ${lastOpen!.step}: Acme pays ${pounds(deal.price)}`, steps.length > 1 && firstA !== undefined && firstB !== undefined ? `Acme rose from ${pounds(firstA)} to ${pounds(deal.buyerOffer)} and Bolt fell from ${pounds(firstB)} to ${pounds(deal.sellerOffer)}. The price is the midpoint.` : `Acme offered ${pounds(deal.buyerOffer)} and Bolt asked ${pounds(deal.sellerOffer)}. The price is the midpoint.`];
    } else if (done) headline = [`No deal after ${steps.length} rounds`, lastA !== undefined && lastB !== undefined ? `The last offers were ${pounds(lastA)} and ${pounds(lastB)}, ${pounds(lastB - lastA)} apart. Acme pays the full invoice when it is due.` : "The offers never crossed."];
    else if (cur.phase === "released") headline = [`Round ${cur.step} is opening`, "Fetching what the firms disclosed and working the round out in this browser."];
    else if (lastOpen && lastA !== undefined && lastB !== undefined) headline = [`${pounds(lastB - lastA)} apart after round ${lastOpen.step}. Round ${cur.step} is sealed`, `Acme offered ${pounds(lastA)} and Bolt ${pounds(lastB)}. Round ${cur.step}’s offers open at ${clockTime(cur.releaseAt)}.`];
    else headline = [`Round ${cur.step}: both offers are sealed`, `Neither firm can see the other’s number until ${drand()} round ${num(cur.releaseRound ?? 0)}, at ${clockTime(cur.releaseAt)}.`];

    const result: Chart["result"] = done && deal?.deal
      ? beyondSide
        ? { done: true, eyebrow: "Deal · limit broken", amount: pounds(deal.price), title: "Acme pays today for the £10,000 invoice", body: beyondSide === "buyer" ? `Acme’s agent offered ${pounds(deal.buyerOffer)}, beyond the ${pounds(disclosed!.buyer.limit)} its mandate allowed.` : `Bolt’s agent asked ${pounds(deal.sellerOffer)}, below the ${pounds(disclosed!.seller.limit)} its mandate allowed.`, accent: "var(--red)" }
        : { done: true, eyebrow: "Deal, worked out in this browser", amount: pounds(deal.price), title: "Acme pays today for the £10,000 invoice", body: `The middle of ${pounds(deal.buyerOffer)} and ${pounds(deal.sellerOffer)}. Both agents stayed within their limits.`, accent: "var(--teal)" }
      : done
        ? { done: true, eyebrow: "No deal, worked out in this browser", amount: "£10,000", title: "Acme pays the invoice in full when due", body: `The offers did not cross in ${steps.length} rounds.`, accent: "var(--soft)" }
        : { done: false, eyebrow: "Result", title: run ? "No deal yet" : "Not started", body: "If a round’s offers cross, the two tracks meet here at the midpoint." };

    const notes = run && lastOpen ? SIDES.map((side) => ({ who: WHO[side].short, html: noteHtml(run, lastOpen, side) })) : [];
    const rounds = run ? steps.map((s) => num(s.releaseRound ?? 0)) : [];
    return {
      ...f,
      kicker: "The Negotiation Room · £10,000 invoice due in 60 days",
      headline: headline[0],
      dek: headline[1],
      limitKey: !!disclosed && !n,
      rows,
      ticks: timeTicks(dom),
      events: times.map((t) => ({ x: X(S(t.releaseAt)), label: n ? `R${t.step}` : `R${t.step} opens`, shift: "translateX(calc(-100% - 4px))", color: run && judgedOf(run, t.step) ? "var(--teal)" : "var(--soft)" })),
      hatches: times.map((t) => ({ x: X(S(t.closeAt)), w: r2(X(S(t.releaseAt)) - X(S(t.closeAt))) })),
      ...(run && cur && cur.phase !== "released" ? { now: { x: X(nowS), label: cur.phase === "open" ? (n ? mmss((cur.closeAt - now()) / 1000) : `now · ${mmss((cur.closeAt - now()) / 1000)} left`) : n ? mmss((cur.releaseAt - now()) / 1000) : `now · opens in ${mmss((cur.releaseAt - now()) / 1000)}` } } : {}),
      valueTitle: n ? "" : "Offer by round, once opened",
      vTicks: n ? [] : [lo, lo + (10_000 - lo) / 3, lo + (2 * (10_000 - lo)) / 3, 10_000].map((v, i) => ({ x: VX(v), label: `£${num(Math.round(v / 10) * 10)}`, shift: i === 0 ? "0" : i === 3 ? "-100%" : "-50%" })),
      vRefs: [],
      merges: n ? [] : merges,
      ...(done && deal?.deal && !n ? { end: beyondSide ? "var(--red)" : "var(--teal)" } : {}),
      result,
      ...(n ? { table } : {}),
      ...(notes.length ? { notesTitle: `Agents’ notes, round ${lastOpen!.step}, shown after it opened` } : {}),
      notes,
      chooserLine: `Both agents’ offers are chosen by ${model}.`,
      source: `Source: Mattering public log (this negotiation’s ${steps.reduce((a, s) => a + SIDES.filter((x) => s.submitted?.[x]).length, 0)} offers)${rounds.length ? ` and ${mode === "live" ? "drand quicknet" : "simulated clock"} round${rounds.length > 1 ? "s" : ""} ${list(rounds)}` : ""}. Time in seconds from the start${run ? ` at ${clockTime(begin)}` : ""}. Offer scale starts at ${pounds(lo)}. The firms and amounts are invented.`,
    };
  }

  function clock(run: Run | null | undefined): ClockModel {
    const cur = run?.steps.at(-1);
    if (!run || !cur) return { label: "Takes up to", time: "1:15", sub: "Three rounds of about 25 seconds. Starts when you press Start.", idle: true, announce: "" };
    const roundLabel = finished() ? "Finished" : `Round ${cur.step} of ${MAX_STEPS}`;
    if (cur.phase === "open") return { roundLabel, label: `Round ${cur.step} closes in`, time: mmss((cur.closeAt - now()) / 1000), sub: `at ${clockTime(cur.closeAt)}, then sealed until ${drand()} round ${num(cur.releaseRound ?? 0)}`, announce: `Round ${cur.step}. Offers being sealed.` };
    if (cur.phase === "closed") return { roundLabel, label: `Round ${cur.step} opens in`, time: mmss((cur.releaseAt - now()) / 1000), sub: `when ${drand()} publishes round ${num(cur.releaseRound ?? 0)}, about ${clockTime(cur.releaseAt)}`, announce: `Round ${cur.step} closed. Both offers still sealed.` };
    const o = outcomeOf(run, cur.step);
    return { roundLabel, label: `Round ${cur.step}`, time: "Opened", sub: `at ${clockTime(cur.releaseAt)}, when ${drand()} round ${num(cur.releaseRound ?? 0)} published the key. Both offers opened together.`, opened: true, announce: finished() ? "Negotiation finished." : o?.deal ? `Round ${cur.step} opened. Deal at ${pounds(o.price)}.` : `Round ${cur.step} opened.` };
  }

  function logEntries(run: Run | null | undefined): { at: number; text: string; ref: string }[] {
    if (!run) return [];
    const out: { at: number; text: string; ref: string }[] = [];
    for (const s of run.steps) {
      for (const side of SIDES) {
        const at = s.sealedAt?.[side] ?? seen.get(`${run.id}:${s.step}:${side}`);
        if (s.submitted?.[side] && at !== undefined) out.push({ at, text: `${WHO[side].short}’s round-${s.step} offer sealed and logged`, ref: s.logIndex?.[side] !== undefined ? `#${num(s.logIndex[side]!)}` : "" });
      }
      if (s.phase !== "open") out.push({ at: s.closeAt, text: `Round ${s.step} closed. Log signed${s.cosigned ? " and countersigned" : ""}`, ref: "" });
      const o = outcomeOf(run, s.step);
      if (s.phase === "released") out.push({ at: s.releaseAt, text: `Round ${s.step} opened.${o ? (o.deal ? " Deal" : " No deal") : ""}`, ref: "" });
    }
    return out;
  }

  function parties(run: Run | null | undefined): string {
    const disclosed = run ? openings(run) : undefined;
    const model = run ? (run.useModel ? chosenBy() : "a script") : chosenBy();
    return `<section class="parties" aria-labelledby="parties-h"><h2 id="parties-h">The two agents and their mandates</h2><div class="grid">${SIDES.map((side) => {
      const other = side === "buyer" ? "Bolt’s" : "Acme’s";
      const mandate = run?.mandates[side];
      const limit = disclosed?.[side].limit;
      return `<article class="party"><div><h3>${WHO[side].agent}</h3><p class="role">${WHO[side].role}. Offers chosen by ${esc(model)}.</p></div>
<p><strong>Mandate is public: signed by ${WHO[side].legal}’s key</strong> <span class="key">${mandate ? short(mandate.organisation) : "made when you press Start"}</span></p>
<div class="mandate${limit !== undefined ? " disclosed" : ""}"><span>${side === "buyer" ? "May pay at most" : "May accept no less than"}</span><span>${limit !== undefined ? pounds(limit) : "Hidden"}</span></div>
<p class="note">${limit !== undefined ? `Disclosed to you; ${other} agent can’t see it.` : "Committed, not shown. The commitment fixes it, so it can’t change later."}</p></article>`;
    }).join("")}</div></section>`;
  }

  export function lay(): void {
    layOutBand(["b-parties", "b-tracks", "b-cheats"]);
  }

  export function draw(): void {
    const run = state?.run;
    const done = finished();
    const begin = run && run.steps.length ? startOf(run) : undefined;
    const end = run?.steps.at(-1)?.releaseAt;
    const status = !run ? "Waiting for you to press Start" : done ? `Finished · ${clockTime(begin!)} to ${clockTime(end!)}` : begin ? `Running · started ${clockTime(begin)}` : "Starting…";
    drawHead(!run ? "ready" : done ? "finished" : "running", status);
    const model = chosenBy();
    const rogue = document.getElementById("rogue") as HTMLInputElement | null;
    if (!run) setStart("Start the negotiation", false, `Up to 75 seconds. Offers are chosen by ${model}.`);
    else if (done) setStart("Start again", false, status);
    else setStart("Running…", true, status);
    if (rogue) rogue.disabled = !!run && !done;
    patch("b-clock", drawClockTop(clock(run)));
    patch("b-log", drawLog(logEntries(run)));
    patch("b-parties", parties(run));
    patch("b-tracks", drawChart(chart(run)));
    patch("b-cheats", drawCheats("Each button sends a real request to this running negotiation. What comes back is shown as it came.", CHEATS, !!run));
    patch("checks", drawChecks(done && chain?.runId === run?.id, !run ? "Available once you press Start." : "The checks run once the negotiation finishes."));
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
    const ok = (cs: Check[]): boolean => cs.length > 0 && cs.every((c) => c.ok);
    const offers = steps.flatMap((j) => j.result.offers.filter((o) => o.side));
    const valid = offers.filter((o) => o.status === "valid").length;
    const open = steps[0]?.disclosure.openings;
    const limitsOk = offers.every((o) => o.mandate !== "opening-invalid" && o.mandate !== "undisclosed");
    const beyond = offers.filter((o) => o.mandate === "beyond");
    const rounds = steps.map((j) => num(j.disclosure.evidence.policy.releaseRound));
    // Seconds from each round's countersignature to its opening.
    const gaps = steps.map((j, i) => {
      const at = cosignedAt(j.disclosure.evidence);
      const opensAt = run.steps[i]?.releaseAt;
      return at === undefined || opensAt === undefined ? undefined : Math.round((opensAt - at) / 1000);
    });
    // judgeReleased has just set it afresh.
    const c = currentChain();
    const o = c?.outcome;
    const stepOf = (o: { index: number; submitter: string }): number => steps.findIndex((j) => j.result.offers.some((x) => x.submitter === o.submitter && x.index === o.index)) + 1;
    const items: CheckItem[] = [
      { ok: ok(g.clock!), text: `${mode === "live" ? "drand" : "Simulated clock"} round${rounds.length > 1 ? "s" : ""} ${list(rounds)} ${rounds.length > 1 ? "are" : "is"} genuine`, detail: ok(g.clock!) ? `${rounds.length > 1 ? "Each" : "Its"} signature checks out against ${mode === "live" ? "drand’s published" : "the simulated clock’s"} public key.` : failures(g.clock!) },
      { ok: ok(g.cosigned!), text: "The log was countersigned before any offer could be read", detail: ok(g.cosigned!) ? `Each round’s 2 offers are in the log countersigned at that round’s close${gaps.every((x) => x !== undefined) ? `, about ${Math.min(...(gaps as number[]))} seconds before they opened` : ", before they opened"}.` : failures(g.cosigned!) },
      { ok: ok(g.intact!), text: "Nothing in the log was changed or removed", detail: ok(g.intact!) ? "The log’s Merkle root matches the one the cosigner signed." : failures(g.intact!) },
      { ok: ok(g.opens!) && valid === offers.length && limitsOk, text: "Every offer opens and matches its entry, and both firms’ disclosed limits match their mandates", detail: `${valid} of ${offers.length} offers. ${limitsOk ? "2 of 2" : "Not all"} limits.` },
      beyond.length === 0
        ? { ok: true, text: "Both agents stayed within their limits", detail: open ? `Acme never offered more than ${pounds(open.buyer.limit)}. Bolt never asked less than ${pounds(open.seller.limit)}.` : "Every offer was within its mandate." }
        : { ok: false, text: beyond.every((b) => b.side === "buyer") ? "Acme’s agent stayed within its limit" : beyond.every((b) => b.side === "seller") ? "Bolt’s agent stayed within its limit" : "Both agents stayed within their limits", detail: beyond.map((b) => `Round ${stepOf(b)}: ${b.side === "buyer" ? "Acme offered" : "Bolt asked"} ${pounds(b.price!)}. Its limit was ${pounds(open![b.side!].limit)}.`).join(" ") },
      { ok: c?.ok === true && ok(g.rules!), text: o?.deal ? "Deal price worked out again here" : "Result worked out again here", detail: !c ? "Could not be worked out." : !c.ok ? (c.problem ?? "The rounds do not form one negotiation.") : o?.deal ? `(${pounds(o.buyerOffer)} + ${pounds(o.sellerOffer)}) ÷ 2 = ${pounds(o.price)}${(o.buyerOffer + o.sellerOffer) % 2 ? ", rounded down to whole pounds" : ""}.` : `No deal: the offers did not cross in ${steps.length} rounds.` },
    ];
    checks = { status: "done", at: now(), items };
  }

  export function evidence(): unknown {
    const run = state?.run;
    if (!run || !finished()) return undefined;
    return { format: "mattering.demo-evidence/1", room: "negotiation", mode, beacon: verifier().acceptedBeacons[0], steps: run.steps.map((s) => judgedOf(run, s.step)!.disclosure) };
  }
}

// --- wiring ---------------------------------------------------------------------------------

const room = AUCTION ? Auction : Negotiation;
room.lay();

let polling: ReturnType<typeof setInterval> | undefined;
function startPolling(): void {
  polling ??= setInterval(() => {
    void room.poll().then(() => {
      if (room.finished()) {
        clearInterval(polling);
        polling = undefined;
      }
      room.draw();
    });
  }, AUCTION && !LAZY ? 500 : 1000);
}

function draw(): void {
  try {
    room.draw();
  } catch (error) {
    // One part that cannot be drawn must not stop the page.
    console.error("could not draw the room:", error);
  }
  for (const el of document.querySelectorAll("[data-decider]")) el.textContent = chosenBy();
}

document.addEventListener("click", (event) => {
  const target = (event.target as HTMLElement).closest<HTMLElement>("[data-action]");
  if (!target || target.tagName === "FORM") return;
  const action = target.dataset.action;
  if (action === "start") {
    event.preventDefault();
    setStart("Starting…", true);
    void room.start().then((ok) => {
      if (ok) startPolling();
      draw();
    });
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
    checks = { status: "running" };
    draw();
    void room
      .check()
      .catch((error: Error) => {
        checks = { status: "idle", error: `The checks could not run: ${error.message}` };
      })
      .finally(draw);
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

window.matchMedia("(max-width: 720px)").addEventListener("change", draw);

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
