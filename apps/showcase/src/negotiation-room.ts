/**
 * The Negotiation Room: two firms' software agents negotiate early payment of
 * an invoice in sealed steps, on the shared log, each under a mandate from its
 * organisation. No server, no files and no timers in here, as in `room.ts`.
 *
 * In a real deployment each agent runs at its own firm and holds its own keys.
 * Here both run in this process, which is staged and said on the page. What is
 * real: the offers are sealed to both parties only and to the step's release
 * round, the log closes and is cosigned before they open, and the page works
 * out every step itself from evidence the two organisations disclose to it.
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
import { asParty, discloseStep, negotiationPolicyHash, prepareOffer, verifyNegotiationStep, type StepInputs, type StepOutcome } from "@mattering/core/negotiation";
import { generateRecipientKeys, openAs } from "@mattering/core/recipients";
import { errorReply, type Reply } from "@mattering/witness/routes";
import type { LogHost } from "./log-host.ts";
import { acceptOffer, type OfferAsk, type OfferDecider } from "./llm.ts";

/** The deal: Acme pays Bolt's £10,000 invoice 60 days early, for less. The price is what Acme pays now. */
export const INVOICE = {
  item: "Pay invoice INV-2041 (£10,000, due in 60 days) today: the amount paid now",
  unit: "GBP",
  minPrice: 9_000,
  maxPrice: 10_000,
} as const;

export const FIRMS = {
  buyer: { organisation: "Acme Treasury Ltd", agent: "Acme's treasury agent", role: "Pays the invoice early if the discount is worth it" },
  seller: { organisation: "Bolt Components plc", agent: "Bolt's sales agent", role: "Takes less now in exchange for cash today" },
} as const;

const MAX_STEPS = 3;

interface AgentState {
  orgSecret: string;
  orgPublic: string;
  signerSecret: string;
  identity: string;
  recipient: string;
  mandate: Mandate;
  opening: MandateOpening;
}

/** An offer an agent has chosen for a step, with its note if it may be shown. */
interface DecidedOffer {
  price: number;
  note?: string;
  noteWithheld?: boolean;
}

interface StepState {
  policy: NegotiationPolicy;
  hash: string;
  closeAt: number;
  releaseAt: number;
  dueAt: Record<Side, number>;
  submitted: Record<Side, boolean>;
  /** What chose each side's offer, once chosen. */
  decidedBy?: Partial<Record<Side, "model" | "script">>;
  /** Each agent's note to its firm, published only once the step has opened. */
  notes?: Partial<Record<Side, string>>;
  /** Sides whose note was withheld for stating an amount the agent could not have seen. */
  withheld?: Side[];
  /** Both offers, once the step has opened and been judged here: the history the agents see next. */
  opened?: Partial<Record<Side, number>>;
  /** Set once released and judged here. */
  outcome?: StepOutcome;
}

interface RunState {
  id: number;
  negotiationId: string;
  /** The buyer's agent ignores its mandate in the last step. */
  rogue: boolean;
  /** Whether a language model may choose offers in this negotiation, decided once at the start. */
  useModel: boolean;
  agents: Record<Side, AgentState>;
  steps: StepState[];
  done: boolean;
}

export interface NegotiationRoomState {
  version: 1;
  runs: number;
  run?: RunState;
}

export interface NegotiationRoomOptions {
  mode: "live" | "simulated";
  sourceFor: () => BeaconSource;
  timeOfRound: (round: number) => number;
  log: LogHost;
  loadState: () => Promise<NegotiationRoomState | undefined>;
  saveState: (state: NegotiationRoomState) => Promise<void>;
  /** Rounds from a step's start to its close, and from close to release. */
  closeAfter: number;
  releaseAfter: number;
  /** Milliseconds between a step starting and each agent sealing its offer. */
  agentGapMs: number;
  maxRuns?: number;
  /** A language model to choose the agents' offers. Without it, their scripts do. */
  decide?: OfferDecider;
  /** What to call that model on the page, such as "Claude Haiku 5.5". */
  decideLabel?: string;
  /** Called once per negotiation before the model is used; return false to use the scripts. */
  allowModel?: () => Promise<boolean>;
  /** Milliseconds to wait for the model before the script decides. */
  decideTimeoutMs?: number;
}

const round5 = (n: number): number => Math.round(n / 5) * 5;

/**
 * What each agent offers at each step: the buyer starts low and the seller
 * high, and each concedes toward its mandate's limit, reaching it at the last
 * step. A rogue buyer goes past its limit at the last step.
 */
export function scriptedOffer(side: Side, step: number, limit: number, rogue: boolean): number {
  const start = side === "buyer" ? 9_400 : 9_950;
  if (step >= MAX_STEPS) return side === "buyer" && rogue ? limit + 150 : limit;
  return round5(start + (limit - start) * (step === 1 ? 0 : 0.6));
}

export class NegotiationRoom {
  private busy: Promise<unknown> = Promise.resolve();
  /** Offers chosen but not yet sealed, with the agents' notes. Held in memory only, never stored. */
  private decided: { runId: number; step: number; offers: Record<Side, DecidedOffer> } | undefined;

  private constructor(
    private readonly options: NegotiationRoomOptions,
    private readonly viewer: BeaconSource,
    private state: NegotiationRoomState,
  ) {}

  static async open(options: NegotiationRoomOptions): Promise<NegotiationRoom> {
    let state = await options.loadState();
    if (state?.version !== 1) {
      state = { version: 1, runs: 0 };
      await options.saveState(state);
    }
    return new NegotiationRoom(options, options.sourceFor(), state);
  }

  get beacon(): BeaconInfo {
    return this.viewer.beacon;
  }

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.busy.then(fn);
    this.busy = run.catch(() => {});
    return run;
  }

  /** Start a negotiation: each organisation issues its agent a mandate, and step 1 begins. */
  start(rogue: boolean): Promise<void> {
    return this.exclusive(async () => {
      const { options, state } = this;
      if (options.maxRuns !== undefined && state.runs >= options.maxRuns) throw new MatteringError("POLICY", "this room has run its limit of negotiations; reload the page");
      const now = (await deadlineRound(this.viewer)).round;
      const id = state.runs + 1;
      // Mandates must outlast every step's close.
      const expires = closeTime(this.beacon, now + MAX_STEPS * (options.closeAfter + options.releaseAfter + 5)) + 3600;
      const agents = {} as Record<Side, AgentState>;
      for (const side of ["buyer", "seller"] as const) {
        const org = generateKeyPair();
        const signer = generateKeyPair();
        const box = await generateRecipientKeys();
        // Limits drawn so that the two overlap: a deal is possible, at a price neither side knows.
        const limit = side === "buyer" ? round5(9_700 + Math.random() * 100) : round5(9_600 + Math.random() * 100);
        const { mandate, opening } = issueMandate(org, { organisationName: FIRMS[side].organisation, agent: signer.publicKey, side, unit: INVOICE.unit, limit, expires });
        agents[side] = { orgSecret: org.secretKey, orgPublic: org.publicKey, signerSecret: signer.secretKey, identity: box.identity, recipient: box.recipient, mandate, opening };
      }
      const useModel = options.decide !== undefined && (options.allowModel ? await options.allowModel().catch(() => false) : true);
      state.runs = id;
      state.run = { id, negotiationId: `INV-2041-early-payment-${Date.now()}-${id}`, rogue, useModel, agents, steps: [], done: false };
      await this.beginStep(state.run, now);
      await options.saveState(state);
    });
  }

  private async beginStep(run: RunState, now: number): Promise<void> {
    const log = await this.options.log.terms();
    const previous = run.steps.at(-1);
    const closeRound = now + this.options.closeAfter;
    const releaseRound = closeRound + this.options.releaseAfter;
    const party = (side: Side) => ({ signer: generateKeyPair(run.agents[side].signerSecret).publicKey, recipient: run.agents[side].recipient, mandate: run.agents[side].mandate });
    const policy: NegotiationPolicy = {
      format: NEGOTIATION_POLICY_FORMAT,
      negotiationId: run.negotiationId,
      step: run.steps.length + 1,
      previous: previous?.hash ?? "",
      ...INVOICE,
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
    const started = Date.now();
    run.steps.push({
      policy,
      hash,
      closeAt: this.options.timeOfRound(closeRound),
      releaseAt: this.options.timeOfRound(releaseRound),
      dueAt: { buyer: started + this.options.agentGapMs, seller: started + 2 * this.options.agentGapMs },
      submitted: { buyer: false, seller: false },
    });
  }

  private signer(run: RunState, side: Side) {
    return generateKeyPair(run.agents[side].signerSecret);
  }

  /**
   * Both agents choose this step's offer, at once. The model is asked if there
   * is one; whatever it returns is checked, and anything unusable, slow,
   * failed, or beyond the agent's mandate is replaced by the script. A rogue
   * Acme ignores its mandate in the last step, by script, whatever the model.
   */
  private async decideStep(run: RunState, step: StepState): Promise<void> {
    const n = step.policy.step;
    const timeout = this.options.decideTimeoutMs ?? 10_000;
    const decide = this.options.decide;
    step.decidedBy = {};
    const offers = {} as Record<Side, DecidedOffer>;
    await Promise.all(
      (["buyer", "seller"] as const).map(async (side) => {
        const limit = run.agents[side].opening.limit;
        const scripted = { price: scriptedOffer(side, n, limit, run.rogue) };
        const rogueNow = side === "buyer" && run.rogue && n >= MAX_STEPS;
        if (!run.useModel || !decide || rogueNow) {
          step.decidedBy![side] = "script";
          offers[side] = scripted;
          return;
        }
        const other: Side = side === "buyer" ? "seller" : "buyer";
        const ask: OfferAsk = {
          side,
          organisation: FIRMS[side].organisation,
          role: FIRMS[side].role,
          item: INVOICE.item,
          minPrice: INVOICE.minPrice,
          maxPrice: INVOICE.maxPrice,
          faceValue: 10_000,
          step: n,
          maxSteps: MAX_STEPS,
          limit,
          history: run.steps.filter((s) => s.opened?.[side] !== undefined && s.opened?.[other] !== undefined).map((s) => ({ step: s.policy.step, mine: s.opened![side]!, theirs: s.opened![other]! })),
        };
        try {
          const answer = await Promise.race([decide(ask), new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("timed out")), timeout))]);
          const accepted = acceptOffer(ask, answer);
          if (accepted) {
            step.decidedBy![side] = "model";
            offers[side] = { price: accepted.offer, ...(accepted.note ? { note: accepted.note } : {}), ...(accepted.noteWithheld ? { noteWithheld: true } : {}) };
            if (accepted.noteWithheld) console.error(`${side}: the model's note named an amount the agent had not seen; it is withheld`);
            return;
          }
          console.error(`${side}: the model's offer was not usable or not within the mandate; using the script`);
        } catch {
          // already logged by the decider; the script decides
        }
        step.decidedBy![side] = "script";
        offers[side] = scripted;
      }),
    );
    this.decided = { runId: run.id, step: n, offers };
  }

  /**
   * Do whatever is due: agents seal their offers, the log does its work, and a
   * released step is judged here to decide whether to go on. Returns the
   * milliseconds after which it wants calling again, or undefined when idle.
   */
  work(): Promise<number | undefined> {
    return this.exclusive(async () => {
      const run = this.state.run;
      if (!run || run.done) return undefined;
      const step = run.steps.at(-1)!;
      const unsealed = !step.submitted.buyer || !step.submitted.seller;
      if (unsealed && (this.decided?.runId !== run.id || this.decided.step !== step.policy.step)) {
        await this.decideStep(run, step);
        await this.options.saveState(this.state);
      }
      for (const side of ["buyer", "seller"] as const) {
        if (step.submitted[side] || step.dueAt[side] > Date.now()) continue;
        step.submitted[side] = true;
        await this.options.saveState(this.state);
        try {
          const agent = run.agents[side];
          const price = this.decided!.offers[side].price;
          // An honest agent's software refuses an offer beyond its mandate; the rogue one skips the check.
          const opening = side === "buyer" && run.rogue ? undefined : agent.opening;
          const offer = await prepareOffer(step.policy, side, price, this.signer(run, side), opening);
          await this.options.log.submit(offer.submission, offer.envelope);
        } catch (error) {
          console.error(`${side}: ${(error as Error).message}`);
        }
      }
      await this.options.log.tick().catch(() => {});
      const phase = await this.options.log.phase(step.hash);
      if (phase.state !== "released") return 500;
      // The step is open. Judge it as one of the parties would, to decide whether to go on.
      const evidence = (await this.options.log.evidence(step.hash)) as unknown as StepInputs;
      const result = await verifyNegotiationStep(evidence, asParty(run.agents.buyer.identity), { acceptedBeacons: [this.beacon] });
      step.outcome = result.outcome ?? { deal: false, reason: "the step could not be judged" };
      // Both sides see both offers once a step opens: that is what the agents are told next time.
      step.opened = Object.fromEntries(result.offers.filter((o) => o.side && o.price !== undefined && o.status === "valid").map((o) => [o.side, o.price]));
      const notes = this.decided?.runId === run.id && this.decided.step === step.policy.step ? this.decided.offers : undefined;
      step.notes = Object.fromEntries((["buyer", "seller"] as const).filter((s) => notes?.[s]?.note).map((s) => [s, notes![s].note!]));
      step.withheld = (["buyer", "seller"] as const).filter((s) => notes?.[s]?.noteWithheld);
      if (step.outcome.deal || run.steps.length >= MAX_STEPS) run.done = true;
      else await this.beginStep(run, (await deadlineRound(this.viewer)).round);
      await this.options.saveState(this.state);
      return run.done ? undefined : 500;
    });
  }

  async view(): Promise<Record<string, unknown>> {
    const log = await this.options.log.terms();
    // Who will choose the offers, said before anything starts: a model by name, or the scripts.
    const decider = this.options.decide ? (this.options.decideLabel ?? "a language model") : null;
    const base = { mode: this.options.mode, beacon: this.beacon, invoice: INVOICE, firms: FIRMS, decider, serverTime: Date.now(), ...(log.ownCosigner ? { ownCosigner: log.ownCosigner } : {}) };
    const run = this.state.run;
    if (!run) return { ...base, run: null };
    const steps = [];
    for (const step of run.steps) {
      const phase = await this.options.log.phase(step.hash);
      steps.push({
        step: step.policy.step,
        hash: step.hash,
        closeAt: step.closeAt,
        releaseAt: step.releaseAt,
        phase: phase.state,
        cosigned: phase.cosignatures >= step.policy.cosignerThreshold && phase.state !== "open",
        submitted: step.submitted,
        decidedBy: step.decidedBy ?? {},
        // Notes can give an offer away, so they are shown only once the step has opened.
        notes: phase.state === "released" ? (step.notes ?? {}) : {},
        withheld: phase.state === "released" ? (step.withheld ?? []) : [],
      });
    }
    const mandates = { buyer: run.agents.buyer.mandate, seller: run.agents.seller.mandate };
    return { ...base, run: { id: run.id, rogue: run.rogue, useModel: run.useModel, done: run.done, negotiationId: run.negotiationId, mandates, steps } };
  }

  /**
   * What the two organisations disclose about a released step, as they would
   * to an auditor: the evidence, the file keys of both offers, and their
   * mandates' openings. With these the page works the step out itself.
   */
  private async disclosure(stepNumber: number): Promise<Record<string, unknown>> {
    const run = this.state.run;
    const step = run?.steps[stepNumber - 1];
    if (!run || !step) throw Object.assign(new MatteringError("MALFORMED", "no such step"), { notFound: true });
    if ((await this.options.log.phase(step.hash)).state !== "released") throw new MatteringError("POLICY", "the offers have not opened yet");
    const evidence = (await this.options.log.evidence(step.hash)) as unknown as StepInputs;
    const fileKeys = await discloseStep(evidence, run.agents.buyer.identity, { acceptedBeacons: [this.beacon] });
    return { evidence, fileKeys, openings: { buyer: run.agents.buyer.opening, seller: run.agents.seller.opening } };
  }

  /** Bolt's agent tries to read Acme's offer before the step's release round, with its own key and the newest beacon signature there is. */
  private async peek(): Promise<Record<string, unknown>> {
    const run = this.state.run;
    const step = run?.steps.at(-1);
    if (!run || !step) throw new MatteringError("POLICY", "no negotiation is running");
    if ((await this.options.log.phase(step.hash)).state === "released") throw new MatteringError("POLICY", "these offers are open already; try during the next step");
    const offer = (await this.options.log.submissions(step.hash)).find((s) => s.submitter === step.policy.buyer.signer);
    if (!offer) throw new MatteringError("POLICY", "Acme's agent has not sealed its offer yet; try again in a moment");
    const envelope = (await this.options.log.api("GET", `/envelopes/${offer.envelopeId}`, new URLSearchParams(), async () => undefined)).body as never;
    const latest = await this.viewer.latest();
    try {
      await openAs(envelope, latest, run.agents.seller.identity, { acceptedBeacons: [this.beacon] });
      return { opened: true };
    } catch (error) {
      return { opened: false, round: latest.round, needed: step.policy.releaseRound, code: (error as MatteringError).code };
    }
  }

  /** Bolt's agent, having seen Acme's offer, tries to replace its own with a better one. */
  private async revise(): Promise<Record<string, unknown>> {
    const run = this.state.run;
    const step = [...(run?.steps ?? [])].reverse().find((s) => s.outcome);
    if (!run || !step) throw new MatteringError("POLICY", "no offers have opened yet; try once a step has opened");
    const offer = await prepareOffer(step.policy, "seller", INVOICE.maxPrice - 50, this.signer(run, "seller"));
    try {
      await this.options.log.submit(offer.submission, offer.envelope);
      return { accepted: true, step: step.policy.step };
    } catch (error) {
      return { accepted: false, step: step.policy.step, reason: (error as Error).message };
    }
  }

  async handle(method: string, path: string, query: URLSearchParams, body: () => Promise<unknown>): Promise<Reply> {
    try {
      const ok = (value: unknown): Reply => ({ status: 200, body: value });
      const [, , what, arg] = path.split("/");
      switch (`${method} ${what}`) {
        case "GET state":
          return ok(await this.view());
        case "POST start": {
          const options = ((await body()) ?? {}) as { rogue?: boolean };
          await this.start(options.rogue === true);
          return ok(await this.view());
        }
        case "GET disclosure":
          return ok(await this.disclosure(Number(arg)));
        case "POST peek":
          return ok(await this.peek());
        case "POST revise":
          return ok(await this.revise());
        case "GET latest":
          return ok(await this.viewer.latest());
        default:
          void query;
          return { status: 404, body: { error: "no such route" } };
      }
    } catch (error) {
      return errorReply(error);
    }
  }
}
