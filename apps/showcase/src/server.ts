/**
 * The Sealed Room on a laptop: a web page that runs a sealed-bid auction
 * between three agents on a real witness service and lets the visitor try to
 * cheat.
 *
 *   npm run showcase            against the real drand quicknet (needs internet)
 *   npm run showcase:offline    against a simulated beacon on this machine's clock
 *
 * One process holds the room and serves the page. The page does its own
 * sealing, opening and verifying in the browser with the same library; this
 * server's opinion of the result is never shown.
 */
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { QUICKNET, generateKeyPair, scheduleClock, timeOfRound } from "@mattering/core";
import { drandSource } from "@mattering/core/drand-http";
import { TestBeacon, WallTestClock } from "@mattering/core/testing";
import { memoryStore, readJson, send } from "@mattering/witness";
import type { Decider } from "./agents.ts";
import { DEFAULT_MODEL, claudeDecider } from "./llm.ts";
import { LocalLogHost } from "./log-host.ts";
import { Room, type RoomState } from "./room.ts";
import { NegotiationRoom, type NegotiationRoomState } from "./negotiation-room.ts";

const here = dirname(fileURLToPath(import.meta.url));
const web = join(here, "..", "web");

export interface ShowcaseOptions {
  mode: "live" | "simulated";
  port?: number;
  /** Rounds from start to close, and from close to release. */
  closeAfter?: number;
  releaseAfter?: number;
  /** Simulated mode only: milliseconds per beacon round. */
  roundMs?: number;
  /** Milliseconds between the agents' submissions. */
  agentGapMs?: number;
  /** A language model to decide the agents' bids. Without it, their scripts decide. */
  decide?: Decider;
  decideTimeoutMs?: number;
  /** Rounds from a negotiation step's start to its close, and from close to release. */
  negotiationCloseAfter?: number;
  negotiationReleaseAfter?: number;
}

/** Bundle a page's script for the browser: the auction page by default, or the negotiation page. */
export async function bundlePage(minify = false, entry = "app.ts"): Promise<string> {
  const result = await build({
    entryPoints: [join(web, entry)],
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    write: false,
    minify,
    logLevel: "silent",
    define: { global: "globalThis" },
  });
  return result.outputFiles[0]!.text;
}

export async function startShowcase(options: ShowcaseOptions): Promise<{ server: Server; url: string; stop: () => void }> {
  const simulated = options.mode === "simulated";
  const roundMs = simulated ? (options.roundMs ?? 1000) : QUICKNET.period * 1000;
  const closeAfter = options.closeAfter ?? (simulated ? 30 : 10);
  const clock = simulated ? new WallTestClock(new TestBeacon(), Date.now() - 10 * roundMs, roundMs) : undefined;

  const sourceFor = () => (clock ? clock.source() : drandSource(QUICKNET));
  // The log and a cosigner beside it, both in this process and forgotten when it stops.
  const log = await LocalLogHost.open({
    store: memoryStore(),
    source: sourceFor(),
    origin: "localhost/sealed-room-log",
    // One request per cosigner per round: 3 seconds against drand, faster on a fast simulated clock.
    minCosignIntervalMs: roundMs,
    ownCosigner: { name: "localhost/sealed-room-cosigner", secretKey: generateKeyPair().secretKey, state: {}, persist: async () => {}, clock: scheduleClock(sourceFor()) },
  });
  let saved: RoomState | undefined;
  const room = await Room.open({
    mode: options.mode,
    sourceFor,
    timeOfRound: (round) => (clock ? clock.timeOfRound(round) : timeOfRound(QUICKNET, round) * 1000),
    log,
    loadState: async () => saved,
    saveState: async (state) => void (saved = state),
    closeAfter,
    releaseAfter: options.releaseAfter ?? (simulated ? 15 : 5),
    agentGapMs: options.agentGapMs ?? Math.min(3000, (closeAfter * roundMs) / 6),
    ...(options.decide ? { decide: options.decide } : {}),
    ...(options.decideTimeoutMs ? { decideTimeoutMs: options.decideTimeoutMs } : {}),
  });
  // The Negotiation Room runs on the same log, with steps as long as the auction's phases.
  let savedNegotiation: NegotiationRoomState | undefined;
  const negotiation = await NegotiationRoom.open({
    mode: options.mode,
    sourceFor,
    timeOfRound: (round) => (clock ? clock.timeOfRound(round) : timeOfRound(QUICKNET, round) * 1000),
    log,
    loadState: async () => savedNegotiation,
    saveState: async (state) => void (savedNegotiation = state),
    closeAfter: options.negotiationCloseAfter ?? (simulated ? 12 : 5),
    releaseAfter: options.negotiationReleaseAfter ?? (simulated ? 6 : 3),
    agentGapMs: options.agentGapMs ?? Math.min(1500, ((options.negotiationCloseAfter ?? (simulated ? 12 : 5)) * roundMs) / 4),
  });

  // One piece of work at a time: a decision by a language model can take seconds.
  let working = false;
  const timer = setInterval(() => {
    if (working) return;
    working = true;
    void Promise.all([room.work().catch(() => {}), negotiation.work().catch(() => {})]).finally(() => (working = false));
  }, Math.min(500, roundMs));

  const [appJs, negotiationJs] = await Promise.all([bundlePage(), bundlePage(false, "negotiation.ts")]);
  const files: Record<string, [string, () => string]> = {
    "/": ["text/html; charset=utf-8", () => readFileSync(join(web, "index.html"), "utf8")],
    "/negotiation": ["text/html; charset=utf-8", () => readFileSync(join(web, "negotiation.html"), "utf8")],
    "/style.css": ["text/css; charset=utf-8", () => readFileSync(join(web, "style.css"), "utf8")],
    "/app.js": ["text/javascript; charset=utf-8", () => appJs],
    "/negotiation.js": ["text/javascript; charset=utf-8", () => negotiationJs],
  };

  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const file = request.method === "GET" ? files[url.pathname] : undefined;
    if (file) {
      response.writeHead(200, { "content-type": file[0], "cache-control": "no-store" });
      return response.end(file[1]());
    }
    const target = url.pathname.startsWith("/negotiation/") ? negotiation : room;
    void target.handle(request.method ?? "GET", url.pathname, url.searchParams, () => readJson(request)).then((reply) => send(response, reply.status, reply.body));
  });

  await new Promise<void>((resolve) => server.listen(options.port ?? 0, "127.0.0.1", resolve));
  return {
    server,
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    stop: () => {
      clearInterval(timer);
      server.close();
    },
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const mode = process.argv.includes("offline") ? "simulated" : "live";
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const model = process.env.MATTERING_MODEL ?? DEFAULT_MODEL;
  const { url } = await startShowcase({
    mode,
    port: Number(process.env.PORT ?? 8790),
    ...(apiKey ? { decide: claudeDecider({ apiKey, model }) } : {}),
  });
  console.log(apiKey ? `Agents: bids decided by ${model}, with a script as fallback.` : "Agents: scripted. Set ANTHROPIC_API_KEY to have a language model decide their bids.");
  console.log(`The Sealed Room is at ${url}`);
  console.log(`The Negotiation Room is at ${url}/negotiation`);
  console.log(mode === "live" ? "Clock: the real drand quicknet beacon." : "Clock: SIMULATED on this machine, for showing offline. The cryptography is the same; the clock is not independent.");
  console.log("Demonstration only. Not security reviewed.");
}
