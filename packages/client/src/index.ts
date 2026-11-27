/**
 * @mattering/client: the platform API from your own code, sealing locally.
 *
 *   const mattering = new Mattering({ apiKey: process.env.MATTERING_KEY });
 *   const bidder = await mattering.join("inv_…");   // makes and keeps the bidder's keys
 *   await bidder.bid(640);                          // sealed here; only the envelope leaves
 *   const result = await bidder.result();           // waits for the release
 *   const checked = await bidder.verify();          // recomputes it from the evidence
 *
 * What it does not take on trust from the server:
 *
 * - the beacon: it seals only to beacons you accept (drand quicknet unless you
 *   say otherwise), so a server cannot have bids sealed to a clock it runs;
 * - the policy: it must name this session, this participant's own keys, and
 *   seal bids as the session's confidentiality says;
 * - the result: `verify` works it out from the log's evidence with
 *   `@mattering/core` and says whether it matches what the server reported.
 *
 * Keys stay in this process. `secrets()` returns them for you to store, and
 * `resume` picks a session up again from them.
 */
import {
  QUICKNET,
  generateKeyPair,
  issueMandate,
  prepareBid,
  sameBeacon,
  verifyAuction,
  type AuctionInputs,
  type BeaconInfo,
  type KeyPair,
  type Mandate,
  type MandateOpening,
  type NegotiationPolicy,
  type SealedAuctionPolicy,
  type Side,
  type VerifierPolicy,
} from "@mattering/core";
import { discloseStep, prepareOffer, verifyNegotiation, withFileKeys, type StepInputs } from "@mattering/core/negotiation";
import { bidOpenerAs, bidOpenerWithFileKeys, discloseBids, generateRecipientKeys, prepareBidTo } from "@mattering/core/recipients";

export const DEFAULT_BASE_URL = "https://mattering.ai/api/v1";

export interface MatteringOptions {
  /** An integrator's API key. Needed to create sessions and to act as their organiser; not to join one. */
  apiKey?: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  /** Beacons a policy may seal to. Default: drand quicknet. */
  acceptedBeacons?: BeaconInfo[];
  /** How often to look while waiting. Default 2 seconds. */
  pollMs?: number;
  /** Attempts per request on a network failure, a 5xx or a 429, with the same Idempotency-Key. Default 4. */
  attempts?: number;
}

/** A refusal from the API, with its code (`late`, `duplicate`, `beyond-mandate`, …). */
export class MatteringApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "MatteringApiError";
  }
}

/** A session as the API shows it to the caller. */
export interface SessionView {
  id: string;
  environment: string;
  mechanism: "sealed-bid-auction" | "negotiation" | "limit-match";
  phase: "created" | "open" | "closed" | "released" | "finished" | "cancelled" | "expired";
  terms: Record<string, unknown>;
  confidentiality: "organiser" | "parties" | "public";
  sealing: "client" | "server";
  trust: string;
  round?: { round: number; policyHash: string; closesAt: string; opensAt: string; bids: number };
  you?: { id: string; label: string; role: string; hasBid: boolean; limit?: number };
  awaiting?: string;
  outcome?: Record<string, unknown>;
  receipt?: Record<string, unknown>;
  invitations?: { code: string | null; role: string; label: string; joined: boolean }[];
  [key: string]: unknown;
}

export interface SessionResult {
  id: string;
  phase: string;
  outcome: Record<string, unknown> | null;
  receipt: Record<string, unknown> | null;
  disclosure?: { fileKeys: Record<string, string> };
  awaiting?: string;
}

/** Every round's evidence from the public log, and the file keys of the opened bids where the caller may read them. */
export interface EvidenceBundle {
  format: string;
  sessionId: string;
  mechanism: SessionView["mechanism"];
  rounds: unknown[];
  fileKeys?: Record<string, string>;
}

export interface Verification {
  /** The evidence checks out and every bid in it could be judged. */
  ok: boolean;
  /** What the evidence gives, worked out here. */
  outcome?: { winner: { submitter: string; amount: number } | null; reserveMet?: boolean } | { deal: boolean; price?: number; round: number; reason?: string };
  /** Whether the server's reported outcome says the same. Undefined if there was nothing to compare. */
  matchesReported?: boolean;
  /** Why it is not ok, in a line. */
  problem?: string;
}

/** What to keep to pick a participant's session up again. Secret: it can bid in the participant's name. */
export interface ParticipantSecrets {
  kind: "participant";
  sessionId: string;
  token: string;
  role: string;
  signingKey?: string;
  identity?: string;
  recipient?: string;
  opening?: MandateOpening;
}

/** What to keep to pick an organiser's session up again: its age identity, if the bids are sealed to it. */
export interface OrganiserSecrets {
  kind: "organiser";
  sessionId: string;
  identity?: string;
}

export interface JoinOptions {
  /**
   * Negotiations: this side's limit. Server-sealed: required; the server
   * issues the mandate and holds it. Client-sealed with `organisation`: a
   * mandate is issued here, signed with the organisation's key.
   */
  limit?: number;
  /** Client-sealed negotiations: the organisation's key and name, to issue this agent's mandate here. */
  organisation?: { keys: KeyPair; name: string; expires?: number };
  /** Client-sealed negotiations: a mandate already issued for `signingKey`, and its opening. */
  mandate?: { mandate: Mandate; opening: MandateOpening; signingKey: string };
}

const ID = /^(?:tok|inv)_([0-9a-f]{24})_[0-9a-f]{32}$/;
const sessionOf = (code: string): string => {
  const m = ID.exec(code);
  if (!m) throw new MatteringApiError("invalid", "not an invitation or token from Mattering", 400);
  return `ses_${m[1]}`;
};
const randomKey = (): string => Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, "0")).join("");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ENDED = ["finished", "cancelled", "expired"];

class Api {
  constructor(private readonly options: Required<Pick<MatteringOptions, "baseUrl" | "attempts">> & { fetch: typeof fetch }) {}

  async request<T>(method: string, path: string, opts: { auth?: string | undefined; body?: unknown; idempotent?: boolean } = {}): Promise<T> {
    const headers: Record<string, string> = { accept: "application/json" };
    if (opts.auth) headers.authorization = `Bearer ${opts.auth}`;
    if (opts.body !== undefined) headers["content-type"] = "application/json";
    // Every POST carries a key, so that a retry after a lost reply is the same request, not a second one.
    if (method === "POST" && opts.idempotent !== false) headers["idempotency-key"] = randomKey();
    let last: unknown;
    for (let attempt = 0; attempt < this.options.attempts; attempt++) {
      if (attempt > 0) await sleep(250 * 2 ** attempt);
      let response: Response;
      try {
        response = await this.options.fetch(`${this.options.baseUrl}${path}`, { method, headers, ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}) });
      } catch (error) {
        last = error;
        continue;
      }
      const body = (await response.json().catch(() => ({}))) as { error?: { code: string; message: string } };
      if (response.ok) return body as T;
      const error = new MatteringApiError(body.error?.code ?? "http", body.error?.message ?? `HTTP ${response.status}`, response.status);
      if (response.status < 500 && response.status !== 429) throw error;
      last = error;
    }
    throw last instanceof Error ? last : new Error(String(last));
  }
}

export class Mattering {
  private readonly api: Api;
  readonly verifier: VerifierPolicy;
  readonly pollMs: number;

  constructor(private readonly options: MatteringOptions = {}) {
    this.api = new Api({ baseUrl: (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, ""), attempts: options.attempts ?? 4, fetch: options.fetch ?? fetch.bind(globalThis) });
    this.verifier = { acceptedBeacons: options.acceptedBeacons ?? [QUICKNET] };
    this.pollMs = options.pollMs ?? 2000;
  }

  /** @internal As the organiser, with the API key. */
  asOrganiser<T>(method: string, path: string, body?: unknown): Promise<T> {
    return this.api.request<T>(method, path, { auth: this.needKey(), ...(body !== undefined ? { body } : {}) });
  }

  /** @internal */
  request<T>(method: string, path: string, opts: { auth?: string | undefined; body?: unknown } = {}): Promise<T> {
    return this.api.request<T>(method, path, opts);
  }

  private needKey(): string {
    if (!this.options.apiKey) throw new MatteringApiError("unauthorised", "this needs an integrator's API key: new Mattering({ apiKey })", 401);
    return this.options.apiKey;
  }

  readonly sessions = {
    /**
     * Create a session as its organiser. A client-sealed auction under
     * "organiser" confidentiality (the defaults) needs the organiser's own age
     * key: give `organiserRecipient`, or one is made here and kept in the
     * returned session, never sent.
     */
    create: async (input: Record<string, unknown>): Promise<OrganiserSession> => {
      const auction = input.mechanism === "sealed-bid-auction";
      const ownKey = auction && (input.sealing ?? "client") === "client" && (input.confidentiality ?? "organiser") === "organiser" && input.organiserRecipient === undefined;
      const keys = ownKey ? await generateRecipientKeys() : undefined;
      const view = await this.request<SessionView>("POST", "/sessions", { auth: this.needKey(), body: { ...input, ...(keys ? { organiserRecipient: keys.recipient } : {}) } });
      return new OrganiserSession(this, view.id, view, keys?.identity);
    },
    /** A session this integrator organises, by id; with its age identity if the bids are sealed to it. */
    get: async (id: string, identity?: string): Promise<OrganiserSession> => new OrganiserSession(this, id, await this.request<SessionView>("GET", `/sessions/${id}`, { auth: this.needKey() }), identity),
  };

  readonly webhooks = {
    create: (url: string, events?: string[]) => this.request<{ id: string; url: string; secret: string }>("POST", "/webhooks", { auth: this.needKey(), body: { url, ...(events ? { events } : {}) } }),
    list: () => this.request<{ webhooks: { id: string; url: string; events: string[] }[] }>("GET", "/webhooks", { auth: this.needKey() }),
    delete: (id: string) => this.request<{ deleted: string }>("DELETE", `/webhooks/${id}`, { auth: this.needKey() }),
  };

  /**
   * Join a session with an invitation. Client-sealed: a signing key is made
   * here (and for negotiations an age key, and a mandate if you give the
   * organisation's key), and only the public halves are sent.
   */
  async join(invitation: string, options: JoinOptions = {}): Promise<Participant> {
    const sessionId = sessionOf(invitation);
    const before = await this.request<SessionView>("GET", `/sessions/${sessionId}`);
    const negotiation = before.mechanism !== "sealed-bid-auction";
    const body: Record<string, unknown> = { invitation };
    const secrets: Omit<ParticipantSecrets, "token" | "role"> = { kind: "participant", sessionId };
    if (before.sealing === "server") {
      if (negotiation) {
        if (options.limit === undefined) throw new MatteringApiError("invalid", "a server-sealed negotiation needs this side's limit: join(invitation, { limit })", 400);
        body.limit = options.limit;
      }
    } else {
      const signer = options.mandate ? generateKeyPair(options.mandate.signingKey) : generateKeyPair();
      secrets.signingKey = signer.secretKey;
      body.publicKey = signer.publicKey;
      if (negotiation) {
        const box = await generateRecipientKeys();
        secrets.identity = box.identity;
        secrets.recipient = box.recipient;
        body.recipient = box.recipient;
        if (options.mandate) {
          body.mandate = options.mandate.mandate;
          secrets.opening = options.mandate.opening;
        } else if (options.organisation) {
          if (options.limit === undefined) throw new MatteringApiError("invalid", "issuing a mandate needs this side's limit", 400);
          // A mandate names the side; the invitation says which.
          const { role } = await this.request<{ role: Side }>("GET", `/sessions/${sessionId}/invitation?code=${encodeURIComponent(invitation)}`);
          const issued = issueMandate(options.organisation.keys, {
            organisationName: options.organisation.name,
            agent: signer.publicKey,
            side: role,
            unit: String(before.terms.unit),
            limit: options.limit,
            expires: options.organisation.expires ?? Math.floor(Date.now() / 1000) + 30 * 24 * 3600,
          });
          body.mandate = issued.mandate;
          secrets.opening = issued.opening;
        }
      }
    }
    const joined = await this.request<{ token: string; participant: { role: string } }>("POST", "/join", { body });
    return new Participant(this, { ...secrets, token: joined.token, role: joined.participant.role }, before);
  }

  /** Pick up a participant's session from its secrets. */
  resume(secrets: ParticipantSecrets): Participant;
  /** Pick up an organiser's session from its secrets. Needs the API key. */
  resume(secrets: OrganiserSecrets): OrganiserSession;
  resume(secrets: ParticipantSecrets | OrganiserSecrets): Participant | OrganiserSession {
    return secrets.kind === "participant" ? new Participant(this, secrets) : new OrganiserSession(this, secrets.sessionId, undefined, secrets.identity);
  }

  /**
   * Work the outcome out from the evidence, trusting no one: with the file
   * keys in the bundle (or the organiser's identity), on the beacons this
   * client accepts. Given what the server reported, says whether it matches.
   */
  async verify(bundle: EvidenceBundle, reported?: Record<string, unknown> | null, identity?: string): Promise<Verification> {
    if (bundle.rounds.length === 0) return { ok: false, problem: "no rounds in the evidence" };
    if (bundle.mechanism === "sealed-bid-auction") {
      const inputs = bundle.rounds[0] as AuctionInputs;
      const opener = bundle.fileKeys ? bidOpenerWithFileKeys(bundle.fileKeys) : identity ? bidOpenerAs(identity) : undefined;
      const result = await verifyAuction(inputs, this.verifier, opener);
      if (!result.ok) return { ok: false, problem: result.checks.find((c) => !c.ok)?.name ?? "the evidence does not check out" };
      const outcome = { winner: result.winner ? { submitter: result.winner.submitter, amount: result.winner.amount } : null, ...(result.reserveMet !== undefined ? { reserveMet: result.reserveMet } : {}) };
      const said = reported as { winner?: { amount: number } | null; reserveMet?: boolean } | null | undefined;
      return { ok: true, outcome, ...(said ? { matchesReported: (said.winner?.amount ?? null) === (outcome.winner?.amount ?? null) && said.reserveMet === outcome.reserveMet } : {}) };
    }
    if (!bundle.fileKeys) return { ok: false, problem: "no file keys: only the parties, or those they disclose to, can open the offers" };
    const result = await verifyNegotiation(bundle.rounds as StepInputs[], withFileKeys(bundle.fileKeys), this.verifier);
    if (!result.ok || !result.outcome) return { ok: false, problem: result.problem ?? "the evidence does not check out" };
    const o = result.outcome;
    const outcome = o.deal ? { deal: true, price: o.price, round: o.step } : { deal: false, round: o.step, reason: o.reason };
    const said = reported as { deal?: boolean; price?: number; round?: number } | null | undefined;
    return { ok: true, outcome, ...(said ? { matchesReported: said.deal === outcome.deal && said.round === outcome.round && (said.price ?? null) === (outcome.price ?? null) } : {}) };
  }

  /** @internal Wait until `done` gives a value, looking every `pollMs`. */
  async until<T>(look: () => Promise<T | undefined>, timeoutMs = 24 * 3600 * 1000): Promise<T> {
    const end = Date.now() + timeoutMs;
    for (;;) {
      const value = await look();
      if (value !== undefined) return value;
      if (Date.now() > end) throw new MatteringApiError("timeout", "gave up waiting", 408);
      await sleep(this.pollMs);
    }
  }
}

/** What a participant should do next. */
export type Next = { kind: "bid"; round: number; closesAt: string } | { kind: "finished"; result: SessionResult } | { kind: "ended"; phase: "cancelled" | "expired" };

export class Participant {
  constructor(
    private readonly mattering: Mattering,
    private readonly saved: ParticipantSecrets,
    private cached?: SessionView,
  ) {}

  get sessionId(): string {
    return this.saved.sessionId;
  }
  get role(): string {
    return this.saved.role;
  }
  /** Everything needed to resume. Secret. */
  secrets(): ParticipantSecrets {
    return { ...this.saved };
  }

  private get(path: string) {
    return this.mattering.request<never>("GET", `/sessions/${this.sessionId}${path}`, { auth: this.saved.token });
  }
  private post<T>(path: string, body?: unknown) {
    return this.mattering.request<T>("POST", `/sessions/${this.sessionId}${path}`, { auth: this.saved.token, body: body ?? {} });
  }

  async state(): Promise<SessionView> {
    this.cached = await this.get("");
    return this.cached;
  }

  checkIn(): Promise<SessionView> {
    return this.post("/check-in");
  }
  /** Walk away from a negotiation. */
  leave(): Promise<SessionView> {
    return this.post("/cancel");
  }

  /** The round's policy, checked before anything is sealed under it. */
  private async policy(view: SessionView): Promise<SealedAuctionPolicy | NegotiationPolicy> {
    const { policy } = (await this.get("/round")) as { policy: SealedAuctionPolicy | NegotiationPolicy };
    const accepted = this.mattering.verifier.acceptedBeacons;
    if (!accepted.some((b) => sameBeacon(b, policy.beacon))) throw new MatteringApiError("untrusted-policy", "the round's policy seals to a beacon this client does not accept", 0);
    if ("auctionId" in policy) {
      if (policy.auctionId !== this.sessionId) throw new MatteringApiError("untrusted-policy", "the round's policy is for another auction", 0);
      if ((view.confidentiality === "public") !== (policy.recipients.length === 0)) throw new MatteringApiError("untrusted-policy", `the session says ${view.confidentiality} but the policy ${policy.recipients.length ? "seals the bids to named recipients" : "opens the bids to everyone"}`, 0);
    } else {
      if (policy.negotiationId !== this.sessionId) throw new MatteringApiError("untrusted-policy", "the round's policy is for another negotiation", 0);
      const me = policy[this.role as Side];
      if (this.saved.recipient && me.recipient !== this.saved.recipient) throw new MatteringApiError("untrusted-policy", "the round's policy does not seal offers to this side's own key", 0);
    }
    return policy;
  }

  /** Seal a bid (auctions) and submit it. Client-sealed: sealed here, and only the envelope and signature leave. */
  async bid(amount: number): Promise<Record<string, unknown>> {
    const view = await this.state();
    if (view.sealing === "server") return this.post("/bids", { amount });
    const policy = (await this.policy(view)) as SealedAuctionPolicy;
    const keys = generateKeyPair(this.saved.signingKey!);
    return this.post("/bids", policy.recipients.length ? await prepareBidTo(policy, amount, keys) : await prepareBid(policy, amount, keys));
  }

  /** Seal an offer (negotiations) for the current round and submit it. Refused here first if beyond this side's mandate. */
  async offer(price: number): Promise<Record<string, unknown>> {
    const view = await this.state();
    if (view.sealing === "server") return this.post("/bids", { price });
    const policy = (await this.policy(view)) as NegotiationPolicy;
    return this.post("/bids", await prepareOffer(policy, this.role as Side, price, generateKeyPair(this.saved.signingKey!), this.saved.opening));
  }

  /** Disclose the opened round's file keys, if the session is waiting for a side to. Harmless if the other side got there first. */
  private async discloseIfAsked(view: SessionView): Promise<boolean> {
    if (view.phase !== "released" || !this.saved.identity || !view.awaiting) return false;
    const bundle = (await this.get("/evidence")) as EvidenceBundle;
    const fileKeys = await discloseStep(bundle.rounds.at(-1) as StepInputs, this.saved.identity, this.mattering.verifier);
    try {
      await this.post("/disclose", { fileKeys });
    } catch (error) {
      if (!(error instanceof MatteringApiError && error.code === "wrong-phase")) throw error;
    }
    return true;
  }

  /**
   * Wait until there is something to do: a round to bid in, or the end.
   * Discloses opened rounds along the way where this side holds the key.
   */
  next(): Promise<Next> {
    return this.mattering.until(async () => {
      const view = await this.state();
      if (await this.discloseIfAsked(view)) return undefined;
      if (view.phase === "finished") return { kind: "finished", result: await this.result() } as Next;
      if (view.phase === "cancelled" || view.phase === "expired") return { kind: "ended", phase: view.phase } as Next;
      const selfSealing = view.mechanism === "limit-match" && view.sealing === "server";
      if (view.phase === "open" && view.round && !view.you?.hasBid && !selfSealing && Date.parse(view.round.closesAt) > Date.now()) return { kind: "bid", round: view.round.round, closesAt: view.round.closesAt } as Next;
      return undefined;
    });
  }

  /** Wait for the result, disclosing along the way where asked. */
  async result(): Promise<SessionResult> {
    return this.mattering.until(async () => {
      const view = await this.state();
      if (await this.discloseIfAsked(view)) return undefined;
      if (!ENDED.includes(view.phase)) return undefined;
      return (await this.get("/result")) as SessionResult;
    });
  }

  /** Check the result against the evidence, with the keys this participant may have. */
  async verify(): Promise<Verification> {
    const [bundle, result] = await Promise.all([this.get("/evidence") as Promise<EvidenceBundle>, this.get("/result") as Promise<SessionResult>]);
    return this.mattering.verify(bundle, result.outcome, this.saved.identity);
  }
}

export class OrganiserSession {
  constructor(
    private readonly mattering: Mattering,
    readonly id: string,
    private cached: SessionView | undefined,
    private readonly identity?: string,
  ) {}

  /** The invitations to hand out, as the session was created. */
  get invitations(): { code: string | null; role: string; label: string; joined: boolean }[] {
    return this.cached?.invitations ?? [];
  }
  secrets(): OrganiserSecrets {
    return { kind: "organiser", sessionId: this.id, ...(this.identity ? { identity: this.identity } : {}) };
  }

  private call<T>(method: string, path: string, body?: unknown): Promise<T> {
    return this.mattering.asOrganiser<T>(method, `/sessions/${this.id}${path}`, body);
  }

  async state(): Promise<SessionView> {
    this.cached = await this.call<SessionView>("GET", "");
    return this.cached;
  }
  open(): Promise<SessionView> {
    return this.call("POST", "/open", {});
  }
  cancel(): Promise<SessionView> {
    return this.call("POST", "/cancel", {});
  }
  events(after = 0): Promise<{ events: { n: number; type: string; at: number; data?: Record<string, unknown> }[]; last: number; phase: string }> {
    return this.call("GET", `/events?after=${after}`);
  }
  evidence(): Promise<EvidenceBundle> {
    return this.call("GET", "/evidence");
  }

  /** Open the bids sealed to this organiser here, and disclose their file keys so the result is published. */
  async disclose(): Promise<SessionView> {
    if (!this.identity) throw new MatteringApiError("no-identity", "the bids are sealed to the organiser's age key, which this client does not hold", 0);
    const bundle = await this.evidence();
    return this.call("POST", "/disclose", { fileKeys: await discloseBids(bundle.rounds[0] as AuctionInputs, this.identity, this.mattering.verifier) });
  }

  /** Wait for the result; if it waits on this organiser's disclosure and the key is here, disclose. */
  result(): Promise<SessionResult> {
    return this.mattering.until(async () => {
      const view = await this.state();
      if (view.phase === "released" && view.awaiting && this.identity && view.mechanism === "sealed-bid-auction") {
        await this.disclose();
        return undefined;
      }
      if (!ENDED.includes(view.phase)) return undefined;
      return this.call<SessionResult>("GET", "/result");
    });
  }

  async verify(): Promise<Verification> {
    const [bundle, result] = await Promise.all([this.evidence(), this.call<SessionResult>("GET", "/result")]);
    return this.mattering.verify(bundle, result.outcome, this.identity);
  }
}
