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

interface StepState {
  policy: NegotiationPolicy;
  hash: string;
  closeAt: number;
  releaseAt: number;
  dueAt: Record<Side, number>;
  submitted: Record<Side, boolean>;
  /** Set once released and judged here. */
  outcome?: StepOutcome;
}

interface RunState {
  id: number;
  negotiationId: string;
  /** The buyer's agent ignores its mandate in the last step. */
  rogue: boolean;
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
      state.runs = id;
      state.run = { id, negotiationId: `INV-2041-early-payment-${Date.now()}-${id}`, rogue, agents, steps: [], done: false };
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
   * Do whatever is due: agents seal their offers, the log does its work, and a
   * released step is judged here to decide whether to go on. Returns the
   * milliseconds after which it wants calling again, or undefined when idle.
   */
  work(): Promise<number | undefined> {
    return this.exclusive(async () => {
      const run = this.state.run;
      if (!run || run.done) return undefined;
      const step = run.steps.at(-1)!;
      for (const side of ["buyer", "seller"] as const) {
        if (step.submitted[side] || step.dueAt[side] > Date.now()) continue;
        step.submitted[side] = true;
        await this.options.saveState(this.state);
        try {
          const agent = run.agents[side];
          const price = scriptedOffer(side, step.policy.step, agent.opening.limit, run.rogue);
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
      if (step.outcome.deal || run.steps.length >= MAX_STEPS) run.done = true;
      else await this.beginStep(run, (await deadlineRound(this.viewer)).round);
      await this.options.saveState(this.state);
      return run.done ? undefined : 500;
    });
  }

  async view(): Promise<Record<string, unknown>> {
    const log = await this.options.log.terms();
    const base = { mode: this.options.mode, beacon: this.beacon, invoice: INVOICE, firms: FIRMS, serverTime: Date.now(), ...(log.ownCosigner ? { ownCosigner: log.ownCosigner } : {}) };
    const run = this.state.run;
    if (!run) return { ...base, run: null };
    const steps = [];
    for (const step of run.steps) {
      const phase = await this.options.log.phase(step.hash);
      steps.push({ step: step.policy.step, hash: step.hash, closeAt: step.closeAt, releaseAt: step.releaseAt, phase: phase.state, cosigned: phase.cosignatures >= step.policy.cosignerThreshold && phase.state !== "open", submitted: step.submitted });
    }
    const mandates = { buyer: run.agents.buyer.mandate, seller: run.agents.seller.mandate };
    return { ...base, run: { id: run.id, rogue: run.rogue, done: run.done, negotiationId: run.negotiationId, mandates, steps } };
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
