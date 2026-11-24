/**
 * The Sealed Room on Cloudflare: a Worker that serves the site's static files
 * and routes /room/<id>/… to a Durable Object holding that visitor's room.
 *
 * Each room is a complete, throwaway deployment: its own witness key, cosigner
 * key, log and auction. Rooms delete themselves after a period of disuse.
 * Demonstration only. The witness and the cosigner run in the same object, so
 * the cosigner is not independent.
 */
import { DurableObject, type DurableObjectState } from "cloudflare:workers";
import { QUICKNET, timeOfRound, type Envelope, type Submission } from "@mattering/core";
import { drandSource } from "@mattering/core/drand-http";
import { TestBeacon, WallTestClock } from "@mattering/core/testing";
import { MAX_BODY, parseBody } from "@mattering/witness/routes";
import type { AnyPolicy, ServiceStore, StoredClosing, StoredState } from "@mattering/witness/service";
import { DEFAULT_MODEL, claudeDecider } from "../../showcase/src/llm.ts";
import { Room, type RoomState } from "../../showcase/src/room.ts";

interface Env {
  ROOMS: { idFromName(name: string): unknown; get(id: unknown): { fetch(request: Request): Promise<Response> } };
  ASSETS: { fetch(request: Request): Promise<Response> };
  /** "1" replaces drand with a clock simulated inside each room. Local development only. */
  SIMULATED?: string;
  /** A Claude API key. With it, a language model decides the agents' bids; without it, their scripts do. */
  ANTHROPIC_API_KEY?: string;
  /** The model to ask. Defaults to the showcase's default. */
  MATTERING_MODEL?: string;
  /** The most auctions per day, across all visitors, that may use the model. Default 300. */
  MODEL_AUCTIONS_PER_DAY?: string;
}

/** The name of the one object that counts model use across every room. Not a room id, so visitors cannot reach it. */
const BUDGET_NAME = "model-budget";
const DEFAULT_MODEL_AUCTIONS_PER_DAY = 300;

/** A room is deleted this long after it was last used. */
const ROOM_LIFETIME_MS = 30 * 60 * 1000;
const ROUND_MS_SIMULATED = 1000;

function durableStore(storage: DurableObjectState["storage"]): ServiceStore {
  const pad = (index: number): string => String(index).padStart(8, "0");
  return {
    async load() {
      const state: StoredState = { entries: [], policies: [], closings: {} };
      const secretKey = await storage.get<string>("witness-key");
      if (secretKey) state.secretKey = secretKey;
      state.entries = [...(await storage.list<Submission>({ prefix: "entry:" })).values()];
      state.policies = [...(await storage.list<AnyPolicy>({ prefix: "policy:" })).values()];
      for (const [key, value] of await storage.list<StoredClosing>({ prefix: "closing:" })) state.closings[key.slice(8)] = value;
      return state;
    },
    saveKey: (secretKey) => storage.put("witness-key", secretKey),
    appendEntry: (index, submission) => storage.put(`entry:${pad(index)}`, submission),
    savePolicy: (hash, policy) => storage.put(`policy:${hash}`, policy),
    saveEnvelope: (id, envelope) => storage.put(`envelope:${id}`, envelope),
    loadEnvelope: (id) => storage.get<Envelope>(`envelope:${id}`),
    saveClosing: (hash, value) => storage.put(`closing:${hash}`, value),
  };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body) + "\n", { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

export class SealedRoom extends DurableObject<Env> {
  private room: Promise<Room> | undefined;

  private open(): Promise<Room> {
    this.room ??= (async () => {
      const storage = this.ctx.storage;
      const simulated = this.env.SIMULATED === "1";
      let clock: WallTestClock | undefined;
      if (simulated) {
        let saved = await storage.get<{ secretHex: string; epoch: number }>("test-clock");
        if (!saved) {
          saved = { secretHex: new TestBeacon().secretHex, epoch: Date.now() - 10 * ROUND_MS_SIMULATED };
          await storage.put("test-clock", saved);
        }
        clock = new WallTestClock(new TestBeacon(saved.secretHex), saved.epoch, ROUND_MS_SIMULATED);
      }
      return Room.open({
        mode: simulated ? "simulated" : "live",
        sourceFor: () => (clock ? clock.source() : drandSource(QUICKNET)),
        timeOfRound: (round) => (clock ? clock.timeOfRound(round) : timeOfRound(QUICKNET, round) * 1000),
        store: durableStore(storage),
        loadState: () => storage.get<RoomState>("room"),
        saveState: (state) => storage.put("room", state),
        closeAfter: simulated ? 30 : 10,
        releaseAfter: simulated ? 15 : 5,
        agentGapMs: 3000,
        maxRuns: 20,
        maxEntries: 12,
        closed: true,
        ...(this.env.ANTHROPIC_API_KEY
          ? {
              decide: claudeDecider({ apiKey: this.env.ANTHROPIC_API_KEY, model: this.env.MATTERING_MODEL ?? DEFAULT_MODEL }),
              // Ask the shared counter before spending anything. If it cannot be reached, don't spend.
              allowModel: async () => {
                const budget = this.env.ROOMS.get(this.env.ROOMS.idFromName(BUDGET_NAME));
                const reply = await budget.fetch(new Request("https://budget/take", { method: "POST" }));
                return reply.ok && ((await reply.json()) as { allowed?: boolean }).allowed === true;
              },
            }
          : {}),
      });
    })();
    return this.room;
  }

  /**
   * The budget object: counts auctions that used the model today, across all
   * rooms, and says no once the day's allowance is spent.
   */
  private async takeFromBudget(): Promise<Response> {
    const limit = Number(this.env.MODEL_AUCTIONS_PER_DAY ?? DEFAULT_MODEL_AUCTIONS_PER_DAY);
    const today = new Date().toISOString().slice(0, 10);
    const saved = (await this.ctx.storage.get<{ day: string; used: number }>("budget")) ?? { day: today, used: 0 };
    const used = saved.day === today ? saved.used : 0;
    const allowed = Number.isFinite(limit) && used < limit;
    if (allowed) await this.ctx.storage.put("budget", { day: today, used: used + 1 });
    return json(200, { allowed, used: allowed ? used + 1 : used, limit });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.hostname === "budget") return this.takeFromBudget();
    try {
      const room = await this.open();
      const reply = await room.handle(request.method, url.pathname, url.searchParams, async () => {
        const text = await request.text();
        if (text.length > MAX_BODY) throw new Error("request body too large");
        return parseBody(text);
      });
      // Work happens in the alarm, never in a visitor's request: an agent's
      // decision can take seconds when a language model makes it.
      await this.ctx.storage.put("expires", Date.now() + ROOM_LIFETIME_MS);
      if (request.method === "POST") await this.ctx.storage.setAlarm(Date.now() + 100);
      return json(reply.status, reply.body);
    } catch (error) {
      console.error(error);
      return json(500, { error: "the demonstration room failed; reload the page" });
    }
  }

  async alarm(): Promise<void> {
    const room = await this.open();
    const wait = await room.work();
    if (wait !== undefined) return this.ctx.storage.setAlarm(Date.now() + wait);
    const expires = (await this.ctx.storage.get<number>("expires")) ?? 0;
    if (Date.now() >= expires) {
      await this.ctx.storage.deleteAll();
      this.room = undefined;
      return;
    }
    await this.ctx.storage.setAlarm(expires);
  }
}

const ROOM_PATH = /^\/room\/([0-9a-f-]{36})(\/.*)$/;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const match = ROOM_PATH.exec(url.pathname);
    if (!match) return env.ASSETS.fetch(request);
    const stub = env.ROOMS.get(env.ROOMS.idFromName(match[1]!));
    return stub.fetch(new Request(new URL(match[2]! + url.search, url.origin), request));
  },
};
