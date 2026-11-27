/**
 * The session engine: one sealed session (in this version, a sealed-bid
 * auction) from creation to result, for the platform API (docs/api-design.md).
 * It holds what the session needs and drives its rounds on the shared witness
 * log; everything a participant or an outsider has to trust is in the log's
 * evidence, which anyone can check with `@mattering/core`.
 *
 * Two ways to seal:
 *
 * - "client": each bidder seals and signs on its own machine and sends only
 *   the envelope and the signed submission. This engine never sees an amount
 *   before release, and cannot bid in anyone's name. With "organiser"
 *   confidentiality it never sees one at all until the organiser discloses.
 * - "server": this engine holds the bidders' keys (and, if the organiser gave
 *   none, the organiser's) and seals for them. For callers that cannot run
 *   code. It could read and forge bids, and every view says so.
 *
 * No server, no files and no timers in here, as in the showcase rooms: the
 * host calls `handle` for requests and `work` when time has passed.
 */
import {
  AUCTION_POLICY_FORMAT,
  generateKeyPair,
  deadlineRound,
  policyHash,
  prepareBid,
  verifyAuction,
  type AuctionInputs,
  type AuctionResult,
  type BeaconInfo,
  type BeaconSource,
  type Envelope,
  type SealedAuctionPolicy,
  type Submission,
} from "@mattering/core";
import { bidOpenerAs, bidOpenerWithFileKeys, discloseBids, generateRecipientKeys, prepareBidTo } from "@mattering/core/recipients";
import type { Reply } from "@mattering/witness/routes";
import type { LogHost } from "../../showcase/src/log-host.ts";

export const SESSION_LIMITS = {
  maxParticipants: 50,
  minBiddingSeconds: 30,
  maxBiddingSeconds: 7 * 24 * 3600,
  defaultBiddingSeconds: 600,
  maxText: 200,
  maxEvents: 500,
} as const;

export type Mechanism = "sealed-bid-auction";
export type Confidentiality = "organiser" | "public";
export type Sealing = "client" | "server";
export type SessionPhase = "created" | "open" | "closed" | "released" | "finished" | "cancelled" | "expired";

/** Who is asking, as the host has established it: the session's integrator, a participant by its token, or anyone. */
export type Caller = { role: "organiser"; integrator: string } | { role: "participant"; token: string } | { role: "public" };

export interface AuctionTerms {
  item: string;
  unit: string;
  minBid: number;
  maxBid: number;
  rule: "highest-bid" | "lowest-bid";
  reserve?: number;
}

interface Invitation {
  code: string;
  role: "bidder";
  label: string;
  /** The participant who used it. An invitation lets one party join, once. */
  usedBy?: string;
}

interface Participant {
  id: string;
  label: string;
  role: "bidder";
  /** Secret: whoever holds it acts for this participant. */
  token: string;
  /** Ed25519 public key that signs this participant's submissions. */
  publicKey: string;
  /** Server-sealed sessions only: the participant's signing key, held here. */
  secretKey?: string;
  joinedAt: number;
}

interface BidRecord {
  participant: string;
  envelopeId: string;
  logIndex: number;
  at: number;
}

interface Round {
  policy: SealedAuctionPolicy;
  hash: string;
  closeAt: number;
  releaseAt: number;
  bids: BidRecord[];
}

export interface SessionOutcome {
  /** No winner if there was no valid bid, or the best did not reach the reserve. */
  winner: { participant: string; label: string; amount: number } | null;
  reserveMet?: boolean;
  /** Every bid, ranked, as the evidence gives them. Who may see which is decided in `view`. */
  bids: { participant: string | null; label: string; amount?: number; status: string; reason?: string }[];
}

export interface SessionEvent {
  n: number;
  type: string;
  at: number;
  data?: Record<string, unknown>;
}

export interface SessionState {
  version: 1;
  id: string;
  /** The integrator that created it: the only organiser. */
  integrator: string;
  mechanism: Mechanism;
  terms: AuctionTerms;
  timing: { opensAt?: number; biddingSeconds: number; quorumBy?: number };
  confidentiality: Confidentiality;
  sealing: Sealing;
  /** The recipient bids are sealed to under "organiser" confidentiality, and its identity if this engine holds it. */
  organiser: { recipient?: string; identity?: string };
  invitations: Invitation[];
  participants: Participant[];
  phase: SessionPhase;
  round?: Round;
  /** File keys the organiser disclosed, by envelope id. */
  disclosure?: Record<string, string>;
  outcome?: SessionOutcome;
  createdAt: number;
  events: SessionEvent[];
}

export interface SessionOptions {
  mode: "live" | "simulated";
  sourceFor: () => BeaconSource;
  timeOfRound: (round: number) => number;
  log: LogHost;
  loadState: () => Promise<SessionState | undefined>;
  saveState: (state: SessionState) => Promise<void>;
  /** Milliseconds per beacon round: 3,000 against drand. */
  roundMs: number;
  /** Beacon rounds from the close to the release. */
  releaseAfter: number;
  /** Tests only: multiplies bidding windows. Default 1. */
  timeScale?: number;
}

/** A refusal with a code the API can pass on, and an HTTP status. */
export class SessionError extends Error {
  constructor(readonly code: string, message: string, readonly status = 409) {
    super(message);
  }
}
const refuse = (code: string, message: string, status = 409): never => {
  throw new SessionError(code, message, status);
};

const randomHex = (bytes: number): string => Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, "0")).join("");
/** A session id: unguessable, safe in a URL and a Durable Object name. */
export const newSessionId = (): string => `ses_${randomHex(12)}`;
const isSessionId = (id: unknown): id is string => typeof id === "string" && /^ses_[0-9a-f]{24}$/.test(id);
/** Tokens and invitations name their session, so a stateless front end knows where to send them. */
export const sessionOf = (code: unknown): string | undefined => {
  const m = typeof code === "string" ? /^(?:tok|inv)_([0-9a-f]{24})_[0-9a-f]{32}$/.exec(code) : null;
  return m ? `ses_${m[1]}` : undefined;
};
const codeFor = (kind: "tok" | "inv", id: string): string => `${kind}_${id.slice(4)}_${randomHex(16)}`;

function text(value: unknown, field: string, fallback?: string): string {
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== "string" || value.trim() === "" || value.length > SESSION_LIMITS.maxText) refuse("invalid", `${field}: want a short line of text`, 400);
  return (value as string).replace(/\s+/g, " ").trim();
}
function whole(value: unknown, field: string, min: number, max: number, fallback?: number): number {
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) refuse("invalid", `${field}: want a whole number from ${min} to ${max}`, 400);
  return value as number;
}
function instant(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  const t = typeof value === "string" ? Date.parse(value) : NaN;
  if (!Number.isFinite(t)) refuse("invalid", `${field}: want an ISO 8601 time`, 400);
  return t;
}

export class Session {
  private busy: Promise<unknown> = Promise.resolve();

  private constructor(
    private readonly options: SessionOptions,
    private readonly viewer: BeaconSource,
    private state: SessionState | undefined,
  ) {}

  static async open(options: SessionOptions): Promise<Session> {
    const state = await options.loadState();
    return new Session(options, options.sourceFor(), state?.version === 1 ? state : undefined);
  }

  get beacon(): BeaconInfo {
    return this.viewer.beacon;
  }
  get exists(): boolean {
    return this.state !== undefined;
  }
  /** Where the session is in its life, or undefined if it does not exist. */
  get phase(): SessionPhase | undefined {
    return this.state?.phase;
  }

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.busy.then(fn);
    this.busy = run.catch(() => {});
    return run;
  }

  private emit(type: string, data?: Record<string, unknown>): void {
    const st = this.state!;
    const n = (st.events.at(-1)?.n ?? 0) + 1;
    st.events.push({ n, type, at: Date.now(), ...(data ? { data } : {}) });
    if (st.events.length > SESSION_LIMITS.maxEvents) st.events.splice(0, st.events.length - SESSION_LIMITS.maxEvents);
  }

  private bidders(): Participant[] {
    return this.state!.participants.filter((p) => p.role === "bidder");
  }

  // --- the organiser ------------------------------------------------------------

  /** Create the session: terms, timing, how bids are sealed and who may read them, and the invitations. */
  create(id: string, integrator: string, input: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.exclusive(async () => {
      if (this.state) refuse("exists", "this session already exists");
      if (!isSessionId(id)) refuse("invalid", "session id: malformed", 400);
      if (input.mechanism !== "sealed-bid-auction") refuse("unsupported", 'mechanism: "sealed-bid-auction" is the one built so far', 400);
      const t = (input.terms ?? {}) as Record<string, unknown>;
      const minBid = whole(t.minBid, "terms.minBid", 0, 1e12);
      const maxBid = whole(t.maxBid, "terms.maxBid", minBid, 1e12);
      const rule = t.rule === "lowest-bid" || t.rule === "highest-bid" ? t.rule : refuse("invalid", 'terms.rule: want "highest-bid" or "lowest-bid"', 400);
      const terms: AuctionTerms = { item: text(t.item, "terms.item"), unit: text(t.unit, "terms.unit"), minBid, maxBid, rule: rule as AuctionTerms["rule"], ...(t.reserve !== undefined ? { reserve: whole(t.reserve, "terms.reserve", minBid, maxBid) } : {}) };
      const timing = (input.timing ?? {}) as Record<string, unknown>;
      const opensAt = instant(timing.opensAt, "timing.opensAt");
      const quorumBy = instant(timing.quorumBy, "timing.quorumBy");
      const confidentiality: Confidentiality = input.confidentiality === "public" ? "public" : input.confidentiality === undefined || input.confidentiality === "organiser" ? "organiser" : refuse("invalid", 'confidentiality: want "organiser" or "public"', 400);
      const sealing: Sealing = input.sealing === "server" ? "server" : input.sealing === undefined || input.sealing === "client" ? "client" : refuse("invalid", 'sealing: want "client" or "server"', 400);
      // Under "organiser" confidentiality the bids are sealed to the organiser's own recipient key. With client
      // sealing it must be the organiser's, so that this engine never holds it; otherwise one is made and held here.
      const organiser: SessionState["organiser"] = {};
      if (confidentiality === "organiser") {
        if (typeof input.organiserRecipient === "string") organiser.recipient = input.organiserRecipient;
        else if (sealing === "client") refuse("invalid", "organiserRecipient: a client-sealed session needs the organiser's own age recipient, so that only the organiser can read the bids", 400);
        else {
          const keys = await generateRecipientKeys();
          organiser.recipient = keys.recipient;
          organiser.identity = keys.identity;
        }
      }
      const invites = Array.isArray(input.invitations) ? (input.invitations as Record<string, unknown>[]) : [];
      if (invites.length < 1 || invites.length > SESSION_LIMITS.maxParticipants) refuse("invalid", `invitations: want 1 to ${SESSION_LIMITS.maxParticipants}`, 400);
      const now = Date.now();
      this.state = {
        version: 1,
        id,
        integrator,
        mechanism: "sealed-bid-auction",
        terms,
        timing: { ...(opensAt !== undefined ? { opensAt } : {}), biddingSeconds: whole(timing.biddingSeconds, "timing.biddingSeconds", SESSION_LIMITS.minBiddingSeconds, SESSION_LIMITS.maxBiddingSeconds, SESSION_LIMITS.defaultBiddingSeconds), ...(quorumBy !== undefined ? { quorumBy } : {}) },
        confidentiality,
        sealing,
        organiser,
        invitations: invites.map((inv, i) => ({ code: codeFor("inv", id), role: "bidder", label: text(inv.label, `invitations[${i}].label`, `Bidder ${i + 1}`) })),
        participants: [],
        phase: "created",
        createdAt: now,
        events: [],
      };
      this.emit("session.created");
      await this.options.saveState(this.state);
      return this.view({ role: "organiser", integrator });
    });
  }

  private organiserOnly(caller: Caller): void {
    if (caller.role !== "organiser" || caller.integrator !== this.state!.integrator) refuse("forbidden", "only the session's organiser may do this", 403);
  }

  /** Open bidding now, rather than at `opensAt`. Needs at least two bidders. */
  openNow(caller: Caller): Promise<Record<string, unknown>> {
    return this.exclusive(async () => {
      this.organiserOnly(caller);
      if (this.state!.phase !== "created") refuse("wrong-phase", `the session is ${this.state!.phase}`);
      if (this.bidders().length < 2) refuse("no-quorum", "at least two bidders must join before bidding opens");
      await this.beginRound();
      await this.options.saveState(this.state!);
      return this.view(caller);
    });
  }

  /** Cancel before the close. Bids already sealed stay sealed; there is no result. */
  cancel(caller: Caller): Promise<Record<string, unknown>> {
    return this.exclusive(async () => {
      this.organiserOnly(caller);
      const st = this.state!;
      if (st.phase !== "created" && st.phase !== "open") refuse("wrong-phase", `a ${st.phase} session cannot be cancelled`);
      st.phase = "cancelled";
      this.emit("session.cancelled");
      await this.options.saveState(st);
      return this.view(caller);
    });
  }

  /**
   * The organiser discloses the file keys of the bids sealed to it, so that the
   * result can be published. Checked here against the evidence: keys that do
   * not open every bid are refused, and the result is what they give.
   */
  disclose(caller: Caller, input: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.exclusive(async () => {
      this.organiserOnly(caller);
      const st = this.state!;
      if (st.phase !== "released") refuse("wrong-phase", st.phase === "finished" ? "the result is already published" : "the bids have not opened yet");
      const keys = input.fileKeys;
      if (keys === null || typeof keys !== "object" || Object.values(keys).some((k) => typeof k !== "string")) refuse("invalid", "fileKeys: want an object of envelope id to file key", 400);
      const outcome = await this.judge(bidOpenerWithFileKeys(keys as Record<string, string>));
      if (!outcome) refuse("incomplete", "those keys do not open every bid: disclose the file key of each");
      st.disclosure = keys as Record<string, string>;
      this.finish(outcome!);
      await this.options.saveState(st);
      return this.view(caller);
    });
  }

  // --- participants -------------------------------------------------------------

  /** Join with an invitation. Client sealing: the participant's own Ed25519 public key. Server sealing: one is made and held here. */
  join(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.exclusive(async () => {
      const st = this.state ?? refuse("not-found", "no session by that invitation", 404);
      const invitation = st.invitations.find((i) => i.code === input.invitation) ?? refuse("not-found", "no such invitation", 404);
      if (invitation.usedBy) refuse("used", "this invitation has been used");
      if (st.phase !== "created" && st.phase !== "open") refuse("wrong-phase", `the session is ${st.phase}`);
      let publicKey: string;
      let secretKey: string | undefined;
      if (st.sealing === "client") {
        if (typeof input.publicKey !== "string" || !/^[0-9a-f]{64}$/.test(input.publicKey)) refuse("invalid", "publicKey: a client-sealed session needs the participant's Ed25519 public key, 64 hex characters", 400);
        publicKey = input.publicKey as string;
        if (st.participants.some((p) => p.publicKey === publicKey)) refuse("duplicate", "that key has already joined");
      } else {
        const keys = generateKeyPair();
        publicKey = keys.publicKey;
        secretKey = keys.secretKey;
      }
      const participant: Participant = { id: `par_${randomHex(8)}`, label: invitation.label, role: invitation.role, token: codeFor("tok", st.id), publicKey, ...(secretKey ? { secretKey } : {}), joinedAt: Date.now() };
      st.participants.push(participant);
      invitation.usedBy = participant.id;
      this.emit("participant.joined", { participant: participant.id, label: participant.label });
      await this.options.saveState(st);
      return { participant: { id: participant.id, label: participant.label, role: participant.role, publicKey }, token: participant.token, session: this.view({ role: "participant", token: participant.token }) };
    });
  }

  private participantOf(caller: Caller): Participant {
    if (caller.role !== "participant") refuse("forbidden", "a participant's token is needed", 403);
    return this.state!.participants.find((p) => p.token === (caller as { token: string }).token) ?? refuse("forbidden", "that token is not for this session", 403);
  }

  /** The current round's policy, which a client-sealed bid must be sealed under. */
  roundPolicy(): Record<string, unknown> {
    const round = this.state?.round ?? refuse("wrong-phase", "bidding has not opened");
    return { policy: round.policy, policyHash: round.hash, closesAt: new Date(round.closeAt).toISOString(), opensAt: new Date(round.releaseAt).toISOString() };
  }

  /**
   * One bid per participant. Client-sealed: `{ submission, envelope }`, signed
   * by the participant's key; the log checks it is sealed as the policy says.
   * Server-sealed: `{ amount }`, sealed here with the key held for it.
   */
  bid(caller: Caller, input: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.exclusive(async () => {
      const st = this.state!;
      const participant = this.participantOf(caller);
      if (st.phase !== "open") refuse(st.phase === "created" ? "not-open" : "late", st.phase === "created" ? "bidding has not opened" : `bidding is ${st.phase}`);
      const round = st.round!;
      if (Date.now() >= round.closeAt) refuse("late", `bidding closed at ${new Date(round.closeAt).toISOString()}`);
      if (round.bids.some((b) => b.participant === participant.id)) refuse("duplicate", "one bid per participant: yours is already sealed");
      let submission: Submission;
      let envelope: Envelope;
      if (st.sealing === "client") {
        if (input.amount !== undefined) refuse("invalid", "this session is client-sealed: send { submission, envelope }, sealed with the SDK; never the amount", 400);
        submission = input.submission as Submission;
        envelope = input.envelope as Envelope;
        if (!submission || !envelope || typeof submission !== "object" || typeof envelope !== "object") refuse("invalid", "want { submission, envelope }", 400);
        if (submission.submitter !== participant.publicKey) refuse("not-a-participant", "the submission is not signed by this participant's key");
        if (submission.policyHash !== round.hash) refuse("invalid", "the submission is not for this round's policy", 400);
      } else {
        const amount = whole(input.amount, "amount", st.terms.minBid, st.terms.maxBid);
        const keys = generateKeyPair(participant.secretKey!);
        const sealed = st.organiser.recipient ? await prepareBidTo(round.policy, amount, keys) : await prepareBid(round.policy, amount, keys);
        submission = sealed.submission;
        envelope = sealed.envelope;
      }
      let receipt;
      try {
        receipt = await this.options.log.submit(submission, envelope);
      } catch (error) {
        // The log refuses anything not signed, not for this policy, not sealed as it says, or late.
        refuse("refused", (error as Error).message);
      }
      round.bids.push({ participant: participant.id, envelopeId: submission.envelopeId, logIndex: receipt!.index, at: Date.now() });
      this.emit("bid.sealed", { participant: participant.id });
      await this.options.saveState(st);
      return { round: 1, receipt, closesAt: new Date(round.closeAt).toISOString(), closeRound: round.policy.closeRound, opensAt: new Date(round.releaseAt).toISOString(), releaseRound: round.policy.releaseRound };
    });
  }

  // --- time passing -------------------------------------------------------------

  private async beginRound(): Promise<void> {
    const st = this.state!;
    const log = await this.options.log.terms();
    const now = (await deadlineRound(this.viewer)).round;
    const closeRound = now + Math.max(1, Math.round((st.timing.biddingSeconds * 1000 * (this.options.timeScale ?? 1)) / this.options.roundMs));
    const releaseRound = closeRound + this.options.releaseAfter;
    const policy: SealedAuctionPolicy = {
      format: AUCTION_POLICY_FORMAT,
      auctionId: st.id,
      unit: st.terms.unit,
      beacon: this.beacon,
      closeRound,
      releaseRound,
      witness: log.witness,
      origin: log.origin,
      logFrom: log.size,
      cosigners: log.cosigners,
      cosignerThreshold: log.cosignerThreshold,
      minBid: st.terms.minBid,
      maxBid: st.terms.maxBid,
      rule: st.terms.rule,
      ...(st.terms.reserve !== undefined ? { reserve: st.terms.reserve } : {}),
      recipients: st.organiser.recipient ? [st.organiser.recipient] : [],
      tieBreak: "release-round-signature",
    };
    const hash = await this.options.log.registerPolicy(policy);
    st.round = { policy, hash, closeAt: this.options.timeOfRound(closeRound), releaseAt: this.options.timeOfRound(releaseRound), bids: [] };
    st.phase = "open";
    this.emit("session.opened", { policyHash: hash, closesAt: new Date(st.round.closeAt).toISOString() });
  }

  /** Work out the outcome from the evidence with `opener`; undefined if it cannot be established. */
  private async judge(opener?: Parameters<typeof verifyAuction>[2]): Promise<SessionOutcome | undefined> {
    const st = this.state!;
    const evidence = (await this.options.log.evidence(st.round!.hash)) as unknown as AuctionInputs;
    const result: AuctionResult = await verifyAuction(evidence, { acceptedBeacons: [this.beacon] }, opener);
    if (!result.ok) return undefined;
    const who = (key: string) => st.participants.find((p) => p.publicKey === key);
    // Valid bids first, best first; then the rest, as the evidence lists them.
    const better = st.terms.rule === "lowest-bid" ? (a: number, b: number) => a - b : (a: number, b: number) => b - a;
    const ranked = [...result.bids.filter((b) => b.status === "valid").sort((a, b) => better(a.amount!, b.amount!)), ...result.bids.filter((b) => b.status !== "valid")];
    const winner = result.winner ? who(result.winner.submitter) : undefined;
    return {
      winner: result.winner ? { participant: winner?.id ?? "", label: winner?.label ?? "An unknown bidder", amount: result.winner.amount } : null,
      ...(result.reserveMet !== undefined ? { reserveMet: result.reserveMet } : {}),
      bids: ranked.map((b) => ({ participant: who(b.submitter)?.id ?? null, label: who(b.submitter)?.label ?? "An unknown bidder", ...(b.amount !== undefined ? { amount: b.amount } : {}), status: b.status, ...(b.reason ? { reason: b.reason } : {}) })),
    };
  }

  private finish(outcome: SessionOutcome): void {
    const st = this.state!;
    st.outcome = outcome;
    st.phase = "finished";
    this.emit("round.result", { winner: outcome.winner?.participant ?? null });
    this.emit("session.finished");
  }

  /**
   * Do whatever is due: open at `opensAt` with a quorum, expire without one,
   * close, and once released publish the result if this engine may read the
   * bids. Returns milliseconds until it wants calling again, or undefined.
   */
  work(): Promise<number | undefined> {
    return this.exclusive(async () => {
      const st = this.state;
      if (!st) return undefined;
      const now = Date.now();
      if (st.phase === "created") {
        const quorum = this.bidders().length >= 2;
        if (st.timing.quorumBy !== undefined && now >= st.timing.quorumBy && !quorum) {
          st.phase = "expired";
          this.emit("session.expired");
          await this.options.saveState(st);
          return undefined;
        }
        if (st.timing.opensAt !== undefined && now >= st.timing.opensAt && quorum) {
          await this.beginRound();
          await this.options.saveState(st);
          return 500;
        }
        const next = [st.timing.opensAt, st.timing.quorumBy].filter((t): t is number => t !== undefined && t > now);
        return next.length ? Math.min(...next) - now : 5_000;
      }
      if (st.phase !== "open" && st.phase !== "closed") return undefined;
      const round = st.round!;
      await this.options.log.tick().catch(() => {});
      if (st.phase === "open" && now >= round.closeAt) {
        st.phase = "closed";
        this.emit("round.closed", { bids: round.bids.length });
        await this.options.saveState(st);
      }
      const phase = await this.options.log.phase(round.hash);
      if (phase.state !== "released") return Math.max(250, Math.min(5_000, (st.phase === "open" ? round.closeAt : round.releaseAt) - now));
      st.phase = "released";
      this.emit("round.released", { releaseRound: round.policy.releaseRound });
      // Publish the result now if this engine can read the bids: public ones, or ones sealed to an organiser key held here.
      if (st.confidentiality === "public" || st.organiser.identity) {
        const outcome = await this.judge(st.organiser.identity ? bidOpenerAs(st.organiser.identity) : undefined);
        if (outcome) {
          if (st.organiser.identity) st.disclosure = await discloseBids((await this.options.log.evidence(round.hash)) as unknown as AuctionInputs, st.organiser.identity, { acceptedBeacons: [this.beacon] });
          this.finish(outcome);
        }
      }
      await this.options.saveState(st);
      return undefined;
    });
  }

  // --- views -----------------------------------------------------------------------

  /** The receipt: what anyone can check the session against. */
  private receipt(): Record<string, unknown> | null {
    const round = this.state?.round;
    if (!round) return null;
    return {
      sessionId: this.state!.id,
      log: { origin: round.policy.origin, witness: round.policy.witness, cosigners: round.policy.cosigners },
      rounds: [{ round: 1, policyHash: round.hash, closeRound: round.policy.closeRound, releaseRound: round.policy.releaseRound, entries: Object.fromEntries(round.bids.map((b) => [b.participant, b.logIndex])) }],
    };
  }

  /**
   * The session as `caller` may see it. The organiser sees everything; a
   * participant sees the terms, its own bid and the result (every bid only if
   * they are public); anyone else sees the terms and whether there is a result.
   */
  view(caller: Caller): Record<string, unknown> {
    const st = this.state ?? refuse("not-found", "no such session", 404);
    const isOrganiser = caller.role === "organiser" && caller.integrator === st.integrator;
    const me = caller.role === "participant" ? st.participants.find((p) => p.token === caller.token) : undefined;
    if (caller.role === "participant" && !me) refuse("forbidden", "that token is not for this session", 403);
    const round = st.round;
    const outcome = st.outcome;
    const allBids = isOrganiser || st.confidentiality === "public";
    return {
      id: st.id,
      environment: "demonstration",
      mechanism: st.mechanism,
      phase: st.phase,
      terms: st.terms,
      confidentiality: st.confidentiality,
      sealing: st.sealing,
      trust: st.sealing === "client" ? "client-sealed: bidders sealed and signed on their own machines; Mattering could not read or forge a bid" : "server-sealed: Mattering held the bidders' keys and sealed for them, so it could have read or forged a bid",
      timing: { ...(st.timing.opensAt ? { opensAt: new Date(st.timing.opensAt).toISOString() } : {}), biddingSeconds: st.timing.biddingSeconds, ...(st.timing.quorumBy ? { quorumBy: new Date(st.timing.quorumBy).toISOString() } : {}) },
      ...(round ? { round: { policyHash: round.hash, closesAt: new Date(round.closeAt).toISOString(), closeRound: round.policy.closeRound, opensAt: new Date(round.releaseAt).toISOString(), releaseRound: round.policy.releaseRound, bids: round.bids.length } } : {}),
      ...(isOrganiser ? { organiserRecipient: st.organiser.recipient ?? null, invitations: st.invitations.map((i) => ({ code: i.usedBy ? null : i.code, label: i.label, joined: i.usedBy !== undefined })), participants: st.participants.map((p) => ({ id: p.id, label: p.label, joined: new Date(p.joinedAt).toISOString(), hasBid: round?.bids.some((b) => b.participant === p.id) ?? false })) } : {}),
      ...(me ? { you: { id: me.id, label: me.label, hasBid: round?.bids.some((b) => b.participant === me.id) ?? false, ...(outcome ? { yourBid: outcome.bids.find((b) => b.participant === me.id) ?? null } : {}) } } : {}),
      ...(st.phase === "released" && st.confidentiality === "organiser" && !st.organiser.identity ? { awaiting: "the organiser's disclosure of the bids' file keys" } : {}),
      ...(outcome ? { outcome: { winner: outcome.winner, ...(outcome.reserveMet !== undefined ? { reserveMet: outcome.reserveMet } : {}), ...(allBids ? { bids: outcome.bids } : {}) } } : {}),
      ...(st.phase === "finished" ? { receipt: this.receipt() } : {}),
    };
  }

  /** Events after `after`, for a host to deliver as webhooks or a stream. */
  events(after: number): SessionEvent[] {
    return (this.state?.events ?? []).filter((e) => e.n > after);
  }

  /** The round's evidence as the log serves it, with the disclosed file keys once published: everything `mattering check-demo` needs. */
  async evidence(): Promise<Record<string, unknown>> {
    const st = this.state ?? refuse("not-found", "no such session", 404);
    if (!st.round) refuse("wrong-phase", "bidding has not opened");
    return { format: "mattering.session-evidence/1", sessionId: st.id, beacon: this.beacon, rounds: [await this.options.log.evidence(st.round!.hash)], ...(st.phase === "finished" && st.disclosure ? { fileKeys: st.disclosure } : {}) };
  }

  /**
   * The engine's own routes, for a host to put behind the API's
   * authentication: `caller` is who the host has established is asking.
   */
  async handle(method: string, path: string, body: () => Promise<unknown>, caller: Caller): Promise<Reply> {
    try {
      const input = async (): Promise<Record<string, unknown>> => {
        const v = await body();
        return v !== null && typeof v === "object" ? (v as Record<string, unknown>) : {};
      };
      const route = `${method} ${path}`;
      if (route === "POST /create") {
        if (caller.role !== "organiser") refuse("forbidden", "an integrator's API key is needed", 403);
        const v = await input();
        return { status: 201, body: await this.create(String(v.id ?? ""), (caller as { integrator: string }).integrator, v) };
      }
      if (!this.state) return { status: 404, body: { error: { code: "not-found", message: "no such session" } } };
      switch (route) {
        case "GET /":
          return { status: 200, body: this.view(caller) };
        case "POST /join":
          return { status: 201, body: await this.join(await input()) };
        case "GET /round":
          return { status: 200, body: this.roundPolicy() };
        case "POST /bids":
          return { status: 201, body: await this.bid(caller, await input()) };
        case "POST /open":
          return { status: 200, body: await this.openNow(caller) };
        case "POST /cancel":
          return { status: 200, body: await this.cancel(caller) };
        case "POST /disclose":
          return { status: 200, body: await this.disclose(caller, await input()) };
        case "GET /evidence":
          return { status: 200, body: await this.evidence() };
        default:
          return { status: 404, body: { error: { code: "not-found", message: "no such route" } } };
      }
    } catch (error) {
      if (error instanceof SessionError) return { status: error.status, body: { error: { code: error.code, message: error.message } } };
      console.error(error);
      return { status: 500, body: { error: { code: "internal", message: "internal error" } } };
    }
  }
}
