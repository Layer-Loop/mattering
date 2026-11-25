/**
 * The Sealed Room on Cloudflare: a Worker that serves the site's static files,
 * routes /room/<id>/… to a Durable Object holding that visitor's room, and
 * /log/… to the one shared log, read-only.
 *
 * Every room writes into the same long-lived log, held by one Durable Object
 * of the same class under the reserved name "log". Rooms are throwaway and
 * delete themselves after a period of disuse; the log never does. Its key,
 * origin and cosigners come from the Worker's settings (see Env), so public
 * witnesses can be configured with it.
 */
import { DurableObject, type DurableObjectState } from "cloudflare:workers";
import { QUICKNET, generateKeyPair, scheduleClock, timeOfRound, type BeaconSource, type CosignedState, type Envelope, type LogEntry } from "@mattering/core";
import { drandSource } from "@mattering/core/drand-http";
import { TestBeacon, WallTestClock } from "@mattering/core/testing";
import { MAX_BODY, parseBody, type Reply } from "@mattering/witness/routes";
import { httpCosign } from "@mattering/witness/client";
import type { AnyPolicy, ServiceStore, StoredClosing, StoredState } from "@mattering/witness/service";
import { DEFAULT_MODEL, claudeDecider, claudeNegotiator, modelLabel } from "../../showcase/src/llm.ts";
import { LocalLogHost, RemoteLogHost, handleLogHost } from "../../showcase/src/log-host.ts";
import { Room, type RoomState } from "../../showcase/src/room.ts";
import { NegotiationRoom, type NegotiationRoomState } from "../../showcase/src/negotiation-room.ts";

interface Env {
  ROOMS: { idFromName(name: string): unknown; get(id: unknown): { fetch(request: Request): Promise<Response> } };
  ASSETS: { fetch(request: Request): Promise<Response> };
  /** "1" replaces drand with a clock simulated inside the log. Local development only. */
  SIMULATED?: string;
  /** A Claude API key. With it, a language model decides the agents' bids; without it, their scripts do. */
  ANTHROPIC_API_KEY?: string;
  /** The model to ask. Defaults to the showcase's default. */
  MATTERING_MODEL?: string;
  /** The most auctions per day, across all visitors, that may use the model. Default 300. */
  MODEL_AUCTIONS_PER_DAY?: string;
  /**
   * The log's C2SP origin, such as example.com/log. Public witnesses know the
   * log by it, so set it once, before the first auction, and never change it.
   * Default: one derived from the key, under mattering.invalid.
   */
  MATTERING_ORIGIN?: string;
  /**
   * The log's Ed25519 secret key, 64 hex characters, as a secret. Kept here
   * rather than generated inside the log, so that it survives the log's
   * storage and can be backed up. Without it the log makes and stores its own.
   */
  MATTERING_LOG_KEY?: string;
  /** Public witnesses that cosign the log: comma-separated `vkey=url` pairs, url being the add-checkpoint prefix. */
  MATTERING_WITNESSES?: string;
  /**
   * "1" runs a cosigner beside the log, "0" does not. It is not independent;
   * it lets the demonstration show cosigning before public witnesses do.
   * Default: on when no public witnesses are configured.
   */
  MATTERING_OWN_COSIGNER?: string;
}

/** Reserved object names. Not room ids, so visitors cannot reach them as rooms. */
const BUDGET_NAME = "model-budget";
const LOG_NAME = "log";
const DEFAULT_MODEL_AUCTIONS_PER_DAY = 300;
/** What the cosigner beside the log calls itself. Not a real address: it is not independent. */
const OWN_COSIGNER_NAME = "cosigner.sealed-room.invalid";

/** A room is deleted this long after it was last used. */
const ROOM_LIFETIME_MS = 30 * 60 * 1000;
const ROUND_MS_SIMULATED = 1000;
/** Leaf hashes stored per key: 512 × 64 hex characters = 32 KB. */
const LEAF_CHUNK = 512;

/**
 * The log's storage. Entries, policies, closings and envelopes each have
 * their own keys; leaf hashes are kept in chunks so that a cold start reads a
 * few hundred keys rather than one per entry. Only policies still live are
 * loaded at start.
 */
function durableStore(storage: DurableObjectState["storage"]): ServiceStore {
  const pad = (n: number, width: number): string => String(n).padStart(width, "0");
  const entryKey = (index: number): string => `entry:${pad(index, 12)}`;
  const chunkKey = (chunk: number): string => `leaves:${pad(chunk, 9)}`;
  let tail: { chunk: number; hashes: string } | undefined;
  const getMany = async <T>(keys: string[]): Promise<Map<string, T>> => {
    const out = new Map<string, T>();
    for (let i = 0; i < keys.length; i += 128) for (const [k, v] of await storage.get<T>(keys.slice(i, i + 128))) out.set(k, v);
    return out;
  };
  return {
    async load() {
      const state: StoredState = { leafHashes: [], policies: [], closings: {} };
      const secretKey = await storage.get<string>("witness-key");
      if (secretKey) state.secretKey = secretKey;
      for (const hashes of (await storage.list<string>({ prefix: "leaves:" })).values()) {
        for (let i = 0; i < hashes.length; i += 64) state.leafHashes.push(hashes.slice(i, i + 64));
      }
      const active = [...(await storage.list<true>({ prefix: "active:" })).keys()].map((k) => k.slice(7));
      state.policies = [...(await getMany<AnyPolicy>(active.map((h) => `policy:${h}`))).values()];
      for (const [key, value] of await getMany<StoredClosing>(active.map((h) => `closing:${h}`))) state.closings[key.slice(8)] = value;
      return state;
    },
    saveKey: (secretKey) => storage.put("witness-key", secretKey),
    async appendEntry(index, entry, leafHash) {
      const chunk = Math.floor(index / LEAF_CHUNK);
      if (tail?.chunk !== chunk) tail = { chunk, hashes: (await storage.get<string>(chunkKey(chunk))) ?? "" };
      if (tail.hashes.length !== (index % LEAF_CHUNK) * 64) throw new Error(`log storage: expected entry ${chunk * LEAF_CHUNK + tail.hashes.length / 64}, got ${index}`);
      const hashes = tail.hashes + leafHash;
      // One write for both, so the entry and its leaf hash are stored together or not at all.
      await storage.put({ [entryKey(index)]: entry, [chunkKey(chunk)]: hashes });
      tail.hashes = hashes;
    },
    async readEntries(from, to) {
      if (from >= to) return [];
      return [...(await storage.list<LogEntry>({ start: entryKey(from), end: entryKey(to) })).values()];
    },
    savePolicy: (hash, policy) => storage.put({ [`policy:${hash}`]: policy, [`active:${hash}`]: true }),
    async loadPolicy(hash) {
      const policy = await storage.get<AnyPolicy>(`policy:${hash}`);
      return policy && { policy, closing: await storage.get<StoredClosing>(`closing:${hash}`) };
    },
    retirePolicy: async (hash) => void (await storage.delete(`active:${hash}`)),
    saveEnvelope: (id, envelope) => storage.put(`envelope:${id}`, envelope),
    loadEnvelope: (id) => storage.get<Envelope>(`envelope:${id}`),
    saveClosing: (hash, value) => storage.put(`closing:${hash}`, value),
  };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body) + "\n", { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

function respond(reply: Reply): Response {
  return json(reply.status, reply.body);
}

async function readBody(request: Request): Promise<unknown> {
  const text = await request.text();
  if (text.length > MAX_BODY) throw new Error("request body too large");
  return parseBody(text);
}

/** A simulated clock's parameters, kept by the log so that every room shares its time. */
interface TestClockParams {
  secretHex: string;
  epoch: number;
}

function wallClock(params: TestClockParams): WallTestClock {
  return new WallTestClock(new TestBeacon(params.secretHex), params.epoch, ROUND_MS_SIMULATED);
}

export class SealedRoom extends DurableObject<Env> {
  private room: Promise<Room> | undefined;
  private negotiation: Promise<NegotiationRoom> | undefined;
  private log: Promise<LocalLogHost> | undefined;
  private markedAsLog = false;

  private logStub(): { fetch(request: Request): Promise<Response> } {
    return this.env.ROOMS.get(this.env.ROOMS.idFromName(LOG_NAME));
  }

  // --- the shared log ----------------------------------------------------------

  /** In the "log" object only: the clock, made once and kept. */
  private async testClock(): Promise<TestClockParams> {
    let saved = await this.ctx.storage.get<TestClockParams>("test-clock");
    if (!saved) {
      saved = { secretHex: new TestBeacon().secretHex, epoch: Date.now() - 10 * ROUND_MS_SIMULATED };
      await this.ctx.storage.put("test-clock", saved);
    }
    return saved;
  }

  private openLog(): Promise<LocalLogHost> {
    this.log ??= (async () => {
      const storage = this.ctx.storage;
      const env = this.env;
      const clock = env.SIMULATED === "1" ? wallClock(await this.testClock()) : undefined;
      const sourceFor = (): BeaconSource => (clock ? clock.source() : drandSource(QUICKNET));
      const pairs = (env.MATTERING_WITNESSES ?? "").split(",").map((s) => s.trim()).filter(Boolean);
      // A vkey never contains "=" (its key is 33 bytes, so no base64 padding); the first "=" separates the URL.
      const witnesses = Object.fromEntries(pairs.map((pair) => [pair.slice(0, pair.indexOf("=")), pair.slice(pair.indexOf("=") + 1)]));
      const ownWanted = env.MATTERING_OWN_COSIGNER === undefined ? pairs.length === 0 : env.MATTERING_OWN_COSIGNER === "1";
      let ownCosigner;
      if (ownWanted) {
        const saved = (await storage.get<{ secretKey: string; state: Record<string, CosignedState> }>("own-cosigner")) ?? { secretKey: generateKeyPair().secretKey, state: {} };
        await storage.put("own-cosigner", saved);
        ownCosigner = {
          name: OWN_COSIGNER_NAME,
          secretKey: saved.secretKey,
          state: saved.state,
          persist: (state: Record<string, CosignedState>) => storage.put("own-cosigner", { secretKey: saved.secretKey, state }),
          // Its own view of the beacon's schedule: real time against drand, simulated time in development.
          clock: scheduleClock(sourceFor()),
        };
      }
      return LocalLogHost.open({
        store: durableStore(storage),
        source: sourceFor(),
        origin: env.MATTERING_ORIGIN || undefined,
        secretKey: env.MATTERING_LOG_KEY || undefined,
        witnesses,
        reachWitness: httpCosign(witnesses),
        ownCosigner,
      });
    })();
    return this.log;
  }

  /** Make sure the log ticks soon, without pushing back an alarm already due sooner. */
  private async wakeLogSoon(): Promise<void> {
    const due = await this.ctx.storage.getAlarm();
    const soon = Date.now() + 100;
    if (due === null || due > soon) await this.ctx.storage.setAlarm(soon);
  }

  private async logFetch(url: URL, request: Request, internal: boolean): Promise<Response> {
    if (internal && url.pathname === "/host/test-clock") return json(200, await this.testClock());
    // From outside, the log is read-only and its room-facing routes are hidden.
    if (!internal && (request.method !== "GET" || url.pathname.startsWith("/host/"))) return json(405, { error: "the log is read-only here; auctions run in rooms" });
    const log = await this.openLog();
    const reply = await handleLogHost(log, request.method, url.pathname, url.searchParams, () => readBody(request));
    if (request.method === "POST") await this.wakeLogSoon();
    return respond(reply);
  }

  private async logAlarm(): Promise<void> {
    const log = await this.openLog();
    await log.tick().catch((error: Error) => console.error(`log tick: ${error.message}`));
    // Tick every round while any policy is open or waiting to be released; otherwise sleep until a room wakes it.
    if (log.busy) await this.ctx.storage.setAlarm(Date.now() + (this.env.SIMULATED === "1" ? ROUND_MS_SIMULATED : QUICKNET.period * 1000));
  }

  // --- a visitor's room --------------------------------------------------------

  /** What every demonstration in a visitor's room shares: the log, and the clock. */
  private async roomContext() {
    const stub = this.logStub();
    const fetchLog = (path: string, init?: RequestInit): Promise<Response> => stub.fetch(new Request(`https://${LOG_NAME}${path}`, init));
    const simulated = this.env.SIMULATED === "1";
    const clock = simulated ? wallClock((await (await fetchLog("/host/test-clock")).json()) as TestClockParams) : undefined;
    return {
      simulated,
      mode: simulated ? ("simulated" as const) : ("live" as const),
      sourceFor: (): BeaconSource => (clock ? clock.source() : drandSource(QUICKNET)),
      timeOfRound: (round: number): number => (clock ? clock.timeOfRound(round) : timeOfRound(QUICKNET, round) * 1000),
      log: new RemoteLogHost(fetchLog),
    };
  }

  /** Ask the shared counter before spending anything, charging `units` auctions' worth. If it cannot be reached, don't spend. */
  private async takeModelBudget(units: number): Promise<boolean> {
    const budget = this.env.ROOMS.get(this.env.ROOMS.idFromName(BUDGET_NAME));
    const reply = await budget.fetch(new Request(`https://budget/take?units=${units}`, { method: "POST" }));
    return reply.ok && ((await reply.json()) as { allowed?: boolean }).allowed === true;
  }

  private openNegotiation(): Promise<NegotiationRoom> {
    this.negotiation ??= (async () => {
      const storage = this.ctx.storage;
      const context = await this.roomContext();
      const model = this.env.MATTERING_MODEL ?? DEFAULT_MODEL;
      return NegotiationRoom.open({
        mode: context.mode,
        sourceFor: context.sourceFor,
        timeOfRound: context.timeOfRound,
        log: context.log,
        loadState: () => storage.get<NegotiationRoomState>("negotiation"),
        saveState: (state) => storage.put("negotiation", state),
        closeAfter: context.simulated ? 12 : 5,
        releaseAfter: context.simulated ? 6 : 3,
        agentGapMs: 1500,
        maxRuns: 10,
        ...(this.env.ANTHROPIC_API_KEY
          ? {
              decide: claudeNegotiator({ apiKey: this.env.ANTHROPIC_API_KEY, model }),
              decideLabel: modelLabel(model),
              // Six model calls a negotiation against three an auction: charge two auctions' worth.
              allowModel: () => this.takeModelBudget(2),
            }
          : {}),
      });
    })();
    return this.negotiation;
  }

  private openRoom(): Promise<Room> {
    this.room ??= (async () => {
      const storage = this.ctx.storage;
      const context = await this.roomContext();
      return Room.open({
        mode: context.mode,
        sourceFor: context.sourceFor,
        timeOfRound: context.timeOfRound,
        log: context.log,
        loadState: () => storage.get<RoomState>("room"),
        saveState: (state) => storage.put("room", state),
        closeAfter: context.simulated ? 30 : 10,
        releaseAfter: context.simulated ? 15 : 5,
        agentGapMs: 3000,
        maxRuns: 20,
        maxEntries: 12,
        closed: true,
        ...(this.env.ANTHROPIC_API_KEY
          ? {
              decide: claudeDecider({ apiKey: this.env.ANTHROPIC_API_KEY, model: this.env.MATTERING_MODEL ?? DEFAULT_MODEL }),
              allowModel: () => this.takeModelBudget(1),
            }
          : {}),
      });
    })();
    return this.room;
  }

  /**
   * The budget object: counts model use today, across all rooms, in auctions'
   * worth (a negotiation is two), and says no once the day's allowance is spent.
   */
  private async takeFromBudget(url: URL): Promise<Response> {
    const limit = Number(this.env.MODEL_AUCTIONS_PER_DAY ?? DEFAULT_MODEL_AUCTIONS_PER_DAY);
    const units = Math.max(1, Math.min(10, Number(url.searchParams.get("units") ?? 1) || 1));
    const today = new Date().toISOString().slice(0, 10);
    const saved = (await this.ctx.storage.get<{ day: string; used: number }>("budget")) ?? { day: today, used: 0 };
    const used = saved.day === today ? saved.used : 0;
    const allowed = Number.isFinite(limit) && used + units <= limit;
    if (allowed) await this.ctx.storage.put("budget", { day: today, used: used + units });
    return json(200, { allowed, used: allowed ? used + units : used, limit });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.hostname === "budget") return this.takeFromBudget(url);
    try {
      if (url.hostname === LOG_NAME || url.hostname === "log-public") {
        if (!this.markedAsLog) {
          await this.ctx.storage.put("role", "log");
          this.markedAsLog = true;
        }
        return await this.logFetch(url, request, url.hostname === LOG_NAME);
      }
      // One room per visitor holds both demonstrations: the auction, and the negotiation under /negotiation/.
      const target = url.pathname.startsWith("/negotiation/") ? await this.openNegotiation() : await this.openRoom();
      const reply = await target.handle(request.method, url.pathname, url.searchParams, () => readBody(request));
      // Work happens in the alarm, never in a visitor's request: an agent's
      // decision can take seconds when a language model makes it.
      await this.ctx.storage.put("expires", Date.now() + ROOM_LIFETIME_MS);
      if (request.method === "POST") await this.ctx.storage.setAlarm(Date.now() + 100);
      return respond(reply);
    } catch (error) {
      console.error(error);
      return json(500, { error: "the demonstration failed; reload the page" });
    }
  }

  async alarm(): Promise<void> {
    // The log is never deleted, whatever happens to rooms.
    if ((await this.ctx.storage.get<string>("role")) === "log") return this.logAlarm();
    const waits: number[] = [];
    // Open only what this room has used: a visitor may run one demonstration and not the other.
    if (await this.ctx.storage.get("room")) {
      const wait = await (await this.openRoom()).work();
      if (wait !== undefined) waits.push(wait);
    }
    if (await this.ctx.storage.get("negotiation")) {
      const wait = await (await this.openNegotiation()).work();
      if (wait !== undefined) waits.push(wait);
    }
    if (waits.length > 0) return this.ctx.storage.setAlarm(Date.now() + Math.min(...waits));
    const expires = (await this.ctx.storage.get<number>("expires")) ?? 0;
    if (Date.now() >= expires) {
      await this.ctx.storage.deleteAll();
      this.room = undefined;
      this.negotiation = undefined;
      return;
    }
    await this.ctx.storage.setAlarm(expires);
  }
}

const ROOM_PATH = /^\/room\/([0-9a-f-]{36})(\/.*)$/;
const LOG_PATH = /^\/log(\/.*)?$/;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const room = ROOM_PATH.exec(url.pathname);
    if (room) {
      const stub = env.ROOMS.get(env.ROOMS.idFromName(room[1]!));
      return stub.fetch(new Request(new URL(room[2]! + url.search, url.origin), request));
    }
    // What a demonstration page needs to know before any room exists: which model, if any, chooses for the agents.
    if (url.pathname === "/demo-info") {
      return json(200, { decider: env.ANTHROPIC_API_KEY ? modelLabel(env.MATTERING_MODEL ?? DEFAULT_MODEL) : null, mode: env.SIMULATED === "1" ? "simulated" : "live" });
    }
    // The shared log, read-only: its witness API at /log/, /log/log?from=…, /log/policies/<hash>/evidence, …
    const log = LOG_PATH.exec(url.pathname);
    if (log) {
      const stub = env.ROOMS.get(env.ROOMS.idFromName(LOG_NAME));
      return stub.fetch(new Request(`https://log-public${log[1] ?? "/"}${url.search}`, { method: request.method }));
    }
    return env.ASSETS.fetch(request);
  },
};
