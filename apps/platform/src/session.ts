/**
 * The session engine: one sealed session from creation to result, for the
 * platform API (docs/api-design.md). Three mechanisms:
 *
 * - "sealed-bid-auction": one round; many bidders; highest or lowest wins.
 * - "negotiation": a buyer and a seller seal one offer each per round, up to
 *   an agreed number of rounds; if the buyer's is at least the seller's, the
 *   deal is at the midpoint.
 * - "limit-match": a negotiation of one round in which each side seals only
 *   its limit, so the result depends on the limits and not on bargaining.
 *
 * The engine holds what the session needs and drives its rounds on the shared
 * witness log; everything a participant or an outsider has to trust is in the
 * log's evidence, which anyone can check with `@mattering/core`.
 *
 * Two ways to seal:
 *
 * - "client": each participant seals and signs on its own machine and sends
 *   only the envelope and the signed submission. This engine never sees an
 *   amount before release and cannot bid in anyone's name. Where bids are
 *   sealed to the organiser (auctions) or to the two parties (negotiations),
 *   it sees them only once someone who can open them discloses their keys,
 *   which it checks against the evidence.
 * - "server": this engine holds the participants' keys (and their mandates'
 *   limits) and seals for them. For callers that cannot run code. It could
 *   read and forge bids, and every view says so.
 *
 * No server, no files and no timers in here, as in the showcase rooms: the
 * host calls `handle` for requests and `work` when time has passed.
 */
import {
  AUCTION_POLICY_FORMAT,
  NEGOTIATION_POLICY_FORMAT,
  closeTime,
  deadlineRound,
  generateKeyPair,
  isRecipient,
  issueMandate,
  mandateProblem,
  prepareBid,
  verifyAuction,
  type AuctionInputs,
  type AuctionResult,
  type BeaconInfo,
  type BeaconSource,
  type Envelope,
  type Mandate,
  type MandateOpening,
  type NegotiationPolicy,
  type SealedAuctionPolicy,
  type Side,
  type Submission,
} from "@mattering/core";
import { asParty, discloseStep, prepareOffer, verifyNegotiationStep, withFileKeys, type StepInputs, type StepOutcome } from "@mattering/core/negotiation";
import { bidOpenerAs, bidOpenerWithFileKeys, discloseBids, generateRecipientKeys, prepareBidTo } from "@mattering/core/recipients";
import type { Reply } from "@mattering/witness/routes";
import type { LogHost } from "../../showcase/src/log-host.ts";

export const SESSION_LIMITS = {
  maxParticipants: 50,
  minBiddingSeconds: 30,
  maxBiddingSeconds: 7 * 24 * 3600,
  defaultBiddingSeconds: 600,
  maxRounds: 10,
  maxText: 200,
  maxEvents: 500,
} as const;

export type Mechanism = "sealed-bid-auction" | "negotiation" | "limit-match";
/** Who can read the bids once they open: the organiser (auctions), the two parties (negotiations), or everyone. */
export type Confidentiality = "organiser" | "parties" | "public";
export type Sealing = "client" | "server";
export type Role = "bidder" | Side;
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

export interface NegotiationTerms {
  item: string;
  unit: string;
  minPrice: number;
  maxPrice: number;
  /** Rounds at most; always 1 for a limit match. */
  rounds: number;
}

interface Invitation {
  code: string;
  role: Role;
  label: string;
  /** The participant who used it. An invitation lets one party join, once. */
  usedBy?: string;
}

interface Participant {
  id: string;
  label: string;
  role: Role;
  /** Secret: whoever holds it acts for this participant. */
  token: string;
  /** Ed25519 public key that signs this participant's submissions. */
  publicKey: string;
  /** Negotiations: the age recipient the offers open to. */
  recipient?: string;
  /** Negotiations: the organisation's mandate for this participant's key, if it gave one. Its limit is a commitment. */
  mandate?: Mandate;
  /** Server-sealed sessions only: the signing key, the age identity and the mandate's opening, held here. */
  secretKey?: string;
  identity?: string;
  opening?: MandateOpening;
  /** Negotiations: present and ready. Round 1 begins once both sides are. */
  checkedIn?: boolean;
  joinedAt: number;
}

interface BidRecord {
  participant: string;
  envelopeId: string;
  logIndex: number;
  at: number;
}

interface Round {
  n: number;
  policy: SealedAuctionPolicy | NegotiationPolicy;
  hash: string;
  closeAt: number;
  releaseAt: number;
  bids: BidRecord[];
  /** File keys of this round's bids, by envelope id: disclosed by whoever could open them, or by this engine when it holds the key. */
  disclosure?: Record<string, string>;
  /** Negotiations: the round's outcome and the opened offers, once judged. */
  outcome?: StepOutcome;
  opened?: Partial<Record<Side, number>>;
}

export interface AuctionOutcome {
  kind: "auction";
  /** No winner if there was no valid bid, or the best did not reach the reserve. */
  winner: { participant: string; label: string; amount: number } | null;
  reserveMet?: boolean;
  /** Every bid, ranked, as the evidence gives them. Who may see which is decided in `view`. */
  bids: { participant: string | null; label: string; amount?: number; status: string; reason?: string }[];
}

export type NegotiationOutcome = { kind: "negotiation"; round: number } & StepOutcome;
export type SessionOutcome = AuctionOutcome | NegotiationOutcome;

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
  terms: AuctionTerms | NegotiationTerms;
  /** `biddingSeconds` is how long each round stays open. */
  timing: { opensAt?: number; biddingSeconds: number; quorumBy?: number };
  confidentiality: Confidentiality;
  sealing: Sealing;
  /** Auctions under "organiser" confidentiality: the recipient bids are sealed to, and its identity if this engine holds it. */
  organiser: { recipient?: string; identity?: string };
  invitations: Invitation[];
  participants: Participant[];
  phase: SessionPhase;
  rounds: Round[];
  outcome?: SessionOutcome;
  /** A negotiation that one side walked away from. */
  leftBy?: string;
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
const iso = (t: number): string => new Date(t).toISOString();
const otherSide = (s: Side): Side => (s === "buyer" ? "seller" : "buyer");

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
function fileKeys(value: unknown): Record<string, string> {
  if (value === null || typeof value !== "object" || Array.isArray(value) || Object.values(value).some((k) => typeof k !== "string")) refuse("invalid", "fileKeys: want an object of envelope id to file key", 400);
  return value as Record<string, string>;
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

  private get isAuction(): boolean {
    return this.state!.mechanism === "sealed-bid-auction";
  }
  private get auctionTerms(): AuctionTerms {
    return this.state!.terms as AuctionTerms;
  }
  private get negotiationTerms(): NegotiationTerms {
    return this.state!.terms as NegotiationTerms;
  }
  private sideOf(s: Side): Participant | undefined {
    return this.state!.participants.find((p) => p.role === s);
  }
  /** Enough participants to open: two bidders, or both sides. */
  private quorum(): boolean {
    return this.isAuction ? this.state!.participants.length >= 2 : this.sideOf("buyer") !== undefined && this.sideOf("seller") !== undefined;
  }
  private current(): Round | undefined {
    return this.state!.rounds.at(-1);
  }

  // --- the organiser ------------------------------------------------------------

  /** Create the session: mechanism, terms, timing, how bids are sealed and who may read them, and the invitations. */
  create(id: string, integrator: string, input: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.exclusive(async () => {
      if (this.state) refuse("exists", "this session already exists");
      if (!isSessionId(id)) refuse("invalid", "session id: malformed", 400);
      const mechanism = input.mechanism as Mechanism;
      if (!["sealed-bid-auction", "negotiation", "limit-match"].includes(mechanism)) refuse("unsupported", 'mechanism: want "sealed-bid-auction", "negotiation" or "limit-match"', 400);
      const auction = mechanism === "sealed-bid-auction";
      const t = (input.terms ?? {}) as Record<string, unknown>;
      let terms: AuctionTerms | NegotiationTerms;
      if (auction) {
        const minBid = whole(t.minBid, "terms.minBid", 0, 1e12);
        const maxBid = whole(t.maxBid, "terms.maxBid", minBid, 1e12);
        const rule = t.rule === "lowest-bid" || t.rule === "highest-bid" ? t.rule : refuse("invalid", 'terms.rule: want "highest-bid" or "lowest-bid"', 400);
        terms = { item: text(t.item, "terms.item"), unit: text(t.unit, "terms.unit"), minBid, maxBid, rule: rule as AuctionTerms["rule"], ...(t.reserve !== undefined ? { reserve: whole(t.reserve, "terms.reserve", minBid, maxBid) } : {}) };
      } else {
        const minPrice = whole(t.minPrice, "terms.minPrice", 0, 1e12);
        const maxPrice = whole(t.maxPrice, "terms.maxPrice", minPrice + 1, 1e12);
        const rounds = mechanism === "limit-match" ? whole(t.rounds, "terms.rounds", 1, 1, 1) : whole(t.rounds, "terms.rounds", 1, SESSION_LIMITS.maxRounds, 3);
        terms = { item: text(t.item, "terms.item"), unit: text(t.unit, "terms.unit"), minPrice, maxPrice, rounds };
      }
      const timing = (input.timing ?? {}) as Record<string, unknown>;
      const opensAt = instant(timing.opensAt, "timing.opensAt");
      const quorumBy = instant(timing.quorumBy, "timing.quorumBy");
      const fallback: Confidentiality = auction ? "organiser" : "parties";
      const allowed: Confidentiality[] = auction ? ["organiser", "public"] : ["parties"];
      const confidentiality = (input.confidentiality ?? fallback) as Confidentiality;
      if (!allowed.includes(confidentiality)) refuse("invalid", `confidentiality: want ${allowed.map((c) => `"${c}"`).join(" or ")}${auction ? "" : ": a negotiation's offers open to its two parties"}`, 400);
      const sealing: Sealing = input.sealing === "server" ? "server" : input.sealing === undefined || input.sealing === "client" ? "client" : refuse("invalid", 'sealing: want "client" or "server"', 400);
      // Auctions under "organiser" confidentiality seal the bids to the organiser's own recipient key. With client
      // sealing it must be the organiser's, so that this engine never holds it; otherwise one is made and held here.
      const organiser: SessionState["organiser"] = {};
      if (confidentiality === "organiser") {
        if (typeof input.organiserRecipient === "string") {
          if (!isRecipient(input.organiserRecipient)) refuse("invalid", "organiserRecipient: want an age X25519 recipient (age1…)", 400);
          organiser.recipient = input.organiserRecipient;
        } else if (sealing === "client") refuse("invalid", "organiserRecipient: a client-sealed session needs the organiser's own age recipient, so that only the organiser can read the bids", 400);
        else {
          const keys = await generateRecipientKeys();
          organiser.recipient = keys.recipient;
          organiser.identity = keys.identity;
        }
      }
      const invites = Array.isArray(input.invitations) ? (input.invitations as Record<string, unknown>[]) : [];
      let invitations: Invitation[];
      if (auction) {
        if (invites.length < 1 || invites.length > SESSION_LIMITS.maxParticipants) refuse("invalid", `invitations: want 1 to ${SESSION_LIMITS.maxParticipants}`, 400);
        invitations = invites.map((inv, i) => ({ code: codeFor("inv", id), role: "bidder", label: text(inv.label, `invitations[${i}].label`, `Bidder ${i + 1}`) }));
      } else {
        const roles = invites.map((inv) => inv.role);
        if (invites.length !== 2 || !roles.includes("buyer") || !roles.includes("seller")) refuse("invalid", 'invitations: a negotiation wants two, one with role "buyer" and one with role "seller"', 400);
        invitations = invites.map((inv, i) => ({ code: codeFor("inv", id), role: inv.role as Side, label: text(inv.label, `invitations[${i}].label`, inv.role === "buyer" ? "The buyer" : "The seller") }));
      }
      this.state = {
        version: 1,
        id,
        integrator,
        mechanism,
        terms,
        timing: { ...(opensAt !== undefined ? { opensAt } : {}), biddingSeconds: whole(timing.biddingSeconds, "timing.biddingSeconds", SESSION_LIMITS.minBiddingSeconds, SESSION_LIMITS.maxBiddingSeconds, SESSION_LIMITS.defaultBiddingSeconds), ...(quorumBy !== undefined ? { quorumBy } : {}) },
        confidentiality,
        sealing,
        organiser,
        invitations,
        participants: [],
        phase: "created",
        rounds: [],
        createdAt: Date.now(),
        events: [],
      };
      this.emit("session.created");
      await this.options.saveState(this.state!);
      return this.view({ role: "organiser", integrator });
    });
  }

  private isOrganiser(caller: Caller): boolean {
    return caller.role === "organiser" && caller.integrator === this.state!.integrator;
  }
  private organiserOnly(caller: Caller): void {
    if (!this.isOrganiser(caller)) refuse("forbidden", "only the session's organiser may do this", 403);
  }

  /** Open now, rather than at `opensAt` or (negotiations) once both sides have checked in. Needs a quorum. */
  openNow(caller: Caller): Promise<Record<string, unknown>> {
    return this.exclusive(async () => {
      this.organiserOnly(caller);
      if (this.state!.phase !== "created") refuse("wrong-phase", `the session is ${this.state!.phase}`);
      if (!this.quorum()) refuse("no-quorum", this.isAuction ? "at least two bidders must join before bidding opens" : "both sides must join before the first round");
      await this.beginRound();
      await this.options.saveState(this.state!);
      return this.view(caller);
    });
  }

  /**
   * Cancel before the result. The organiser may cancel any session; either
   * side may walk away from a negotiation. Sealed bids stay sealed; no result.
   */
  cancel(caller: Caller): Promise<Record<string, unknown>> {
    return this.exclusive(async () => {
      const st = this.state!;
      const party = caller.role === "participant" && !this.isAuction ? this.participantOf(caller) : undefined;
      if (!party) this.organiserOnly(caller);
      if (st.phase === "finished" || st.phase === "cancelled" || st.phase === "expired" || (this.isAuction && st.phase !== "created" && st.phase !== "open")) refuse("wrong-phase", `a ${st.phase} session cannot be cancelled`);
      st.phase = "cancelled";
      if (party) st.leftBy = party.id;
      this.emit("session.cancelled", party ? { leftBy: party.id } : undefined);
      await this.options.saveState(st);
      return this.view(caller);
    });
  }

  /**
   * Whoever can open the released bids discloses their file keys, so that the
   * result can be published: the organiser of an auction sealed to it, or
   * either side of a negotiation, for the round just opened. Checked against
   * the evidence: keys that do not open every bid are refused.
   */
  disclose(caller: Caller, input: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.exclusive(async () => {
      const st = this.state!;
      if (this.isAuction) this.organiserOnly(caller);
      else this.participantOf(caller);
      if (st.phase !== "released") refuse("wrong-phase", st.phase === "finished" ? "the result is already published" : "nothing is waiting to be disclosed: the bids have not opened yet");
      const keys = fileKeys(input.fileKeys);
      if (!(await this.settle(keys))) refuse("incomplete", "those keys do not open every bid: disclose the file key of each");
      await this.options.saveState(st);
      return this.view(caller);
    });
  }

  // --- participants -------------------------------------------------------------

  /**
   * Join with an invitation. Client sealing: the participant's own Ed25519
   * public key and, for negotiations, its age recipient and optionally its
   * organisation's mandate. Server sealing: keys are made and held here, and a
   * negotiation's `limit` becomes a mandate issued here.
   */
  join(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.exclusive(async () => {
      const st = this.state ?? refuse("not-found", "no session by that invitation", 404);
      const invitation = st.invitations.find((i) => i.code === input.invitation) ?? refuse("not-found", "no such invitation", 404);
      if (invitation.usedBy) refuse("used", "this invitation has been used");
      if (st.phase !== "created" && (st.phase !== "open" || !this.isAuction)) refuse("wrong-phase", `the session is ${st.phase}`);
      const participant: Participant = { id: `par_${randomHex(8)}`, label: invitation.label, role: invitation.role, token: codeFor("tok", st.id), publicKey: "", joinedAt: Date.now() };
      if (st.sealing === "client") {
        if (typeof input.publicKey !== "string" || !/^[0-9a-f]{64}$/.test(input.publicKey)) refuse("invalid", "publicKey: a client-sealed session needs the participant's Ed25519 public key, 64 hex characters", 400);
        participant.publicKey = input.publicKey as string;
        if (st.participants.some((p) => p.publicKey === participant.publicKey)) refuse("duplicate", "that key has already joined");
        if (!this.isAuction) {
          if (!isRecipient(input.recipient)) refuse("invalid", "recipient: a negotiation needs the participant's own age X25519 recipient (age1…), which the offers open to", 400);
          participant.recipient = input.recipient as string;
          if (input.mandate !== undefined) {
            const problem = mandateProblem(input.mandate, { agent: participant.publicKey, side: invitation.role as Side, unit: st.terms.unit, at: await this.latestClose() });
            if (problem) refuse("invalid", `mandate: ${problem}`, 400);
            participant.mandate = input.mandate as Mandate;
          }
        }
      } else {
        const keys = generateKeyPair();
        participant.publicKey = keys.publicKey;
        participant.secretKey = keys.secretKey;
        if (!this.isAuction) {
          const t = this.negotiationTerms;
          const limit = whole(input.limit, "limit", t.minPrice, t.maxPrice);
          const box = await generateRecipientKeys();
          participant.recipient = box.recipient;
          participant.identity = box.identity;
          const issued = issueMandate(generateKeyPair(), { organisationName: participant.label, agent: keys.publicKey, side: invitation.role as Side, unit: t.unit, limit, expires: (await this.latestClose()) + 24 * 3600 });
          participant.mandate = issued.mandate;
          participant.opening = issued.opening;
        }
      }
      // Round 1 of a negotiation waits until both sides are present. The second to join is, by joining; the
      // first may have joined long before and gone away, so it says so with check-in, before or after.
      if (!this.isAuction) participant.checkedIn = this.sideOf(otherSide(invitation.role as Side)) !== undefined;
      st.participants.push(participant);
      invitation.usedBy = participant.id;
      this.emit("participant.joined", { participant: participant.id, label: participant.label, role: participant.role });
      await this.maybeBegin();
      await this.options.saveState(st);
      return { participant: { id: participant.id, label: participant.label, role: participant.role, publicKey: participant.publicKey, ...(participant.recipient ? { recipient: participant.recipient } : {}) }, token: participant.token, session: this.view({ role: "participant", token: participant.token }) };
    });
  }

  /** A negotiation's side says it is present. Once both are, round 1 begins. */
  checkIn(caller: Caller): Promise<Record<string, unknown>> {
    return this.exclusive(async () => {
      const me = this.participantOf(caller);
      if (this.isAuction) refuse("unsupported", "auctions open at opensAt or when the organiser opens them");
      me.checkedIn = true;
      await this.maybeBegin();
      await this.options.saveState(this.state!);
      return this.view(caller);
    });
  }

  /** A negotiation without opensAt begins once both sides are present: the second to join, or a check-in. */
  private async maybeBegin(): Promise<void> {
    const st = this.state!;
    if (this.isAuction || st.phase !== "created" || st.timing.opensAt !== undefined || !this.quorum()) return;
    if (this.sideOf("buyer")!.checkedIn && this.sideOf("seller")!.checkedIn) await this.beginRound();
  }

  /**
   * The latest a round could close, in UNIX seconds on the beacon's clock (what
   * a mandate's expiry is checked against): every round back to back, from now
   * or `opensAt`, with room to spare.
   */
  private async latestClose(): Promise<number> {
    const st = this.state!;
    const rounds = this.isAuction ? 1 : this.negotiationTerms.rounds;
    const window = Math.ceil((st.timing.biddingSeconds * 1000 * (this.options.timeScale ?? 1)) / this.options.roundMs);
    const wait = Math.ceil(Math.max(0, (st.timing.opensAt ?? 0) - Date.now()) / this.options.roundMs);
    return closeTime(this.beacon, (await deadlineRound(this.viewer)).round + wait + rounds * (window + this.options.releaseAfter + 2) + 100);
  }

  private participantOf(caller: Caller): Participant {
    if (caller.role !== "participant") refuse("forbidden", "a participant's token is needed", 403);
    return this.state!.participants.find((p) => p.token === (caller as { token: string }).token) ?? refuse("forbidden", "that token is not for this session", 403);
  }

  /** The current round's policy, which a client-sealed bid or offer must be sealed under. */
  roundPolicy(): Record<string, unknown> {
    const round = this.current() ?? refuse("wrong-phase", "the first round has not begun");
    return { round: round.n, policy: round.policy, policyHash: round.hash, closesAt: iso(round.closeAt), opensAt: iso(round.releaseAt) };
  }

  /**
   * One bid or offer per participant per round. Client-sealed:
   * `{ submission, envelope }`, signed by the participant's key; the log
   * checks it is sealed as the policy says. Server-sealed: `{ amount }` for an
   * auction or `{ price }` for a negotiation, sealed here with the key held
   * for it, and refused beyond the mandate's limit. A server-sealed limit
   * match takes none: each side's limit is sealed when the round begins.
   */
  bid(caller: Caller, input: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.exclusive(async () => {
      const st = this.state!;
      const participant = this.participantOf(caller);
      if (st.phase !== "open") refuse(st.phase === "created" ? "not-open" : "late", st.phase === "created" ? "the first round has not begun" : `the session is ${st.phase}`);
      const round = this.current()!;
      if (Date.now() >= round.closeAt) refuse("late", `round ${round.n} closed at ${iso(round.closeAt)}`);
      if (round.bids.some((b) => b.participant === participant.id)) refuse("duplicate", `one per participant per round: yours for round ${round.n} is already sealed`);
      let sealed: { submission: Submission; envelope: Envelope };
      if (st.sealing === "client") {
        if (input.amount !== undefined || input.price !== undefined) refuse("invalid", "this session is client-sealed: send { submission, envelope }, sealed with the SDK; never the amount", 400);
        const submission = input.submission as Submission;
        const envelope = input.envelope as Envelope;
        if (!submission || !envelope || typeof submission !== "object" || typeof envelope !== "object") refuse("invalid", "want { submission, envelope }", 400);
        if (submission.submitter !== participant.publicKey) refuse("not-a-participant", "the submission is not signed by this participant's key");
        if (submission.policyHash !== round.hash) refuse("invalid", `the submission is not for round ${round.n}'s policy`, 400);
        sealed = { submission, envelope };
      } else if (this.isAuction) {
        const amount = whole(input.amount, "amount", this.auctionTerms.minBid, this.auctionTerms.maxBid);
        const policy = round.policy as SealedAuctionPolicy;
        const keys = generateKeyPair(participant.secretKey!);
        sealed = st.organiser.recipient ? await prepareBidTo(policy, amount, keys) : await prepareBid(policy, amount, keys);
      } else {
        if (st.mechanism === "limit-match") refuse("unsupported", "a server-sealed limit match seals each side's limit itself when the round begins");
        const t = this.negotiationTerms;
        const price = whole(input.price, "price", t.minPrice, t.maxPrice);
        const s = participant.role as Side;
        const limit = participant.opening!.limit;
        if (s === "buyer" ? price > limit : price < limit) refuse("beyond-mandate", `refused: the mandate lets this side ${s === "buyer" ? `pay at most ${limit}` : `accept no less than ${limit}`} ${t.unit}`);
        sealed = await this.offerFor(participant, round, price);
      }
      const receipt = await this.record(participant, round, sealed);
      await this.options.saveState(st);
      return { round: round.n, receipt, closesAt: iso(round.closeAt), closeRound: round.policy.closeRound, opensAt: iso(round.releaseAt), releaseRound: round.policy.releaseRound };
    });
  }

  private offerFor(participant: Participant, round: Round, price: number): Promise<{ submission: Submission; envelope: Envelope }> {
    return prepareOffer(round.policy as NegotiationPolicy, participant.role as Side, price, generateKeyPair(participant.secretKey!), participant.opening);
  }

  private async record(participant: Participant, round: Round, sealed: { submission: Submission; envelope: Envelope }) {
    let receipt;
    try {
      receipt = await this.options.log.submit(sealed.submission, sealed.envelope);
    } catch (error) {
      // The log refuses anything not signed, not for this policy, not sealed as it says, or late.
      refuse("refused", (error as Error).message);
    }
    round.bids.push({ participant: participant.id, envelopeId: sealed.submission.envelopeId, logIndex: receipt!.index, at: Date.now() });
    this.emit("bid.sealed", { round: round.n, participant: participant.id });
    return receipt!;
  }

  // --- time passing -------------------------------------------------------------

  private async beginRound(): Promise<void> {
    const st = this.state!;
    const log = await this.options.log.terms();
    const now = (await deadlineRound(this.viewer)).round;
    const closeRound = now + Math.max(1, Math.round((st.timing.biddingSeconds * 1000 * (this.options.timeScale ?? 1)) / this.options.roundMs));
    const releaseRound = closeRound + this.options.releaseAfter;
    const common = { beacon: this.beacon, closeRound, releaseRound, witness: log.witness, origin: log.origin, logFrom: log.size, cosigners: log.cosigners, cosignerThreshold: log.cosignerThreshold };
    const n = st.rounds.length + 1;
    let policy: SealedAuctionPolicy | NegotiationPolicy;
    if (this.isAuction) {
      const t = this.auctionTerms;
      policy = { format: AUCTION_POLICY_FORMAT, auctionId: st.id, unit: t.unit, ...common, minBid: t.minBid, maxBid: t.maxBid, rule: t.rule, ...(t.reserve !== undefined ? { reserve: t.reserve } : {}), recipients: st.organiser.recipient ? [st.organiser.recipient] : [], tieBreak: "release-round-signature" };
    } else {
      const t = this.negotiationTerms;
      const party = (s: Side) => {
        const p = this.sideOf(s)!;
        return { signer: p.publicKey, recipient: p.recipient!, ...(p.mandate ? { mandate: p.mandate } : {}) };
      };
      policy = { format: NEGOTIATION_POLICY_FORMAT, negotiationId: st.id, step: n, previous: st.rounds.at(-1)?.hash ?? "", item: t.item, unit: t.unit, minPrice: t.minPrice, maxPrice: t.maxPrice, buyer: party("buyer"), seller: party("seller"), rule: "midpoint-if-crossed", ...common };
    }
    const hash = await this.options.log.registerPolicy(policy);
    const round: Round = { n, policy, hash, closeAt: this.options.timeOfRound(closeRound), releaseAt: this.options.timeOfRound(releaseRound), bids: [] };
    st.rounds.push(round);
    st.phase = "open";
    this.emit("round.opened", { round: n, policyHash: hash, closesAt: iso(round.closeAt) });
    // A server-sealed limit match has nothing to decide: each side's offer is its limit.
    if (st.mechanism === "limit-match" && st.sealing === "server") {
      for (const p of st.participants) await this.record(p, round, await this.offerFor(p, round, p.opening!.limit));
    }
  }

  /** Work out an auction's outcome from the evidence with `opener`; undefined if it cannot be established. */
  private async judgeAuction(round: Round, opener?: Parameters<typeof verifyAuction>[2]): Promise<AuctionOutcome | undefined> {
    const st = this.state!;
    const evidence = (await this.options.log.evidence(round.hash)) as unknown as AuctionInputs;
    const result: AuctionResult = await verifyAuction(evidence, { acceptedBeacons: [this.beacon] }, opener);
    if (!result.ok) return undefined;
    const who = (key: string) => st.participants.find((p) => p.publicKey === key);
    // Valid bids first, best first; then the rest, as the evidence lists them.
    const better = this.auctionTerms.rule === "lowest-bid" ? (a: number, b: number) => a - b : (a: number, b: number) => b - a;
    const ranked = [...result.bids.filter((b) => b.status === "valid").sort((a, b) => better(a.amount!, b.amount!)), ...result.bids.filter((b) => b.status !== "valid")];
    const winner = result.winner ? who(result.winner.submitter) : undefined;
    return {
      kind: "auction",
      winner: result.winner ? { participant: winner?.id ?? "", label: winner?.label ?? "An unknown bidder", amount: result.winner.amount } : null,
      ...(result.reserveMet !== undefined ? { reserveMet: result.reserveMet } : {}),
      bids: ranked.map((b) => ({ participant: who(b.submitter)?.id ?? null, label: who(b.submitter)?.label ?? "An unknown bidder", ...(b.amount !== undefined ? { amount: b.amount } : {}), status: b.status, ...(b.reason ? { reason: b.reason } : {}) })),
    };
  }

  /**
   * Judge the released round, with disclosed keys or the keys held here, and
   * act on it: publish an auction's result; end a negotiation on a deal or its
   * last round, or begin the next. False if the bids cannot all be opened yet.
   */
  private async settle(disclosed?: Record<string, string>): Promise<boolean> {
    const st = this.state!;
    const round = this.current()!;
    const verifier = { acceptedBeacons: [this.beacon] };
    const keys = disclosed ?? round.disclosure ?? {};
    if (this.isAuction) {
      const held = st.organiser.identity;
      const opener = st.confidentiality === "public" ? undefined : held ? bidOpenerAs(held) : bidOpenerWithFileKeys(keys);
      const outcome = await this.judgeAuction(round, opener);
      if (!outcome) return false;
      if (held) round.disclosure = await discloseBids((await this.options.log.evidence(round.hash)) as unknown as AuctionInputs, held, verifier);
      else if (disclosed) round.disclosure = disclosed;
      this.finish(outcome);
      return true;
    }
    const held = st.sealing === "server" ? this.sideOf("buyer")!.identity! : undefined;
    const evidence = (await this.options.log.evidence(round.hash)) as unknown as StepInputs;
    const result = await verifyNegotiationStep(evidence, held ? asParty(held) : withFileKeys(keys), verifier);
    if (!result.ok || !result.outcome) return false;
    round.disclosure = held ? await discloseStep(evidence, held, verifier) : keys;
    round.outcome = result.outcome;
    round.opened = Object.fromEntries(result.offers.filter((o) => o.side && o.status === "valid" && o.price !== undefined).map((o) => [o.side, o.price]));
    this.emit("round.result", { round: round.n, deal: result.outcome.deal });
    if (result.outcome.deal || round.n >= this.negotiationTerms.rounds) this.finish({ kind: "negotiation", round: round.n, ...result.outcome });
    else await this.beginRound();
    return true;
  }

  private finish(outcome: SessionOutcome): void {
    const st = this.state!;
    st.outcome = outcome;
    st.phase = "finished";
    if (outcome.kind === "auction") this.emit("round.result", { round: 1, winner: outcome.winner?.participant ?? null });
    this.emit("session.finished");
  }

  /**
   * Do whatever is due: open at `opensAt` with a quorum, expire without one,
   * close, and once released judge the round if the bids can be opened here.
   * Returns milliseconds until it wants calling again, or undefined.
   */
  work(): Promise<number | undefined> {
    return this.exclusive(async () => {
      const st = this.state;
      if (!st) return undefined;
      const now = Date.now();
      if (st.phase === "created") {
        const quorum = this.quorum();
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
      const round = this.current()!;
      await this.options.log.tick().catch(() => {});
      if (st.phase === "open" && now >= round.closeAt) {
        st.phase = "closed";
        this.emit("round.closed", { round: round.n, bids: round.bids.length });
        await this.options.saveState(st);
      }
      const phase = await this.options.log.phase(round.hash);
      if (phase.state !== "released") return Math.max(250, Math.min(5_000, (st.phase === "open" ? round.closeAt : round.releaseAt) - now));
      st.phase = "released";
      this.emit("round.released", { round: round.n, releaseRound: round.policy.releaseRound });
      // Judge now if the bids can be opened here: public ones, ones sealed to keys held here, or none at all.
      // Otherwise the round waits for whoever can open them to disclose.
      await this.settle();
      await this.options.saveState(st);
      // A negotiation that goes on has begun its next round.
      return (st.phase as SessionPhase) === "open" ? 500 : undefined;
    });
  }

  // --- views -----------------------------------------------------------------------

  /** The receipt: what anyone can check the session against. */
  private receipt(): Record<string, unknown> | null {
    const st = this.state!;
    const first = st.rounds[0];
    if (!first) return null;
    return {
      sessionId: st.id,
      log: { origin: first.policy.origin, witness: first.policy.witness, cosigners: first.policy.cosigners },
      rounds: st.rounds.map((r) => ({ round: r.n, policyHash: r.hash, closeRound: r.policy.closeRound, releaseRound: r.policy.releaseRound, entries: Object.fromEntries(r.bids.map((b) => [b.participant, b.logIndex])), ...(r.outcome ? { outcome: r.outcome } : {}) })),
    };
  }

  /** Who may read the opened bids: the organiser and the parties of a negotiation, the organiser of an auction, or everyone. */
  private mayReadBids(caller: Caller, me: Participant | undefined): boolean {
    const st = this.state!;
    return st.confidentiality === "public" || this.isOrganiser(caller) || (st.confidentiality === "parties" && me !== undefined);
  }

  private awaiting(): string | undefined {
    const st = this.state!;
    if (st.phase !== "released") return undefined;
    return this.isAuction ? "the organiser's disclosure of the bids' file keys" : `either side's disclosure of round ${this.current()!.n}'s file keys`;
  }

  /**
   * The session as `caller` may see it. The organiser sees everything; a
   * participant sees the terms, its own bids and the result (every bid only
   * where it may read them); anyone else sees the terms and the phase, and the
   * result only of a public session.
   */
  view(caller: Caller): Record<string, unknown> {
    const st = this.state ?? refuse("not-found", "no such session", 404);
    const organiser = this.isOrganiser(caller);
    const me = caller.role === "participant" ? st.participants.find((p) => p.token === caller.token) : undefined;
    if (caller.role === "participant" && !me) refuse("forbidden", "that token is not for this session", 403);
    const round = this.current();
    const outcome = st.outcome;
    const readsBids = this.mayReadBids(caller, me);
    const insider = organiser || me !== undefined;
    const sealedBy = this.isAuction ? "the bidders" : "the parties";
    const hasBid = (p: Participant) => round?.bids.some((b) => b.participant === p.id) ?? false;
    const awaiting = insider ? this.awaiting() : undefined;
    const left = st.leftBy ? st.participants.find((p) => p.id === st.leftBy) : undefined;
    let shownOutcome: Record<string, unknown> | undefined;
    if (outcome && (insider || st.confidentiality === "public")) {
      shownOutcome = outcome.kind === "auction" ? { winner: outcome.winner, ...(outcome.reserveMet !== undefined ? { reserveMet: outcome.reserveMet } : {}), ...(readsBids ? { bids: outcome.bids } : {}) } : { ...outcome };
    }
    let yours: Record<string, unknown> | undefined;
    if (me) {
      yours = { id: me.id, label: me.label, role: me.role, hasBid: hasBid(me), ...(me.opening ? { limit: me.opening.limit } : {}) };
      if (this.isAuction && outcome?.kind === "auction") yours.yourBid = outcome.bids.find((b) => b.participant === me.id) ?? null;
    }
    return {
      id: st.id,
      environment: "demonstration",
      mechanism: st.mechanism,
      phase: st.phase,
      terms: st.terms,
      confidentiality: st.confidentiality,
      sealing: st.sealing,
      trust: st.sealing === "client" ? `client-sealed: ${sealedBy} sealed and signed on their own machines; Mattering could not read or forge a bid` : `server-sealed: Mattering held ${sealedBy}' keys and sealed for them, so it could have read or forged a bid`,
      timing: { ...(st.timing.opensAt ? { opensAt: iso(st.timing.opensAt) } : {}), biddingSeconds: st.timing.biddingSeconds, ...(st.timing.quorumBy ? { quorumBy: iso(st.timing.quorumBy) } : {}) },
      ...(round ? { round: { round: round.n, policyHash: round.hash, closesAt: iso(round.closeAt), closeRound: round.policy.closeRound, opensAt: iso(round.releaseAt), releaseRound: round.policy.releaseRound, bids: round.bids.length } } : {}),
      ...(!this.isAuction && insider && readsBids ? { openedRounds: st.rounds.filter((r) => r.outcome).map((r) => ({ round: r.n, buyerOffer: r.opened?.buyer ?? null, sellerOffer: r.opened?.seller ?? null, outcome: r.outcome })) } : {}),
      ...(organiser ? { organiserRecipient: st.organiser.recipient ?? null, invitations: st.invitations.map((i) => ({ code: i.usedBy ? null : i.code, role: i.role, label: i.label, joined: i.usedBy !== undefined })), participants: st.participants.map((p) => ({ id: p.id, label: p.label, role: p.role, joined: iso(p.joinedAt), hasBid: hasBid(p) })) } : {}),
      ...(yours ? { you: yours } : {}),
      ...(awaiting ? { awaiting } : {}),
      ...(left && insider ? { leftBy: { id: left.id, label: left.label, role: left.role } } : {}),
      ...(shownOutcome ? { outcome: shownOutcome } : {}),
      ...(st.phase === "finished" && insider ? { receipt: this.receipt() } : {}),
    };
  }

  /** Events after `after`, for a host to deliver as webhooks or a stream. */
  events(after: number): SessionEvent[] {
    return (this.state?.events ?? []).filter((e) => e.n > after);
  }

  /**
   * Every round's evidence as the log serves it, everything `mattering
   * check-demo` needs: with the file keys of the opened bids for whoever may
   * read them.
   */
  async evidence(caller: Caller): Promise<Record<string, unknown>> {
    const st = this.state ?? refuse("not-found", "no such session", 404);
    if (st.rounds.length === 0) refuse("wrong-phase", "the first round has not begun");
    const me = caller.role === "participant" ? st.participants.find((p) => p.token === caller.token) : undefined;
    const keys = Object.assign({}, ...st.rounds.map((r) => r.disclosure ?? {})) as Record<string, string>;
    const rounds = [];
    for (const r of st.rounds) rounds.push(await this.options.log.evidence(r.hash));
    return { format: "mattering.session-evidence/1", sessionId: st.id, mechanism: st.mechanism, beacon: this.beacon, rounds, ...(this.mayReadBids(caller, me) && Object.keys(keys).length ? { fileKeys: keys } : {}) };
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
        case "POST /check-in":
          return { status: 200, body: await this.checkIn(caller) };
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
          return { status: 200, body: await this.evidence(caller) };
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
