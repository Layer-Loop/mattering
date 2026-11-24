/**
 * One Sealed Room: three agents and at most one auction at a time, run on the
 * shared log. No server, no files and no timers in here. Whatever hosts it
 * calls `handle` for requests and `work` whenever time has passed.
 */
import {
  MatteringError,
  POLICY_FORMAT,
  STATEMENT_POLICY_FORMAT,
  deadlineRound,
  generateKeyPair,
  prepareBid,
  prepareStatement,
  type AuctionPolicy,
  type BeaconInfo,
  type BeaconSource,
  type Envelope,
  type StatementPolicy,
  type Submission,
} from "@mattering/core";
import { errorReply, type Reply } from "@mattering/witness/routes";
import { AGENTS, SLOT, acceptDecision, drawCeiling, type Decider, type Decision } from "./agents.ts";
import type { LogHost } from "./log-host.ts";

interface AgentState {
  name: string;
  tagline: string;
  series: number;
  publicKey: string;
  secretKey: string;
  dueAt: number;
  submitted: boolean;
  /** What chose this agent's bid, once chosen. */
  decidedBy?: "model" | "script";
}

interface RunState {
  id: number;
  auction: AuctionPolicy;
  auctionHash: string;
  forecast: StatementPolicy;
  forecastHash: string;
  closeAt: number;
  releaseAt: number;
  agents: AgentState[];
}

/** What a room remembers. The log keeps everything else. */
export interface RoomState {
  /** 2 since rooms share one log. Rooms saved before that start afresh. */
  version: 2;
  runs: number;
  run?: RunState;
}

export interface RoomOptions {
  mode: "live" | "simulated";
  /** A fresh view of the beacon for each party. */
  sourceFor: () => BeaconSource;
  /** Milliseconds since the UNIX epoch at which `round` is due. */
  timeOfRound: (round: number) => number;
  /** The shared log. */
  log: LogHost;
  loadState: () => Promise<RoomState | undefined>;
  saveState: (state: RoomState) => Promise<void>;
  /** Rounds from start to close, and from close to release. */
  closeAfter: number;
  releaseAfter: number;
  /** Milliseconds between the agents' submissions. */
  agentGapMs: number;
  /** Refuse to start more than this many auctions. */
  maxRuns?: number;
  /** Refuse more than this many submissions under one policy. */
  maxEntries?: number;
  /** Refuse policy registration from outside. */
  closed?: boolean;
  /** A language model to decide the agents' bids. Without it, their scripts decide. */
  decide?: Decider;
  /** Called once per auction before the model is used; return false to use the scripts instead. */
  allowModel?: () => Promise<boolean>;
  /** Milliseconds to wait for the model before the script decides. */
  decideTimeoutMs?: number;
}

export class Room {
  private busy: Promise<unknown> = Promise.resolve();
  /** Decisions made but not yet sealed. Held in memory only, never stored. */
  private decided: { runId: number; decisions: Decision[] } | undefined;

  private constructor(
    private readonly options: RoomOptions,
    private readonly log: LogHost,
    private readonly viewer: BeaconSource,
    private state: RoomState,
  ) {}

  static async open(options: RoomOptions): Promise<Room> {
    let state = await options.loadState();
    // A room saved before rooms shared a log had its own witness; its auction cannot carry over.
    if (state?.version !== 2) {
      state = { version: 2, runs: state?.runs ?? 0 };
      await options.saveState(state);
    }
    return new Room(options, options.log, options.sourceFor(), state);
  }

  get beacon(): BeaconInfo {
    return this.viewer.beacon;
  }

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.busy.then(fn);
    this.busy = run.catch(() => {});
    return run;
  }

  /** Start a new auction. The agents' bids are scheduled, not yet made. */
  start(): Promise<void> {
    return this.exclusive(async () => {
      const { options, state } = this;
      if (options.maxRuns !== undefined && state.runs >= options.maxRuns) {
        throw new MatteringError("POLICY", "this demonstration room has run its limit of auctions; reload the page for a fresh one");
      }
      const now = (await deadlineRound(this.viewer)).round;
      const closeRound = now + options.closeAfter;
      const releaseRound = closeRound + options.releaseAfter;
      const id = state.runs + 1;
      const log = await this.log.terms();
      const terms = { beacon: this.beacon, closeRound, releaseRound, witness: log.witness, origin: log.origin, logFrom: log.size, cosigners: log.cosigners, cosignerThreshold: log.cosignerThreshold };
      const auction: AuctionPolicy = { format: POLICY_FORMAT, auctionId: `daily-ledger-banner-${Date.now()}-${id}`, ...terms, minBid: SLOT.minBid, maxBid: SLOT.maxBid, rule: "highest-bid", tieBreak: "release-round-signature" };
      const forecast: StatementPolicy = { format: STATEMENT_POLICY_FORMAT, topic: `What will ${auction.auctionId} sell for, and why?`, ...terms };
      const auctionHash = await this.log.registerPolicy(auction);
      const forecastHash = await this.log.registerPolicy(forecast);
      const started = Date.now();
      state.runs = id;
      state.run = {
        id,
        auction,
        auctionHash,
        forecast,
        forecastHash,
        closeAt: options.timeOfRound(closeRound),
        releaseAt: options.timeOfRound(releaseRound),
        agents: AGENTS.map((agent, i) => {
          const keys = generateKeyPair();
          return { name: agent.name, tagline: agent.tagline, series: agent.series, publicKey: keys.publicKey, secretKey: keys.secretKey, dueAt: started + options.agentGapMs * (i + 1), submitted: false };
        }),
      };
      await options.saveState(state);
    });
  }

  /**
   * Do whatever is due: agents whose moment has come seal and submit, and the
   * witness closes and collects cosignatures. Returns the number of
   * milliseconds after which it wants calling again, or undefined when idle.
   */
  work(): Promise<number | undefined> {
    return this.exclusive(async () => {
      const run = this.state.run;
      if (!run) return undefined;
      if (run.agents.some((a) => !a.submitted) && this.decided?.runId !== run.id) await this.decideAll(run);
      for (const [i, agent] of run.agents.entries()) {
        if (agent.submitted || agent.dueAt > Date.now()) continue;
        agent.submitted = true;
        await this.options.saveState(this.state);
        try {
          // The agent seals and submits. Its amount exists in this process's
          // memory and inside the sealed envelope, and nowhere else.
          const keys = generateKeyPair(agent.secretKey);
          const decision = this.decided!.decisions[i]!;
          const bid = await prepareBid(run.auction, decision.bid, keys);
          const statement = await prepareStatement(run.forecast, decision.prediction, keys);
          await this.log.submit(bid.submission, bid.envelope);
          await this.log.submit(statement.submission, statement.envelope);
        } catch (error) {
          console.error(`${agent.name}: ${(error as Error).message}`);
        }
      }
      await this.log.tick().catch(() => {});
      const phase = await this.log.phase(run.auctionHash);
      const done = phase.state === "released" || (phase.state === "closed" && phase.cosignatures >= 1 && run.agents.every((a) => a.submitted));
      if (phase.state === "released") return undefined;
      // Once closed and cosigned there is nothing to do until the release.
      return done ? Math.max(500, run.releaseAt - Date.now()) : 500;
    });
  }

  /**
   * Every agent that has not yet bid decides now, all at once. The model is
   * asked if there is one and it is allowed; whatever it returns is checked,
   * and anything unusable, slow or failed is replaced by the agent's script.
   */
  private async decideAll(run: RunState): Promise<void> {
    const { decide, allowModel } = this.options;
    const useModel = decide !== undefined && (allowModel ? await allowModel().catch(() => false) : true);
    const timeout = this.options.decideTimeoutMs ?? 15_000;
    const decisions = await Promise.all(
      AGENTS.map(async (agent, i): Promise<Decision> => {
        const state = run.agents[i]!;
        const ceiling = drawCeiling(agent, Math.random);
        if (useModel && !state.submitted) {
          try {
            const answer = await Promise.race([
              decide(agent, SLOT, ceiling),
              new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("timed out")), timeout)),
            ]);
            const accepted = acceptDecision(SLOT, answer);
            if (accepted) {
              state.decidedBy = "model";
              return accepted;
            }
            console.error(`${agent.name}: the model's answer was not a usable bid; using the script`);
          } catch {
            // already logged by the decider; fall through to the script
          }
        }
        state.decidedBy = "script";
        return agent.script(SLOT, ceiling, Math.random);
      }),
    );
    this.decided = { runId: run.id, decisions };
    await this.options.saveState(this.state);
  }

  async view(): Promise<Record<string, unknown>> {
    const log = await this.log.terms();
    const base = { mode: this.options.mode, beacon: this.beacon, slot: SLOT, serverTime: Date.now(), ...(log.ownCosigner ? { ownCosigner: log.ownCosigner } : {}) };
    const run = this.state.run;
    if (!run) return { ...base, run: null };
    const phase = await this.log.phase(run.auctionHash);
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
        agents: run.agents.map(({ secretKey: _secret, dueAt: _due, ...shown }) => shown),
        phase: phase.state,
        cosigned: phase.cosignatures >= 1,
        entries: (await this.log.submissions(run.auctionHash)).map((e) => ({ submitter: e.submitter, envelopeId: e.envelopeId })),
      },
    };
  }

  /**
   * What a dishonest operator would do after release: knowing every bid,
   * rewrite the log with a winning bid of its own slipped in before the close
   * and sign it with the witness's real key. Returned for the page to verify.
   */
  private async forge(): Promise<Record<string, unknown>> {
    const run = this.state.run;
    if (!run) throw new MatteringError("POLICY", "no auction is running");
    if ((await this.log.phase(run.auctionHash)).state !== "released") throw new MatteringError("POLICY", "the bids have not been released yet");
    const shill = await prepareBid(run.auction, run.auction.maxBid, generateKeyPair());
    return { ...(await this.log.forge(run.auctionHash, shill)) };
  }

  /** `path` is "/demo/…" for the room's own routes or "/api/…" for the witness's. */
  async handle(method: string, path: string, query: URLSearchParams, body: () => Promise<unknown>): Promise<Reply> {
    try {
      const ok = (value: unknown): Reply => ({ status: 200, body: value });
      if (path.startsWith("/api/") || path === "/api") {
        const inner = path.slice(4) || "/";
        if (this.options.closed && method === "POST" && inner.startsWith("/policies")) {
          return { status: 403, body: { error: "this room does not accept policies from outside" } };
        }
        if (method === "POST" && inner.startsWith("/submissions")) {
          // Through a room, only that room's auction can be joined, and only so far.
          const value = (await body()) as { submission?: Submission; envelope?: Envelope } | null;
          const run = this.state.run;
          if (this.options.closed && (!run || (value?.submission?.policyHash !== run.auctionHash && value?.submission?.policyHash !== run.forecastHash))) {
            return { status: 403, body: { error: "this room only takes submissions for its own auction" } };
          }
          if (run && this.options.maxEntries !== undefined && Math.max(await this.log.count(run.auctionHash), await this.log.count(run.forecastHash)) >= this.options.maxEntries) {
            return { status: 429, body: { error: "this demonstration auction has taken as many bids as it allows" } };
          }
          return await this.log.api(method, inner, query, async () => value);
        }
        return await this.log.api(method, inner, query, body);
      }
      switch (`${method} ${path}`) {
        case "GET /demo/state":
          return ok(await this.view());
        case "POST /demo/start":
          await this.start();
          return ok(await this.view());
        case "GET /demo/latest":
          return ok(await this.viewer.latest());
        case "POST /demo/forge":
          return ok(await this.forge());
        default:
          return { status: 404, body: { error: "no such route" } };
      }
    } catch (error) {
      return errorReply(error);
    }
  }
}
