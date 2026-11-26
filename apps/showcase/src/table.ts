/**
 * A negotiation table: a sealed negotiation between two outside parties, such
 * as two people's AI assistants connected through MCP. One party opens the
 * table and gets an invite code; the other joins with it. Each sets its own
 * limit, which becomes its firm's mandate. Then rounds run on fixed windows:
 * each side seals one offer per round, both open together when the window's
 * release round comes, and if they cross the deal is at the midpoint.
 *
 * As in the Negotiation Room, this server holds both parties' keys and seals
 * their offers for them, which is staged and said: in practice each party
 * would seal on its own machine. What is real: the offers are sealed to both
 * parties and to the round's release, the log closes and is cosigned before
 * they open, and anyone with the table's watch link can work every round out
 * from the evidence and the disclosures.
 *
 * No server, no files and no timers in here, as in `room.ts`.
 */
import {
  MatteringError,
  NEGOTIATION_POLICY_FORMAT,
  closeTime,
  deadlineRound,
  generateKeyPair,
  issueMandate,
  type BeaconInfo,
  type BeaconSource,
  type Mandate,
  type MandateOpening,
  type NegotiationPolicy,
  type Side,
} from "@mattering/core";
import { asParty, discloseStep, prepareOffer, verifyNegotiationStep, type StepInputs, type StepOutcome } from "@mattering/core/negotiation";
import { generateRecipientKeys } from "@mattering/core/recipients";
import { errorReply, type Reply } from "@mattering/witness/routes";
import type { LogHost } from "./log-host.ts";

export const TABLE_LIMITS = {
  minRounds: 1,
  maxRounds: 5,
  minRoundSeconds: 30,
  /** Long enough for an assistant to read the status, decide and seal; short enough for a demonstration. */
  defaultRoundSeconds: 60,
  maxRoundSeconds: 600,
  maxNote: 280,
  maxText: 200,
  /** An unjoined table expires this long after it was opened. */
  joinWithinMs: 30 * 60 * 1000,
} as const;

/** What the party opening the table chooses. */
export interface TableTerms {
  /** What is being negotiated, in a line. */
  item: string;
  /** The currency or unit of the prices, such as "GBP". */
  unit: string;
  minPrice: number;
  maxPrice: number;
  rounds: number;
  /** Seconds each round stays open for offers. */
  roundSeconds: number;
}

interface PartyState {
  /** Secret: whoever holds it acts for this side. */
  token: string;
  organisation: string;
  orgSecret: string;
  signerSecret: string;
  identity: string;
  recipient: string;
  mandate: Mandate;
  opening: MandateOpening;
  /**
   * True: the assistant makes this side's offers by itself. False: it proposes
   * each offer to its user and seals it only once the user has approved that
   * price. Absent in tables opened before the choice existed: autonomous.
   */
  autonomous?: boolean;
}

interface RoundState {
  policy: NegotiationPolicy;
  hash: string;
  closeAt: number;
  releaseAt: number;
  submitted: Record<Side, boolean>;
  sealedAt: Partial<Record<Side, number>>;
  logIndex: Partial<Record<Side, number>>;
  /** Each side's note to its own firm, shown to everyone, the other side included, only once the negotiation is over. */
  notes: Partial<Record<Side, string>>;
  /** Both opened offers, once the round has opened and been judged here. */
  opened?: Partial<Record<Side, number>>;
  outcome?: StepOutcome;
}

export interface TableState {
  version: 1;
  id: string;
  invite: string;
  createdAt: number;
  /** Last time anyone acted at the table, for expiry. */
  touchedAt: number;
  terms: TableTerms;
  /** The side that opened the table. */
  host: Side;
  parties: Partial<Record<Side, PartyState>>;
  rounds: RoundState[];
  startedAt?: number;
  /** Sides that have checked in since both were seated. Round 1 begins once both have. */
  checkedIn?: Partial<Record<Side, boolean>>;
  /** Set when a side walked away before the end. */
  left?: Side;
  done: boolean;
}

export interface TableOptions {
  mode: "live" | "simulated";
  sourceFor: () => BeaconSource;
  timeOfRound: (round: number) => number;
  log: LogHost;
  loadState: () => Promise<TableState | undefined>;
  saveState: (state: TableState) => Promise<void>;
  /** Milliseconds per beacon round: 3,000 against drand. */
  roundMs: number;
  /** Beacon rounds from a round's close to the opening of its offers. */
  releaseAfter: number;
  /** Tests only: multiplies the round windows, so that a test need not wait minutes. Default 1. */
  timeScale?: number;
}

const other = (side: Side): Side => (side === "buyer" ? "seller" : "buyer");
const randomHex = (bytes: number): string => Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, "0")).join("");
const secret = (): string => randomHex(16);
/** A table id: short, unguessable, safe in a URL and a Durable Object name. */
export const newTableId = (): string => randomHex(12);
const isTableId = (id: unknown): id is string => typeof id === "string" && /^[0-9a-f]{24}$/.test(id);
/**
 * Tokens and invites name their table, so a stateless front end knows where
 * to send them, and say what they are: `tok_` is secret and acts for a side,
 * `inv_` is for sharing with the other party. Tables opened before the
 * prefixes used `<table>.<secret>` for both.
 */
export const tableOf = (code: unknown): string | undefined => {
  if (typeof code !== "string") return undefined;
  const id = /^(?:tok|inv)_([0-9a-f]{24})_[0-9a-f]+$/.exec(code)?.[1] ?? code.split(".")[0];
  return isTableId(id) ? id : undefined;
};
export const isInvite = (code: unknown): boolean => typeof code === "string" && code.startsWith("inv_");

function fail(message: string): never {
  throw new MatteringError("POLICY", message);
}
function text(value: unknown, field: string, fallback?: string): string {
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== "string" || value.trim() === "" || value.length > TABLE_LIMITS.maxText) fail(`${field}: want a short line of text`);
  return value.replace(/\s+/g, " ").trim();
}
function whole(value: unknown, field: string, min: number, max: number, fallback?: number): number {
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) fail(`${field}: want a whole number from ${min} to ${max}`);
  return value;
}
function flag(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") fail(`${field}: want true or false`);
  return value;
}
function side(value: unknown): Side {
  if (value !== "buyer" && value !== "seller") fail('side: want "buyer" or "seller"');
  return value;
}

/** What the side should do now, in a sentence an assistant can act on. */
function nextStep(st: TableState, s: Side, current: RoundState | undefined, now: number): string {
  const autonomous = st.parties[s]?.autonomous !== false;
  if (st.done) return st.left ? "The negotiation is over: a side left it. Report that there is no deal." : "The negotiation is over. Report the result, with its receipt.";
  if (!st.parties[other(s)]) return st.host === s ? "Share the invite (it starts inv_) with the other party, never your token, then call wait_for_next_round until they join." : "Wait for the other side to join: call wait_for_next_round.";
  if (!current) return "Round 1 begins once the other side checks in. Call wait_for_next_round.";
  const left = Math.max(0, Math.ceil((current.closeAt - now) / 1000));
  if (!current.submitted[s] && now < current.closeAt) {
    return autonomous
      ? `Make your offer for round ${current.policy.step} with make_offer within ${left} seconds. Then call wait_for_next_round.`
      : `Propose an offer for round ${current.policy.step} to your user and ask them to approve that exact price; the window closes in ${left} seconds. Once they approve, call make_offer with approvedByUser: true, then wait_for_next_round.`;
  }
  if (!current.submitted[s]) return `Round ${current.policy.step} closed without an offer from you. Call wait_for_next_round until the next round begins.`;
  return `Your offer for round ${current.policy.step} is sealed. Call wait_for_next_round until the round opens.`;
}

export class Table {
  private busy: Promise<unknown> = Promise.resolve();

  private constructor(
    private readonly options: TableOptions,
    private readonly viewer: BeaconSource,
    private state: TableState | undefined,
  ) {}

  static async open(options: TableOptions): Promise<Table> {
    const state = await options.loadState();
    return new Table(options, options.sourceFor(), state?.version === 1 ? state : undefined);
  }

  get beacon(): BeaconInfo {
    return this.viewer.beacon;
  }
  get id(): string | undefined {
    return this.state?.id;
  }
  /** Milliseconds since anyone last acted here, or undefined for an empty table. */
  idleFor(): number | undefined {
    return this.state ? Date.now() - this.state.touchedAt : undefined;
  }

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.busy.then(fn);
    this.busy = run.catch(() => {});
    return run;
  }

  /** The table can no longer be joined: opened too long ago without a second party. */
  private expired(st: TableState): boolean {
    return !st.done && (!st.parties.buyer || !st.parties.seller) && Date.now() - st.createdAt > TABLE_LIMITS.joinWithinMs;
  }

  /** One party takes a side and sets its limit. Its firm's mandate is issued here. */
  private async seat(organisation: string, s: Side, limit: number, autonomous: boolean, expires: number): Promise<PartyState> {
    const org = generateKeyPair();
    const signer = generateKeyPair();
    const box = await generateRecipientKeys();
    const { mandate, opening } = issueMandate(org, { organisationName: organisation, agent: signer.publicKey, side: s, unit: this.state!.terms.unit, limit, expires });
    return { token: `tok_${this.state!.id}_${secret()}`, organisation, orgSecret: org.secretKey, signerSecret: signer.secretKey, identity: box.identity, recipient: box.recipient, mandate, opening, autonomous };
  }

  private async expiry(): Promise<number> {
    const t = this.state!.terms;
    const roundsAhead = Math.ceil((t.rounds * (t.roundSeconds * 1000 + this.options.releaseAfter * this.options.roundMs)) / this.options.roundMs) + 100;
    return closeTime(this.beacon, (await deadlineRound(this.viewer)).round + roundsAhead) + 24 * 3600;
  }

  /** Open the table: the terms, the opener's side and limit. Returns its token and the invite for the other side. */
  create(id: string, input: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.exclusive(async () => {
      if (this.state) fail("this table is already open");
      if (!isTableId(id)) fail("table id: malformed");
      const minPrice = whole(input.minPrice, "minPrice", 0, 1e12);
      const maxPrice = whole(input.maxPrice, "maxPrice", minPrice + 1, 1e12);
      const terms: TableTerms = {
        item: text(input.item, "item"),
        unit: text(input.unit, "unit", "GBP"),
        minPrice,
        maxPrice,
        rounds: whole(input.rounds, "rounds", TABLE_LIMITS.minRounds, TABLE_LIMITS.maxRounds, 3),
        roundSeconds: whole(input.roundSeconds, "roundSeconds", TABLE_LIMITS.minRoundSeconds, TABLE_LIMITS.maxRoundSeconds, TABLE_LIMITS.defaultRoundSeconds),
      };
      const host = side(input.side);
      const now = Date.now();
      this.state = { version: 1, id, invite: `inv_${id}_${secret()}`, createdAt: now, touchedAt: now, terms, host, parties: {}, rounds: [], done: false };
      const limit = whole(input.limit, "limit", minPrice, maxPrice);
      const autonomous = flag(input.autonomous, "autonomous");
      const organisation = text(input.organisation, "organisation", host === "buyer" ? "The buyer" : "The seller");
      this.state.parties[host] = await this.seat(organisation, host, limit, autonomous, await this.expiry());
      await this.options.saveState(this.state);
      // Say what was not chosen, so the assistant can tell its user.
      const defaultsUsed = [
        ...(input.unit === undefined ? [`unit: ${terms.unit}`] : []),
        ...(input.organisation === undefined ? [`organisation: ${organisation}`] : []),
        ...(input.rounds === undefined ? [`rounds: ${terms.rounds}`] : []),
      ];
      return { tableId: id, side: host, token: this.state.parties[host]!.token, invite: this.state.invite, terms, yourLimit: limit, autonomous, joinBy: new Date(now + TABLE_LIMITS.joinWithinMs).toISOString(), ...(defaultsUsed.length ? { defaultsUsed } : {}) };
    });
  }

  /** The other party joins with the invite, setting its own limit. Round 1 begins once both sides have checked in. */
  join(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.exclusive(async () => {
      const st = this.state ?? fail("no table by that invite");
      if (input.invite !== st.invite) fail("that invite is not for this table");
      if (st.done) fail("this negotiation has ended");
      if (this.expired(st)) fail("this table was not joined in time and has expired; ask the other party to open a new one");
      const s = other(st.host);
      if (st.parties[s]) fail("both sides of this table are taken");
      const limit = whole(input.limit, "limit", st.terms.minPrice, st.terms.maxPrice);
      const autonomous = flag(input.autonomous, "autonomous");
      st.parties[s] = await this.seat(text(input.organisation, "organisation", s === "buyer" ? "The buyer" : "The seller"), s, limit, autonomous, await this.expiry());
      st.touchedAt = Date.now();
      // Joining is checking in. Round 1 waits for the opener to check in too, so no round runs while it is away.
      st.checkedIn = { [s]: true };
      await this.options.saveState(st);
      return { tableId: st.id, side: s, token: st.parties[s]!.token, terms: st.terms, otherOrganisation: st.parties[st.host]!.organisation, yourLimit: limit, autonomous };
    });
  }

  private async beginRound(now: number): Promise<void> {
    const st = this.state!;
    const log = await this.options.log.terms();
    const previous = st.rounds.at(-1);
    const closeRound = now + Math.max(1, Math.round((st.terms.roundSeconds * 1000 * (this.options.timeScale ?? 1)) / this.options.roundMs));
    const releaseRound = closeRound + this.options.releaseAfter;
    const party = (s: Side) => ({ signer: generateKeyPair(st.parties[s]!.signerSecret).publicKey, recipient: st.parties[s]!.recipient, mandate: st.parties[s]!.mandate });
    const policy: NegotiationPolicy = {
      format: NEGOTIATION_POLICY_FORMAT,
      negotiationId: `table-${st.id}`,
      step: st.rounds.length + 1,
      previous: previous?.hash ?? "",
      item: st.terms.item,
      unit: st.terms.unit,
      minPrice: st.terms.minPrice,
      maxPrice: st.terms.maxPrice,
      buyer: party("buyer"),
      seller: party("seller"),
      rule: "midpoint-if-crossed",
      beacon: this.beacon,
      closeRound,
      releaseRound,
      witness: log.witness,
      origin: log.origin,
      logFrom: log.size,
      cosigners: log.cosigners,
      cosignerThreshold: log.cosignerThreshold,
    };
    const hash = await this.options.log.registerPolicy(policy);
    st.rounds.push({ policy, hash, closeAt: this.options.timeOfRound(closeRound), releaseAt: this.options.timeOfRound(releaseRound), submitted: { buyer: false, seller: false }, sealedAt: {}, logIndex: {}, notes: {} });
  }

  private partyOf(token: unknown): { side: Side; party: PartyState } {
    const st = this.state ?? fail("no table by that token");
    for (const s of ["buyer", "seller"] as const) if (typeof token === "string" && st.parties[s]?.token === token) return { side: s, party: st.parties[s]! };
    return fail("that token is not for this table");
  }

  /** Seal one offer for the token's side in the current round. Refused beyond the side's mandate. */
  offer(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.exclusive(async () => {
      const st = this.state!;
      const { side: s, party } = this.partyOf(input.token);
      if (st.done) fail("the negotiation is over");
      const round = st.rounds.at(-1) ?? fail(st.parties[other(s)] ? "round 1 has not begun: it begins once both sides have checked in; call wait_for_next_round" : "the other side has not joined yet; share the invite");
      if (round.submitted[s]) fail(`you have already sealed an offer for round ${round.policy.step}; only the first counts`);
      if (Date.now() >= round.closeAt) fail(`round ${round.policy.step} has closed; wait for it to open and the next to begin`);
      const price = whole(input.price, "price", st.terms.minPrice, st.terms.maxPrice);
      // The firm's own software refuses an offer beyond its mandate, whatever the assistant asks.
      if (s === "buyer" ? price > party.opening.limit : price < party.opening.limit) {
        fail(`refused: your firm's mandate lets you ${s === "buyer" ? `pay at most ${party.opening.limit}` : `accept no less than ${party.opening.limit}`} ${st.terms.unit}`);
      }
      // A side whose user approves each offer seals only what the user has approved. The server cannot see the
      // conversation, so this rests on the assistant saying so; without it, the assistant is sent back to ask.
      if (party.autonomous === false && input.approvedByUser !== true) {
        fail(`your user chose to approve each offer: ask them to approve ${price} ${st.terms.unit} for round ${round.policy.step}, then call make_offer again with approvedByUser: true`);
      }
      const note = typeof input.note === "string" ? input.note.replace(/\s+/g, " ").trim().slice(0, TABLE_LIMITS.maxNote) : "";
      const sealed = await prepareOffer(round.policy, s, price, generateKeyPair(party.signerSecret), party.opening);
      const receipt = await this.options.log.submit(sealed.submission, sealed.envelope);
      round.submitted[s] = true;
      round.sealedAt[s] = Date.now();
      round.logIndex[s] = receipt.index;
      if (note) round.notes[s] = note;
      st.touchedAt = Date.now();
      await this.options.saveState(st);
      return { round: round.policy.step, sealed: true, price, logIndex: receipt.index, opensAt: new Date(round.releaseAt).toISOString(), closesAt: new Date(round.closeAt).toISOString() };
    });
  }

  /** What one side may know: its own terms and limit, every opened round, and where the current round stands. */
  status(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.exclusive(async () => {
      const st = this.state!;
      const { side: s, party } = this.partyOf(input.token);
      st.touchedAt = Date.now();
      // Checking in: once both sides have, after both are seated, round 1 begins.
      if (st.parties.buyer && st.parties.seller && st.rounds.length === 0 && !st.done) {
        st.checkedIn = { ...st.checkedIn, [s]: true };
        if (st.checkedIn.buyer && st.checkedIn.seller) {
          st.startedAt = Date.now();
          await this.beginRound((await deadlineRound(this.viewer)).round);
        }
        await this.options.saveState(st);
      }
      const now = Date.now();
      const current = st.done ? undefined : st.rounds.at(-1);
      const last = st.rounds.at(-1);
      const expired = this.expired(st);
      return {
        tableId: st.id,
        yourSide: s,
        yourLimit: party.opening.limit,
        youBidAutonomously: party.autonomous !== false,
        otherOrganisation: st.parties[other(s)]?.organisation ?? null,
        state: expired ? "expired: the other side did not join in time" : !st.parties[other(s)] ? "waiting for the other side to join" : st.done ? "finished" : st.rounds.length === 0 ? "waiting for both sides to check in" : "running",
        ...(!st.parties[other(s)] && st.host === s && !expired ? { invite: st.invite } : {}),
        currentRound: current
          ? {
              round: current.policy.step,
              of: st.terms.rounds,
              phase: now < current.closeAt ? "open for offers" : "closed; offers still sealed",
              secondsUntilClose: Math.max(0, Math.ceil((current.closeAt - now) / 1000)),
              secondsUntilOpen: Math.max(0, Math.ceil((current.releaseAt - now) / 1000)),
              youHaveSealed: current.submitted[s],
              otherSideHasSealed: current.submitted[other(s)],
            }
          : null,
        openedRounds: st.rounds.filter((r) => r.outcome).map((r) => ({ round: r.policy.step, yourOffer: r.opened?.[s] ?? null, theirOffer: r.opened?.[other(s)] ?? null, outcome: r.outcome })),
        result: st.left ? { deal: false, reason: `${st.left === s ? "you" : "the other side"} left the negotiation` } : st.done && last?.outcome ? last.outcome : null,
        ...(st.done ? { receipt: this.receipt(st) } : {}),
        nextStep: expired ? "The table expired before the other side joined. Tell your user, and open a new one if they want to." : nextStep(st, s, current, now),
      };
    });
  }

  /**
   * What anyone can check the negotiation against: each round's policy hash,
   * the drand round that opened it, and where its offers sit in the shared
   * log. The front end adds where to fetch the evidence.
   */
  private receipt(st: TableState): Record<string, unknown> {
    const first = st.rounds[0]?.policy;
    return {
      negotiationId: `table-${st.id}`,
      log: first ? { origin: first.origin, witness: first.witness, cosigners: first.cosigners } : null,
      rounds: st.rounds.map((r) => ({ round: r.policy.step, policyHash: r.hash, closeRound: r.policy.closeRound, openedAtDrandRound: r.policy.releaseRound, logEntries: r.logIndex, outcome: r.outcome ?? null })),
    };
  }

  /** One side walks away. The negotiation ends without a deal, and the other side is told. */
  leave(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.exclusive(async () => {
      const st = this.state!;
      const { side: s } = this.partyOf(input.token);
      if (st.done) fail("the negotiation is already over");
      st.done = true;
      st.left = s;
      st.touchedAt = Date.now();
      await this.options.saveState(st);
      return { tableId: st.id, left: true, result: { deal: false, reason: "you left the negotiation" } };
    });
  }

  /**
   * Do whatever is due: the log does its work, and a released round is judged
   * here (as a party would) to decide whether to go on. Returns milliseconds
   * until it wants calling again, or undefined when there is nothing to do.
   */
  work(): Promise<number | undefined> {
    return this.exclusive(async () => {
      const st = this.state;
      if (!st || st.done) return undefined;
      const round = st.rounds.at(-1);
      if (!round) return undefined;
      await this.options.log.tick().catch(() => {});
      const phase = await this.options.log.phase(round.hash);
      if (phase.state !== "released") return Math.max(500, Math.min(5_000, round.releaseAt - Date.now()));
      const evidence = (await this.options.log.evidence(round.hash)) as unknown as StepInputs;
      const result = await verifyNegotiationStep(evidence, asParty(st.parties.buyer!.identity), { acceptedBeacons: [this.beacon] });
      round.outcome = result.outcome ?? { deal: false, reason: "the round could not be judged" };
      round.opened = Object.fromEntries(result.offers.filter((o) => o.side && o.price !== undefined && o.status === "valid").map((o) => [o.side, o.price]));
      if (round.outcome.deal || st.rounds.length >= st.terms.rounds) st.done = true;
      else await this.beginRound((await deadlineRound(this.viewer)).round);
      await this.options.saveState(st);
      return st.done ? undefined : 500;
    });
  }

  /** The table as the watch page reads it: the Negotiation Room's view, for this table's two firms. */
  async view(): Promise<Record<string, unknown>> {
    const log = await this.options.log.terms();
    const st = this.state;
    const firms = (s: Side) => {
      const name = st?.parties[s]?.organisation ?? (s === "buyer" ? "The buyer" : "The seller");
      return { organisation: name, agent: `${name}’s agent`, role: s === "buyer" ? "Pays" : "Is paid" };
    };
    const base = {
      mode: this.options.mode,
      beacon: this.beacon,
      table: st ? { id: st.id, terms: st.terms, waiting: !st.parties.buyer || !st.parties.seller, ended: st.left ? `${st.parties[st.left]?.organisation ?? "One side"} left the negotiation` : null } : null,
      invoice: st ? { item: st.terms.item, unit: st.terms.unit, minPrice: st.terms.minPrice, maxPrice: st.terms.maxPrice } : null,
      firms: { buyer: firms("buyer"), seller: firms("seller") },
      decider: "each firm’s own AI assistant",
      serverTime: Date.now(),
      ...(log.ownCosigner ? { ownCosigner: log.ownCosigner } : {}),
    };
    if (!st || st.rounds.length === 0) return { ...base, run: null };
    const steps = [];
    for (const r of st.rounds) {
      const phase = await this.options.log.phase(r.hash);
      steps.push({
        step: r.policy.step,
        hash: r.hash,
        closeAt: r.closeAt,
        releaseAt: r.releaseAt,
        phase: phase.state,
        cosigned: phase.cosignatures >= r.policy.cosignerThreshold && phase.state !== "open",
        submitted: r.submitted,
        sealedAt: r.sealedAt,
        logIndex: r.logIndex,
        closeRound: r.policy.closeRound,
        releaseRound: r.policy.releaseRound,
        decidedBy: {},
        // Notes could give a side's strategy away, and the watch link is shared with both sides: show them only at the end.
        notes: st.done ? r.notes : {},
        withheld: [],
      });
    }
    const mandates = { buyer: st.parties.buyer!.mandate, seller: st.parties.seller!.mandate };
    return { ...base, run: { id: 1, rogue: false, useModel: true, done: st.done, startedAt: st.startedAt, negotiationId: `table-${st.id}`, mandates, steps, maxSteps: st.terms.rounds } };
  }

  /** What the two firms disclose about an opened round to anyone watching: the evidence, both file keys and both mandates' openings. */
  private async disclosure(n: number): Promise<Record<string, unknown>> {
    const st = this.state;
    const round = st?.rounds[n - 1];
    if (!st || !round) throw Object.assign(new MatteringError("MALFORMED", "no such round"), { notFound: true });
    if ((await this.options.log.phase(round.hash)).state !== "released") fail("the offers have not opened yet");
    const evidence = (await this.options.log.evidence(round.hash)) as unknown as StepInputs;
    const fileKeys = await discloseStep(evidence, st.parties.buyer!.identity, { acceptedBeacons: [this.beacon] });
    return { evidence, fileKeys, openings: { buyer: st.parties.buyer!.opening, seller: st.parties.seller!.opening } };
  }

  /**
   * `path` is under the table: "/create", "/join", "/offer" and "/status" for
   * the parties (POST, with their token in the body), and "/negotiation/…" for
   * the watch page, which shows what the Negotiation Room page shows.
   */
  async handle(method: string, path: string, body: () => Promise<unknown>): Promise<Reply> {
    try {
      const ok = (value: unknown): Reply => ({ status: 200, body: value });
      const input = async (): Promise<Record<string, unknown>> => {
        const v = await body();
        return v !== null && typeof v === "object" ? (v as Record<string, unknown>) : {};
      };
      const [, first, second, arg] = path.split("/");
      if (method === "POST" && first === "create") {
        const v = await input();
        return ok(await this.create(String(v.tableId ?? ""), v));
      }
      if (!this.state) return { status: 404, body: { error: "no such table" } };
      if (method === "POST" && first === "join") return ok(await this.join(await input()));
      if (method === "POST" && first === "offer") return ok(await this.offer(await input()));
      if (method === "POST" && first === "status") return ok(await this.status(await input()));
      if (method === "POST" && first === "leave") return ok(await this.leave(await input()));
      if (method === "GET" && first === "negotiation" && second === "state") return ok(await this.view());
      if (method === "GET" && first === "negotiation" && second === "disclosure") return ok(await this.disclosure(Number(arg)));
      return { status: 404, body: { error: "no such route" } };
    } catch (error) {
      return errorReply(error);
    }
  }
}
