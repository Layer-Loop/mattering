/**
 * The Sealed Room: a web page that runs a sealed-bid auction between three
 * agents on a real witness service and lets the visitor try to cheat.
 *
 *   npm run showcase            against the real drand quicknet (needs internet)
 *   npm run showcase:offline    against a simulated beacon on this machine's clock
 *
 * One process holds the witness service, an in-process cosigner, the scripted
 * agents and the page. The page does its own sealing, opening and verifying in
 * the browser with the same library; this server's opinion of the result is
 * never shown.
 */
import { mkdtempSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import {
  Cosigner,
  MatteringError,
  POLICY_FORMAT,
  QUICKNET,
  STATEMENT_POLICY_FORMAT,
  Witness,
  deadlineRound,
  generateKeyPair,
  policyHash,
  prepareBid,
  prepareStatement,
  timeOfRound,
  type AuctionPolicy,
  type BeaconInfo,
  type BeaconSource,
  type StatementPolicy,
} from "@mattering/core";
import { drandSource } from "@mattering/core/drand-http";
import { TestBeacon, TestClock } from "@mattering/core/testing";
import { WitnessService, send, sendError, witnessListener } from "@mattering/witness";
import { AGENTS, SLOT } from "./agents.ts";

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

interface Run {
  id: number;
  auction: AuctionPolicy;
  auctionHash: string;
  forecast: StatementPolicy;
  forecastHash: string;
  closeAt: number;
  releaseAt: number;
  agents: { name: string; tagline: string; series: number; publicKey: string; submitted: boolean }[];
}

export async function startShowcase(options: ShowcaseOptions): Promise<{ server: Server; url: string; stop: () => void }> {
  const simulated = options.mode === "simulated";
  const roundMs = simulated ? (options.roundMs ?? 1000) : QUICKNET.period * 1000;
  const closeAfter = options.closeAfter ?? (simulated ? 30 : 10);
  const releaseAfter = options.releaseAfter ?? (simulated ? 15 : 5);
  const timers: NodeJS.Timeout[] = [];

  // Each party gets its own view of the beacon.
  let beacon: BeaconInfo;
  let sourceFor: () => BeaconSource;
  let clock: TestClock | undefined;
  if (simulated) {
    clock = new TestClock(new TestBeacon(), 10);
    beacon = clock.testBeacon.info;
    sourceFor = () => clock!.source();
    timers.push(setInterval(() => clock!.advanceTo(clock!.now + 1), roundMs));
  } else {
    beacon = QUICKNET;
    sourceFor = () => drandSource(QUICKNET);
  }
  const timeOf = (round: number, nowRound: number): number =>
    simulated ? Date.now() + (round - nowRound) * roundMs : timeOfRound(beacon, round) * 1000;

  const cosigner = new Cosigner(sourceFor());
  const dataDir = mkdtempSync(join(tmpdir(), "mattering-showcase-"));
  const service = new WitnessService({
    dataDir,
    source: sourceFor(),
    cosign: async (_key, hash, policy, closing) => cosigner.cosign(hash, policy, closing),
  });
  timers.push(setInterval(() => void service.tick().catch(() => {}), Math.min(1000, roundMs)));
  const api = witnessListener(service);
  const viewer = sourceFor();

  let run: Run | undefined;
  let runs = 0;

  async function startRun(): Promise<Run> {
    const now = (await deadlineRound(viewer)).round;
    const closeRound = now + closeAfter;
    const releaseRound = closeRound + releaseAfter;
    const id = ++runs;
    const terms = { beacon, closeRound, releaseRound, witness: service.publicKey, cosigners: [cosigner.publicKey], cosignerThreshold: 1 };
    const auction: AuctionPolicy = { format: POLICY_FORMAT, auctionId: `daily-ledger-banner-${Date.now()}-${id}`, ...terms, minBid: SLOT.minBid, maxBid: SLOT.maxBid, rule: "highest-bid", tieBreak: "release-round-signature" };
    const forecast: StatementPolicy = { format: STATEMENT_POLICY_FORMAT, topic: `What will ${auction.auctionId} sell for, and why?`, ...terms };
    const auctionHash = (await service.registerPolicy(auction)).policyHash;
    const forecastHash = (await service.registerPolicy(forecast)).policyHash;
    const mine: Run = { id, auction, auctionHash, forecast, forecastHash, closeAt: timeOf(closeRound, now), releaseAt: timeOf(releaseRound, now), agents: [] };
    const gap = options.agentGapMs ?? Math.min(3000, (closeAfter * roundMs) / 6);
    AGENTS.forEach((agent, i) => {
      const keys = generateKeyPair();
      const entry = { name: agent.name, tagline: agent.tagline, series: agent.series, publicKey: keys.publicKey, submitted: false };
      mine.agents.push(entry);
      timers.push(
        setTimeout(() => {
          void (async () => {
            // The agent decides, seals and submits. Its amount exists in this
            // closure and inside the sealed envelope, and nowhere else.
            const decision = await agent.strategy(SLOT, Math.random);
            const bid = await prepareBid(auction, decision.bid, keys);
            const statement = await prepareStatement(forecast, decision.prediction, keys);
            await service.submit(bid.submission, bid.envelope);
            await service.submit(statement.submission, statement.envelope);
            entry.submitted = true;
          })().catch((error: Error) => console.error(`${agent.name}: ${error.message}`));
        }, gap * (i + 1)),
      );
    });
    run = mine;
    return mine;
  }

  async function state(): Promise<Record<string, unknown>> {
    const base = { mode: options.mode, beacon, witness: service.publicKey, cosigner: cosigner.publicKey, slot: SLOT, serverTime: Date.now() };
    if (!run) return { ...base, run: null };
    const bundle = await service.evidence(run.auctionHash);
    return {
      ...base,
      run: {
        id: run.id,
        auction: run.auction,
        auctionHash: run.auctionHash,
        forecast: run.forecast,
        forecastHash: run.forecastHash,
        closeAt: run.closeAt,
        releaseAt: run.releaseAt,
        agents: run.agents,
        phase: bundle.state,
        cosigned: (bundle.cosignatures?.length ?? 0) >= 1,
        entries: service.log().entries.filter((e) => e.policyHash === run!.auctionHash).map((e) => ({ submitter: e.submitter, envelopeId: e.envelopeId })),
      },
    };
  }

  /**
   * What a dishonest operator would do after release: knowing every bid, build
   * a second log with a winning bid of its own and sign a closing checkpoint
   * for it with the witness's real key. Returned for the page to verify.
   */
  async function forge(): Promise<Record<string, unknown>> {
    if (!run) throw new MatteringError("POLICY", "no auction is running");
    const bundle = await service.evidence(run.auctionHash);
    if (bundle.state !== "released") throw new MatteringError("POLICY", "the bids have not been released yet");
    const secretKey = (JSON.parse(readFileSync(join(dataDir, "witness-key.json"), "utf8")) as { secretKey: string }).secretKey;
    const forger = new Witness(secretKey);
    for (const entry of bundle.entries!) forger.submit(entry);
    const shill = await prepareBid(run.auction, run.auction.maxBid, generateKeyPair());
    forger.submit(shill.submission);
    const closeRelease = bundle.closing!.observed;
    const closing = forger.close(policyHash(run.auction), beacon, closeRelease);
    let cosignerSaid = "signed it";
    try {
      await cosigner.cosign(run.auctionHash, run.auction, closing);
    } catch (error) {
      cosignerSaid = (error as Error).message;
    }
    return {
      shillAmount: run.auction.maxBid,
      cosignerSaid,
      evidence: { ...bundle, entries: forger.entries(), closing, envelopes: { ...bundle.envelopes, [shill.submission.envelopeId]: shill.envelope } },
    };
  }

  const bundle = await build({
    entryPoints: [join(web, "app.ts")],
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    write: false,
    logLevel: "silent",
    define: { global: "globalThis" },
  });
  const appJs = bundle.outputFiles[0]!.text;
  const files: Record<string, [string, () => string]> = {
    "/": ["text/html; charset=utf-8", () => readFileSync(join(web, "index.html"), "utf8")],
    "/style.css": ["text/css; charset=utf-8", () => readFileSync(join(web, "style.css"), "utf8")],
    "/app.js": ["text/javascript; charset=utf-8", () => appJs],
  };

  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname.startsWith("/api/")) {
      request.url = url.pathname.slice(4) + url.search;
      return api(request, response);
    }
    const file = request.method === "GET" ? files[url.pathname] : undefined;
    if (file) {
      response.writeHead(200, { "content-type": file[0], "cache-control": "no-store" });
      return response.end(file[1]());
    }
    void (async () => {
      try {
        const route = `${request.method} ${url.pathname}`;
        if (route === "GET /demo/state") return send(response, 200, await state());
        if (route === "POST /demo/start") {
          await startRun();
          return send(response, 200, await state());
        }
        if (route === "GET /demo/latest") return send(response, 200, await viewer.latest());
        if (route === "POST /demo/forge") return send(response, 200, await forge());
        send(response, 404, { error: "no such route" });
      } catch (error) {
        sendError(response, error);
      }
    })();
  });

  await new Promise<void>((resolve) => server.listen(options.port ?? 0, "127.0.0.1", resolve));
  return {
    server,
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    stop: () => {
      timers.forEach((t) => clearTimeout(t));
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
