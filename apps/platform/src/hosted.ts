/**
 * What a host keeps beside each session and each integrator, independent of
 * where it runs (a Durable Object on Cloudflare, memory in tests):
 *
 * - `HostedSession`: one session's engine, with idempotent requests (a
 *   retried bid is not a second bid) and delivery of its events to the
 *   integrator's webhooks, signed with each webhook's secret.
 * - `IntegratorDesk`: one integrator's webhooks, its daily allowance of new
 *   sessions, and idempotency for creating them.
 *
 * Both are driven by plain JSON requests (`SessionCall`, `DeskCall`), so a
 * host can forward them to wherever the object lives.
 */
import type { Reply } from "@mattering/witness/routes";
import { Session, type Caller, type SessionEvent, type SessionOptions, type SessionState } from "./session.ts";

/** The storage a host gives each object: a small key-value store. */
export interface KV {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
}

export function memoryKV(): KV {
  const map = new Map<string, string>();
  return {
    get: async <T>(key: string) => (map.has(key) ? (JSON.parse(map.get(key)!) as T) : undefined),
    put: async (key, value) => void map.set(key, JSON.stringify(value)),
    delete: async (key) => void map.delete(key),
  };
}

/** One request to a session, as the API forwards it. */
export interface SessionCall {
  method: string;
  path: string;
  query?: Record<string, string>;
  body?: unknown;
  caller: Caller;
  idempotencyKey?: string;
}

export interface Webhook {
  id: string;
  url: string;
  /** Event types to send; all of them if empty. */
  events: string[];
  /** Signs each delivery. Shown once, when the webhook is made. */
  secret: string;
  createdAt: number;
}

export const HOST_LIMITS = {
  /** Idempotent replies kept per session or integrator; the oldest go first. */
  idempotencyKept: 500,
  maxIdempotencyKey: 200,
  webhooksPerIntegrator: 10,
  /** Attempts at one event before a webhook skips it. */
  deliveryAttempts: 8,
  defaultSessionsPerDay: 100,
} as const;

const toHex = (bytes: ArrayBuffer): string => Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");
async function sha256(text: string): Promise<string> {
  return toHex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
}

/**
 * The signature header of a webhook delivery: `t=<unix seconds>,v1=<hex>`,
 * the HMAC-SHA256 of `<t>.<body>` under the webhook's secret. A receiver
 * recomputes it, and refuses deliveries whose `t` is too old.
 */
export async function signDelivery(secret: string, timestamp: number, body: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return `t=${timestamp},v1=${toHex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${timestamp}.${body}`)))}`;
}

/** A receiver's check of a delivery: the signature matches, and it is no older than `toleranceSeconds`. */
export async function verifyDelivery(secret: string, header: string, body: string, toleranceSeconds = 300, now = Date.now()): Promise<boolean> {
  const t = Number(/(?:^|,)t=(\d+)/.exec(header)?.[1]);
  if (!Number.isFinite(t) || Math.abs(now / 1000 - t) > toleranceSeconds) return false;
  const expected = await signDelivery(secret, t, body);
  // Compare in full, without stopping at the first difference.
  if (expected.length !== header.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ header.charCodeAt(i);
  return diff === 0;
}

/** Idempotency: the same key from the same caller returns the first reply; with a different request, a refusal. */
async function idempotent(kv: KV, scope: string, key: string | undefined, request: unknown, run: () => Promise<Reply>): Promise<Reply> {
  if (key === undefined) return run();
  if (key === "" || key.length > HOST_LIMITS.maxIdempotencyKey) return { status: 400, body: { error: { code: "invalid", message: `Idempotency-Key: want 1 to ${HOST_LIMITS.maxIdempotencyKey} characters` } } };
  const name = `idem:${await sha256(`${scope}\n${key}`)}`;
  const fingerprint = await sha256(JSON.stringify(request));
  const saved = await kv.get<{ fingerprint: string; reply: Reply }>(name);
  if (saved) return saved.fingerprint === fingerprint ? saved.reply : { status: 422, body: { error: { code: "idempotency-mismatch", message: "this Idempotency-Key was used for a different request" } } };
  const reply = await run();
  // Refusals that a retry could get past (a busy server, a round not yet open) are not kept.
  if (reply.status < 500 && reply.status !== 429) {
    await kv.put(name, { fingerprint, reply });
    const order = (await kv.get<string[]>("idem-order")) ?? [];
    order.push(name);
    while (order.length > HOST_LIMITS.idempotencyKept) await kv.delete(order.shift()!);
    await kv.put("idem-order", order);
  }
  return reply;
}

const callerKey = (caller: Caller): string => (caller.role === "organiser" ? `org:${caller.integrator}` : caller.role === "participant" ? `tok:${caller.token}` : "public");

export interface HostedSessionOptions extends Omit<SessionOptions, "loadState" | "saveState"> {
  kv: KV;
  /** The integrator's webhooks, with their secrets. */
  webhooks: (integrator: string) => Promise<Webhook[]>;
  /** How deliveries leave. */
  fetch: (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ ok: boolean; status: number }>;
}

interface Cursor {
  /** The last event delivered, or given up on. */
  n: number;
  attempts: number;
  retryAt: number;
}

export class HostedSession {
  private constructor(
    private readonly options: HostedSessionOptions,
    readonly session: Session,
  ) {}

  static async open(options: HostedSessionOptions): Promise<HostedSession> {
    const session = await Session.open({ ...options, loadState: () => options.kv.get<SessionState>("session"), saveState: (s) => options.kv.put("session", s) });
    return new HostedSession(options, session);
  }

  /** One API request. POSTs with an idempotency key return the first reply on a retry. */
  async call(req: SessionCall): Promise<Reply> {
    const run = () => this.session.handle(req.method, req.path, async () => req.body, req.caller, req.query ?? {});
    if (req.method !== "POST") return run();
    return idempotent(this.options.kv, callerKey(req.caller), req.idempotencyKey, [req.method, req.path, req.body ?? null], run);
  }

  /**
   * Whatever is due: the session's own work, then delivering its new events
   * to the integrator's webhooks. Returns milliseconds until it wants calling
   * again, or undefined.
   */
  async work(): Promise<number | undefined> {
    const wait = await this.session.work();
    const retry = await this.deliver();
    const waits = [wait, retry].filter((w): w is number => w !== undefined);
    return waits.length ? Math.min(...waits) : undefined;
  }

  /** Send each webhook the events it has not had, in order, one per request. Returns when to retry, if any failed. */
  async deliver(): Promise<number | undefined> {
    const integrator = this.session.integrator;
    if (!integrator) return undefined;
    const hooks = await this.options.webhooks(integrator);
    const events = this.session.events(0);
    const now = Date.now();
    let retry: number | undefined;
    for (const hook of hooks) {
      const key = `cursor:${hook.id}`;
      // A webhook made after the session hears only what happens from then on.
      const cursor = (await this.options.kv.get<Cursor>(key)) ?? { n: events.filter((e) => e.at < hook.createdAt).at(-1)?.n ?? 0, attempts: 0, retryAt: 0 };
      if (cursor.retryAt > now) {
        retry = Math.min(retry ?? Infinity, cursor.retryAt - now);
        continue;
      }
      for (const event of events.filter((e) => e.n > cursor.n)) {
        if (hook.events.length && !hook.events.includes(event.type)) {
          cursor.n = event.n;
          continue;
        }
        const ok = await this.send(hook, integrator, event);
        if (ok || cursor.attempts + 1 >= HOST_LIMITS.deliveryAttempts) {
          cursor.n = event.n;
          cursor.attempts = 0;
          cursor.retryAt = 0;
          continue;
        }
        cursor.attempts += 1;
        // 2, 4, 8 … seconds, at most five minutes.
        const backoff = Math.min(300_000, 1000 * 2 ** cursor.attempts);
        cursor.retryAt = now + backoff;
        retry = Math.min(retry ?? Infinity, backoff);
        break;
      }
      await this.options.kv.put(key, cursor);
    }
    return retry;
  }

  private async send(hook: Webhook, integrator: string, event: SessionEvent): Promise<boolean> {
    const body = JSON.stringify({ id: `evt_${this.sessionId()}_${event.n}`, type: event.type, sessionId: this.sessionId(), integrator, n: event.n, at: new Date(event.at).toISOString(), environment: "demonstration", ...(event.data ? { data: event.data } : {}) });
    const timestamp = Math.floor(Date.now() / 1000);
    try {
      const reply = await this.options.fetch(hook.url, { method: "POST", headers: { "content-type": "application/json", "mattering-signature": await signDelivery(hook.secret, timestamp, body), "mattering-event": event.type }, body });
      return reply.ok;
    } catch {
      return false;
    }
  }

  private sessionId(): string {
    return (this.session.view({ role: "public" }) as { id: string }).id;
  }
}

/** One request to an integrator's desk. */
export type DeskCall =
  | { op: "webhook.create"; url: unknown; events?: unknown }
  | { op: "webhook.list" }
  | { op: "webhook.delete"; id: string }
  /** The host's own use: the webhooks with their secrets, for delivery. Never forwarded from the API. */
  | { op: "webhook.secrets" }
  | { op: "session.allow"; perDay: number }
  | { op: "idem.get"; key: string; fingerprint: string }
  | { op: "idem.put"; key: string; fingerprint: string; reply: Reply };

const EVENT_TYPES = ["session.created", "participant.joined", "round.opened", "bid.sealed", "round.closed", "round.released", "round.result", "session.finished", "session.cancelled", "session.expired"];

export class IntegratorDesk {
  constructor(private readonly kv: KV) {}

  async call(req: DeskCall): Promise<Reply> {
    const hooks = (await this.kv.get<Webhook[]>("webhooks")) ?? [];
    const shown = (h: Webhook) => ({ id: h.id, url: h.url, events: h.events, createdAt: new Date(h.createdAt).toISOString() });
    switch (req.op) {
      case "webhook.create": {
        let url: URL;
        try {
          url = new URL(String(req.url));
        } catch {
          return { status: 400, body: { error: { code: "invalid", message: "url: want an https URL" } } };
        }
        if (url.protocol !== "https:") return { status: 400, body: { error: { code: "invalid", message: "url: want an https URL" } } };
        const events = req.events === undefined ? [] : req.events;
        if (!Array.isArray(events) || events.some((e) => !EVENT_TYPES.includes(e as string))) return { status: 400, body: { error: { code: "invalid", message: `events: want a list from ${EVENT_TYPES.join(", ")}` } } };
        if (hooks.length >= HOST_LIMITS.webhooksPerIntegrator) return { status: 409, body: { error: { code: "limit", message: `at most ${HOST_LIMITS.webhooksPerIntegrator} webhooks` } } };
        const hook: Webhook = { id: `whk_${randomHex(8)}`, url: url.toString(), events: events as string[], secret: `whsec_${randomHex(24)}`, createdAt: Date.now() };
        await this.kv.put("webhooks", [...hooks, hook]);
        return { status: 201, body: { ...shown(hook), secret: hook.secret, note: "Keep the secret: it signs every delivery (Mattering-Signature) and is not shown again." } };
      }
      case "webhook.list":
        return { status: 200, body: { webhooks: hooks.map(shown) } };
      case "webhook.delete": {
        if (!hooks.some((h) => h.id === req.id)) return { status: 404, body: { error: { code: "not-found", message: "no such webhook" } } };
        await this.kv.put("webhooks", hooks.filter((h) => h.id !== req.id));
        return { status: 200, body: { deleted: req.id } };
      }
      case "webhook.secrets":
        return { status: 200, body: { webhooks: hooks } };
      case "session.allow": {
        const today = new Date().toISOString().slice(0, 10);
        const saved = (await this.kv.get<{ day: string; used: number }>("allowance")) ?? { day: today, used: 0 };
        const used = saved.day === today ? saved.used : 0;
        if (used >= req.perDay) return { status: 429, body: { error: { code: "limit", message: `today's allowance of ${req.perDay} new sessions is used up` } } };
        await this.kv.put("allowance", { day: today, used: used + 1 });
        return { status: 200, body: { allowed: true, used: used + 1, perDay: req.perDay } };
      }
      case "idem.get": {
        const saved = await this.kv.get<{ fingerprint: string; reply: Reply }>(`idem:${req.key}`);
        if (!saved) return { status: 404, body: {} };
        return saved.fingerprint === req.fingerprint ? { status: 200, body: saved.reply } : { status: 422, body: { error: { code: "idempotency-mismatch", message: "this Idempotency-Key was used for a different request" } } };
      }
      case "idem.put": {
        await this.kv.put(`idem:${req.key}`, { fingerprint: req.fingerprint, reply: req.reply });
        const order = (await this.kv.get<string[]>("idem-order")) ?? [];
        order.push(req.key);
        while (order.length > HOST_LIMITS.idempotencyKept) await this.kv.delete(`idem:${order.shift()!}`);
        await this.kv.put("idem-order", order);
        return { status: 200, body: {} };
      }
    }
  }
}

const randomHex = (bytes: number): string => Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, "0")).join("");
export { sha256 };
