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
import { memoryStore, readJson, readText, send } from "@mattering/witness";
import type { Decider } from "./agents.ts";
import { DEFAULT_MODEL, claudeDecider, claudeNegotiator, modelLabel, type OfferDecider } from "./llm.ts";
import { LocalLogHost } from "./log-host.ts";
import { Room, type RoomState } from "./room.ts";
import { NegotiationRoom, type NegotiationRoomState } from "./negotiation-room.ts";
import { handleMcpHttp, type TableDirectory } from "./mcp.ts";
import { chooserPage, roomPage, type PageOptions } from "./pages.ts";
import { Table, type TableState } from "./table.ts";

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
  /** A language model to choose the negotiating agents' offers. Without it, their scripts do. */
  negotiate?: OfferDecider;
  /** What the page calls that model. */
  negotiateLabel?: string;
  /** Rounds from a negotiation step's start to its close, and from close to release. */
  negotiationCloseAfter?: number;
  negotiationReleaseAfter?: number;
  /** Tests only: shortens the negotiation tables' round windows by this factor. */
  tableTimeScale?: number;
}

/** Bundle a page's script for the browser: the rooms' page by default, or another entry under web/. */
export async function bundlePage(minify = false, entry = "rooms/rooms.ts"): Promise<string> {
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
    ...(options.negotiate ? { decide: options.negotiate, decideLabel: options.negotiateLabel ?? "a language model" } : {}),
    ...(options.decideTimeoutMs ? { decideTimeoutMs: options.decideTimeoutMs } : {}),
  });

  // Negotiation tables for MCP clients, in memory, each on the same shared log.
  let baseUrl = "";
  const tables = new Map<string, Table>();
  const tableDirectory: TableDirectory = {
    async call(id, method, path, body) {
      let table = tables.get(id);
      if (!table) {
        if (path !== "/create") return { status: 404, body: { error: "no such table" } };
        let saved: TableState | undefined;
        table = await Table.open({
          mode: options.mode,
          sourceFor,
          timeOfRound: (round) => (clock ? clock.timeOfRound(round) : timeOfRound(QUICKNET, round) * 1000),
          log,
          loadState: async () => saved,
          saveState: async (state) => void (saved = state),
          roundMs,
          releaseAfter: simulated ? 6 : 3,
          timeScale: options.tableTimeScale ?? 1,
        });
        tables.set(id, table);
      }
      return table.handle(method, path, async () => body);
    },
    watchUrl: (tableId) => `${baseUrl}/demo/table?id=${tableId}`,
  };

  // One piece of work at a time: a decision by a language model can take seconds.
  let working = false;
  const timer = setInterval(() => {
    if (working) return;
    working = true;
    void Promise.all([room.work().catch(() => {}), negotiation.work().catch(() => {}), ...[...tables.values()].map((t) => t.work().catch(() => {}))]).finally(() => (working = false));
  }, Math.min(500, roundMs));

  const roomsJs = await bundlePage();
  // The demo pages, as the website has them: the way in, and a page per room.
  const pages: PageOptions = { script: "/rooms.js", stylesheet: "/rooms.css", site: "https://mattering.ai", paths: { demos: "/demo", auction: "/demo/auction", negotiation: "/demo/negotiation" } };
  const html = "text/html; charset=utf-8";
  // Who chooses the agents' moves, and on what clock, said before any room has run.
  const decider = options.negotiateLabel ?? (options.decide || options.negotiate ? "a language model" : null);
  const files: Record<string, [string, () => string]> = {
    "/demo": [html, () => chooserPage(pages)],
    "/demo/auction": [html, () => roomPage("auction", pages)],
    "/demo/negotiation": [html, () => roomPage("negotiation", pages)],
    "/rooms.css": ["text/css; charset=utf-8", () => readFileSync(join(web, "rooms", "rooms.css"), "utf8")],
    "/rooms.js": ["text/javascript; charset=utf-8", () => roomsJs],
    "/demo-info": ["application/json", () => JSON.stringify({ decider, mode: options.mode })],
  };

  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    // The pages' old addresses lead to the new ones.
    const moved = request.method === "GET" ? ({ "/": "/demo/auction", "/negotiation": "/demo/negotiation" } as Record<string, string>)[url.pathname] : undefined;
    if (moved) {
      response.writeHead(302, { location: moved });
      return response.end();
    }
    const file = request.method === "GET" ? files[url.pathname] : undefined;
    if (file) {
      response.writeHead(200, { "content-type": file[0], "cache-control": "no-store" });
      return response.end(file[1]());
    }
    // MCP clients, and pages on this machine only: guard against other sites calling through the browser.
    if (url.pathname === "/mcp") {
      const headers = { get: (name: string) => (request.headers[name.toLowerCase()] as string | undefined) ?? null };
      void handleMcpHttp(request.method ?? "GET", headers, () => readText(request), tableDirectory, (origin) => /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)).then((reply) => {
        response.writeHead(reply.status, reply.headers);
        response.end(reply.body);
      });
      return;
    }
    // Watching a table: its page, and the read-only routes the page polls.
    if (url.pathname === "/demo/table" && request.method === "GET") {
      response.writeHead(200, { "content-type": html, "cache-control": "no-store" });
      return response.end(roomPage("negotiation", { ...pages, roomBase: "/table/{table}", watch: true }));
    }
    const tableRoute = /^\/table\/([0-9a-f]{24})(\/negotiation\/.*)$/.exec(url.pathname);
    if (tableRoute && request.method === "GET") {
      const table = tables.get(tableRoute[1]!);
      if (!table) return send(response, 404, { error: "no such table" });
      void table.handle("GET", tableRoute[2]!, async () => undefined).then((reply) => send(response, reply.status, reply.body));
      return;
    }
    const target = url.pathname.startsWith("/negotiation/") ? negotiation : room;
    void target.handle(request.method ?? "GET", url.pathname, url.searchParams, () => readJson(request)).then((reply) => send(response, reply.status, reply.body));
  });

  await new Promise<void>((resolve) => server.listen(options.port ?? 0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    server,
    url: baseUrl,
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
    ...(apiKey ? { decide: claudeDecider({ apiKey, model }), negotiate: claudeNegotiator({ apiKey, model }), negotiateLabel: modelLabel(model) } : {}),
  });
  console.log(apiKey ? `Agents: bids decided by ${model}, with a script as fallback.` : "Agents: scripted. Set ANTHROPIC_API_KEY to have a language model decide their bids.");
  console.log(`The demos are at ${url}/demo`);
  console.log(`  the Sealed Room:      ${url}/demo/auction`);
  console.log(`  the Negotiation Room: ${url}/demo/negotiation`);
  console.log(`MCP server, for negotiation tables: ${url}/mcp`);
  console.log(mode === "live" ? "Clock: the real drand quicknet beacon." : "Clock: SIMULATED on this machine, for showing offline. The cryptography is the same; the clock is not independent.");
  console.log("Demonstration only. Not security reviewed.");
}
