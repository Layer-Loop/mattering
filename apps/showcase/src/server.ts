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
import { QUICKNET, timeOfRound } from "@mattering/core";
import { drandSource } from "@mattering/core/drand-http";
import { TestBeacon, WallTestClock } from "@mattering/core/testing";
import { memoryStore, readJson, send } from "@mattering/witness";
import { Room, type RoomState } from "./room.ts";

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
}

/** Bundle the page's script for the browser. */
export async function bundlePage(minify = false): Promise<string> {
  const result = await build({
    entryPoints: [join(web, "app.ts")],
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

  let saved: RoomState | undefined;
  const room = await Room.open({
    mode: options.mode,
    sourceFor: () => (clock ? clock.source() : drandSource(QUICKNET)),
    timeOfRound: (round) => (clock ? clock.timeOfRound(round) : timeOfRound(QUICKNET, round) * 1000),
    store: memoryStore(),
    loadState: async () => saved,
    saveState: async (state) => void (saved = state),
    closeAfter,
    releaseAfter: options.releaseAfter ?? (simulated ? 15 : 5),
    agentGapMs: options.agentGapMs ?? Math.min(3000, (closeAfter * roundMs) / 6),
  });
  const timer = setInterval(() => void room.work().catch(() => {}), Math.min(500, roundMs));

  const appJs = await bundlePage();
  const files: Record<string, [string, () => string]> = {
    "/": ["text/html; charset=utf-8", () => readFileSync(join(web, "index.html"), "utf8")],
    "/style.css": ["text/css; charset=utf-8", () => readFileSync(join(web, "style.css"), "utf8")],
    "/app.js": ["text/javascript; charset=utf-8", () => appJs],
  };

  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const file = request.method === "GET" ? files[url.pathname] : undefined;
    if (file) {
      response.writeHead(200, { "content-type": file[0], "cache-control": "no-store" });
      return response.end(file[1]());
    }
    void room.handle(request.method ?? "GET", url.pathname, url.searchParams, () => readJson(request)).then((reply) => send(response, reply.status, reply.body));
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
  const { url } = await startShowcase({ mode, port: Number(process.env.PORT ?? 8790) });
  console.log(`The Sealed Room is at ${url}`);
  console.log(mode === "live" ? "Clock: the real drand quicknet beacon." : "Clock: SIMULATED on this machine, for showing offline. The cryptography is the same; the clock is not independent.");
  console.log("Demonstration only. Not security reviewed.");
}
