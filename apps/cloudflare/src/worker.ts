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
import { handleMcpHttp, type McpBackend } from "../../showcase/src/mcp.ts";
import { Table, type TableState } from "../../showcase/src/table.ts";
import { Scenario, type ScenarioState } from "../../showcase/src/scenario.ts";
import { handleApi, type PlatformHost } from "../../platform/src/api.ts";
import { HostedSession, HOST_LIMITS, IntegratorDesk, type DeskCall, type KV, type SessionCall, type Webhook } from "../../platform/src/hosted.ts";

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
  /** The most negotiation tables MCP clients may open per day, across everyone. Default 100. */
  TABLES_PER_DAY?: string;
  /**
   * The platform API's keys, as a secret: comma-separated `key=integrator`
   * pairs, such as `mk_test_…=Northbank Receivables`. Without it the API
   * accepts no key, so nobody can create a session.
   */
  MATTERING_API_KEYS?: string;
  /** New platform sessions per integrator per day. Default 100. */
  SESSIONS_PER_DAY?: string;
}

/** Reserved object names. Not room ids, so visitors cannot reach them as rooms. */
const BUDGET_NAME = "model-budget";
const LOG_NAME = "log";
const DEFAULT_MODEL_AUCTIONS_PER_DAY = 300;
const DEFAULT_TABLES_PER_DAY = 100;
/** A negotiation table is deleted this long after anyone last acted at it. */
const TABLE_LIFETIME_MS = 24 * 60 * 60 * 1000;
/** What the cosigner beside the log calls itself. Not a real address: it is not independent. */
const OWN_COSIGNER_NAME = "cosigner.sealed-room.invalid";

/** A platform session's object is deleted this long after anyone last called it, once it has nothing left to do. */
const SESSION_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;

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
  private table: Promise<Table> | undefined;
  private hosted: Promise<HostedSession> | undefined;
  private scenario: Promise<Scenario> | undefined;
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

  /** A negotiation table, for two parties' own assistants through MCP. Its object holds nothing else. */
  private openTable(): Promise<Table> {
    this.table ??= (async () => {
      const storage = this.ctx.storage;
      const context = await this.roomContext();
      return Table.open({
        mode: context.mode,
        sourceFor: context.sourceFor,
        timeOfRound: context.timeOfRound,
        log: context.log,
        loadState: () => storage.get<TableState>("table"),
        saveState: (state) => storage.put("table", state),
        roundMs: context.simulated ? ROUND_MS_SIMULATED : QUICKNET.period * 1000,
        releaseAfter: context.simulated ? 6 : 3,
      });
    })();
    return this.table;
  }

  /** The object's storage as the platform's small key-value store. */
  private kv(): KV {
    const storage = this.ctx.storage;
    return { get: (key) => storage.get(key), put: (key, value) => storage.put(key, value), delete: async (key) => void (await storage.delete(key)) };
  }

  /** A platform session, in an object of its own named for it. */
  private openSession(): Promise<HostedSession> {
    this.hosted ??= (async () => {
      const context = await this.roomContext();
      const env = this.env;
      return HostedSession.open({
        mode: context.mode,
        sourceFor: context.sourceFor,
        timeOfRound: context.timeOfRound,
        log: context.log,
        roundMs: context.simulated ? ROUND_MS_SIMULATED : QUICKNET.period * 1000,
        releaseAfter: context.simulated ? 6 : 3,
        kv: this.kv(),
        // The integrator's webhooks, from its desk, with their secrets: delivery only.
        webhooks: async (integrator) => {
          const reply = await deskStub(env, integrator).fetch(new Request("https://desk/call", { method: "POST", body: JSON.stringify({ op: "webhook.secrets" } satisfies DeskCall) }));
          return reply.ok ? ((await reply.json()) as { webhooks: Webhook[] }).webhooks : [];
        },
        fetch: async (url, init) => {
          const reply = await fetch(url, { ...init, redirect: "manual", signal: AbortSignal.timeout(10_000) });
          return { ok: reply.ok, status: reply.status };
        },
      });
    })();
    return this.hosted;
  }

  /**
   * The scenario demos (a rental listing, a funding desk), in the visitor's
   * room. They act as an integrator of the platform through its public API,
   * called in this object with a key that exists only here.
   */
  private openScenario(): Promise<Scenario> {
    this.scenario ??= (async () => {
      const storage = this.ctx.storage;
      const context = await this.roomContext();
      const key = `mk_test_${Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("")}`;
      const host = { ...platformHost(this.env, "https://mattering.ai"), integratorOf: async (k: string) => (k === key ? SCENARIO_INTEGRATOR : undefined) };
      return Scenario.open({
        mode: context.mode,
        sourceFor: context.sourceFor,
        apiFetch: (request) => handleApi(request, host),
        apiKey: key,
        loadState: () => storage.get<ScenarioState>("scenario"),
        saveState: (state) => storage.put("scenario", state),
      });
    })();
    return this.scenario;
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
    // Two allowances in one object: model use (in auctions' worth), and new negotiation tables.
    const tables = url.searchParams.get("kind") === "tables";
    const limit = Number(tables ? (this.env.TABLES_PER_DAY ?? DEFAULT_TABLES_PER_DAY) : (this.env.MODEL_AUCTIONS_PER_DAY ?? DEFAULT_MODEL_AUCTIONS_PER_DAY));
    const key = tables ? "budget:tables" : "budget";
    const units = Math.max(1, Math.min(10, Number(url.searchParams.get("units") ?? 1) || 1));
    const today = new Date().toISOString().slice(0, 10);
    const saved = (await this.ctx.storage.get<{ day: string; used: number }>(key)) ?? { day: today, used: 0 };
    const used = saved.day === today ? saved.used : 0;
    const allowed = Number.isFinite(limit) && used + units <= limit;
    if (allowed) await this.ctx.storage.put(key, { day: today, used: used + units });
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
      // A platform session, and an integrator's desk: each in an object of its own, reached only from this Worker.
      if (url.hostname === "session") {
        const req = (await request.json()) as SessionCall;
        const reply = await (await this.openSession()).call(req);
        await this.ctx.storage.put("expires", Date.now() + SESSION_LIFETIME_MS);
        if (req.method === "POST") await this.ctx.storage.setAlarm(Date.now() + 100);
        return respond(reply);
      }
      if (url.hostname === "desk") return respond(await new IntegratorDesk(this.kv()).call((await request.json()) as DeskCall));
      // A negotiation table lives in an object of its own, named for it, and lasts a day after its last use.
      if (url.hostname === "table") {
        const reply = await (await this.openTable()).handle(request.method, url.pathname, () => readBody(request));
        if (request.method === "POST") {
          await this.ctx.storage.put("expires", Date.now() + TABLE_LIFETIME_MS);
          await this.ctx.storage.setAlarm(Date.now() + 100);
        }
        return respond(reply);
      }
      // The scenario demos live in the same visitor's room, under /scenario/.
      if (url.pathname.startsWith("/scenario/")) {
        const reply = await (await this.openScenario()).handle(request.method, url.pathname, () => readBody(request));
        await this.ctx.storage.put("expires", Date.now() + ROOM_LIFETIME_MS);
        if (request.method === "POST") await this.ctx.storage.setAlarm(Date.now() + 100);
        return respond(reply);
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
    if (await this.ctx.storage.get("table")) {
      const wait = await (await this.openTable()).work();
      if (wait !== undefined) waits.push(wait);
    }
    if (await this.ctx.storage.get("scenario")) {
      const wait = await (await this.openScenario()).work();
      if (wait !== undefined) waits.push(wait);
    }
    if (await this.ctx.storage.get("session")) {
      const wait = await (await this.openSession()).work();
      if (wait !== undefined) waits.push(wait);
    }
    if (waits.length > 0) return this.ctx.storage.setAlarm(Date.now() + Math.min(...waits));
    const expires = (await this.ctx.storage.get<number>("expires")) ?? 0;
    if (Date.now() >= expires) {
      await this.ctx.storage.deleteAll();
      this.room = undefined;
      this.negotiation = undefined;
      this.table = undefined;
      this.hosted = undefined;
      this.scenario = undefined;
      return;
    }
    await this.ctx.storage.setAlarm(expires);
  }
}

const ROOM_PATH = /^\/room\/([0-9a-f-]{36})(\/.*)$/;
const TABLE_PATH = /^\/table\/([0-9a-f]{24})(\/negotiation\/.*)$/;
/** A negotiation session's watch routes, as the watch page asks for them. */
const WATCH_PATH = /^\/table\/(ses_[0-9a-f]{24})\/negotiation\/(state|disclosure\/(\d+))$/;

/** The integrator the scenario demos act as, on the platform. */
const SCENARIO_INTEGRATOR = "mattering-demos";

/** The integrator MCP clients' tables and auctions belong to, on the platform. */
const MCP_INTEGRATOR = "mattering-mcp";

/** MCP's tables and auctions: platform sessions, each in a Durable Object named for it. Opening one draws on a daily allowance. */
function mcpBackend(env: Env, origin: string): McpBackend {
  return {
    session: (id) => platformHost(env, origin).session(id),
    integrator: MCP_INTEGRATOR,
    async allow() {
      const perDay = Number(env.TABLES_PER_DAY ?? DEFAULT_TABLES_PER_DAY) || DEFAULT_TABLES_PER_DAY;
      const reply = await deskStub(env, MCP_INTEGRATOR).fetch(new Request("https://desk/call", { method: "POST", body: JSON.stringify({ op: "session.allow", perDay } satisfies DeskCall) }));
      return reply.ok;
    },
    watchUrl: (id) => `${origin}/demo/table?id=${id}`,
    evidenceUrl: (hash) => `${origin}/log/policies/${hash}/evidence`,
    clock: env.SIMULATED === "1" ? "simulated" : "live",
  };
}
const LOG_PATH = /^\/log(\/.*)?$/;
const API_BASE = "/api/v1";

const deskStub = (env: Env, integrator: string) => env.ROOMS.get(env.ROOMS.idFromName(`desk:${integrator}`));

/** API keys from the Worker's secret, `key=integrator` pairs. */
function apiKeys(env: Env): Map<string, string> {
  const pairs = (env.MATTERING_API_KEYS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return new Map(pairs.map((pair) => [pair.slice(0, pair.indexOf("=")).trim(), pair.slice(pair.indexOf("=") + 1).trim()]));
}

/** The platform API's view of this Worker: sessions and desks are Durable Objects, called with JSON. */
function platformHost(env: Env, origin: string): PlatformHost {
  const keys = apiKeys(env);
  const call = (stub: { fetch(request: Request): Promise<Response> }, host: string, req: unknown) =>
    stub.fetch(new Request(`https://${host}/call`, { method: "POST", body: JSON.stringify(req) })).then(async (r) => ({ status: r.status, body: await r.json() }));
  return {
    integratorOf: async (key) => keys.get(key),
    session: (id) => ({ call: (req) => call(env.ROOMS.get(env.ROOMS.idFromName(`session:${id}`)), "session", req) }),
    desk: (name) => ({ call: (req) => call(deskStub(env, name), "desk", req) }),
    base: API_BASE,
    sessionsPerDay: Number(env.SESSIONS_PER_DAY ?? HOST_LIMITS.defaultSessionsPerDay) || HOST_LIMITS.defaultSessionsPerDay,
    evidenceUrl: (hash) => `${origin}/log/policies/${hash}/evidence`,
  };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const room = ROOM_PATH.exec(url.pathname);
    if (room) {
      const stub = env.ROOMS.get(env.ROOMS.idFromName(room[1]!));
      return stub.fetch(new Request(new URL(room[2]! + url.search, url.origin), request));
    }
    // The platform API: sessions for integrators, by API key.
    if (url.pathname === API_BASE || url.pathname.startsWith(`${API_BASE}/`)) return handleApi(request, platformHost(env, url.origin));
    // Mattering as an MCP server, for AI assistants to negotiate at tables.
    if (url.pathname === "/mcp") {
      const reply = await handleMcpHttp(request.method, request.headers, async () => {
        const text = await request.text();
        if (text.length > MAX_BODY) throw new Error("request body too large");
        return text;
      }, mcpBackend(env, url.origin));
      return new Response(reply.body || null, { status: reply.status, headers: reply.headers });
    }
    // Watching a negotiation run through MCP: read-only, as the page polls it.
    const watched = WATCH_PATH.exec(url.pathname);
    if (watched && request.method === "GET") {
      const path = watched[2] === "state" ? "/watch/state" : "/watch/disclosure";
      const reply = await platformHost(env, url.origin).session(watched[1]!).call({ method: "GET", path, query: watched[3] ? { round: watched[3] } : {}, caller: { role: "public" } });
      return json(reply.status, reply.body);
    }
    // Watching a table opened before tables became platform sessions.
    const table = TABLE_PATH.exec(url.pathname);
    if (table && request.method === "GET") {
      return env.ROOMS.get(env.ROOMS.idFromName(`table:${table[1]}`)).fetch(new Request(`https://table${table[2]}`));
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
