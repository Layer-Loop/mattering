/**
 * Scenario demos: a rental listing and an invoice-funding desk, each a sealed
 * auction run on Mattering's platform through its public API and SDK, as an
 * integrator would run one. This object plays the integrator (the letting
 * agent, the funding desk) and the other bidders; the visitor bids from their
 * own browser with the SDK, sealing on their own machine.
 *
 * What is staged, and said on the page: the listing, the invoice and the
 * other bidders are invented, and the other bidders' offers are chosen here.
 * What is real: every bid, the visitor's included, is sealed with the SDK and
 * submitted through the API; nobody, the integrator included, can read one
 * until the public clock releases them; and the visitor's browser works the
 * result out again from the evidence.
 *
 * No server, no files and no timers in here, as in the rooms: the host calls
 * `handle` for requests and `work` when time has passed.
 */
import { generateKeyPair, type BeaconInfo, type BeaconSource } from "@mattering/core";
import { Mattering, type OrganiserSecrets, type ParticipantSecrets } from "../../../packages/client/src/index.ts";
import type { Reply } from "@mattering/witness/routes";

export type ScenarioName = "rental" | "funding";

interface Bidder {
  label: string;
  amount: number;
  secrets: ParticipantSecrets;
  /** When this bidder seals, in milliseconds since the epoch. */
  at: number;
  sealed: boolean;
}

interface Run {
  id: number;
  name: ScenarioName;
  sessionId: string;
  organiser: OrganiserSecrets;
  /** The visitor's invitation: they join with it from their browser. */
  invitation: string;
  others: Bidder[];
  startedAt: number;
  done: boolean;
  /** Set if the run could not finish. */
  failed?: string;
}

export interface ScenarioState {
  version: 1;
  runs: number;
  run?: Run;
}

export interface ScenarioOptions {
  mode: "live" | "simulated";
  sourceFor: () => BeaconSource;
  /** How this object reaches the platform API: in the same process, as a `fetch`. */
  apiFetch: (request: Request) => Promise<Response>;
  /** An API key the platform knows as this demo's integrator. */
  apiKey: string;
  loadState: () => Promise<ScenarioState | undefined>;
  saveState: (state: ScenarioState) => Promise<void>;
  /** Refuse to start more than this many runs. */
  maxRuns?: number;
}

/** The two scenarios: their terms, and the other bidders' offers. */
const SCENARIOS: Record<ScenarioName, { terms: Record<string, unknown>; biddingSeconds: number; visitor: string; others: () => { label: string; amount: number }[] }> = {
  rental: {
    terms: { item: "2-bedroom flat, Larkspur Court, Hackney E8: 12-month tenancy", unit: "GBP pcm", minBid: 2100, maxBid: 2400, rule: "highest-bid" },
    biddingSeconds: 45,
    visitor: "You",
    // Rents cannot go over the advertised £2,400, so most keen applicants offer exactly that.
    others: () => [
      { label: "Applicant A", amount: 2400 },
      { label: "Applicant B", amount: 2400 },
      { label: "Applicant C", amount: pick([2300, 2350, 2375]) },
      { label: "Applicant D", amount: pick([2200, 2250, 2300]) },
    ],
  },
  funding: {
    terms: { item: "Funding of invoice INV-88213: £250,000, due in 90 days", unit: "bps", minBid: 50, maxBid: 1500, rule: "lowest-bid", reserve: 900 },
    biddingSeconds: 45,
    visitor: "Your fund",
    others: () => [
      { label: "Funder A", amount: 640 + pick([0, 25, 50, 75]) },
      { label: "Funder B", amount: 690 + pick([0, 20, 40]) },
      { label: "Funder C", amount: 880 + pick([0, 15, 30]) },
    ],
  },
};
const pick = <T>(items: T[]): T => items[Math.floor(Math.random() * items.length)]!;

export class Scenario {
  private busy: Promise<unknown> = Promise.resolve();
  private readonly mattering: Mattering;
  private readonly beacon: BeaconInfo;
  /** The finished run's evidence, kept in memory: it can be fetched again. */
  private evidence?: { runId: number; bundle: unknown };

  private constructor(
    private readonly options: ScenarioOptions,
    private state: ScenarioState,
  ) {
    this.beacon = options.sourceFor().beacon;
    this.mattering = new Mattering({ baseUrl: "https://platform/api/v1", apiKey: options.apiKey, fetch: ((input: RequestInfo | URL, init?: RequestInit) => options.apiFetch(new Request(input, init))) as typeof fetch, acceptedBeacons: [this.beacon], attempts: 2 });
  }

  static async open(options: ScenarioOptions): Promise<Scenario> {
    const saved = await options.loadState();
    return new Scenario(options, saved?.version === 1 ? saved : { version: 1, runs: 0 });
  }

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.busy.then(fn);
    this.busy = run.catch(() => {});
    return run;
  }

  /** Start a scenario: the integrator lists it, the other bidders join, and bidding opens. */
  start(name: ScenarioName): Promise<Record<string, unknown>> {
    return this.exclusive(async () => {
      const max = this.options.maxRuns ?? 20;
      if (this.state.runs >= max) throw new Error(`this demo has run ${max} times; open it in a new browser tab to run it again`);
      const s = SCENARIOS[name];
      const others = s.others();
      const session = await this.mattering.sessions.create({
        mechanism: "sealed-bid-auction",
        terms: s.terms,
        timing: { biddingSeconds: s.biddingSeconds },
        invitations: [{ label: s.visitor }, ...others.map((o) => ({ label: o.label }))],
      });
      const codes = session.invitations.map((i) => i.code!);
      const bidders: Bidder[] = [];
      for (const [i, other] of others.entries()) {
        const p = await this.mattering.join(codes[i + 1]!);
        bidders.push({ ...other, secrets: p.secrets(), at: 0, sealed: false });
      }
      const opened = await session.open();
      const closesAt = Date.parse(opened.round!.closesAt);
      const now = Date.now();
      // The others seal at moments spread through the window, finishing well before it closes.
      for (const [i, b] of bidders.entries()) b.at = now + ((closesAt - now) * (0.15 + (0.5 * i) / Math.max(1, bidders.length - 1))) * (0.85 + Math.random() * 0.2);
      this.state.runs += 1;
      this.state.run = { id: this.state.runs, name, sessionId: session.id, organiser: session.secrets(), invitation: codes[0]!, others: bidders, startedAt: now, done: false };
      await this.options.saveState(this.state);
      return this.view();
    });
  }

  /**
   * Do whatever is due: the other bidders seal when their moment comes, and
   * once the bids are released the integrator opens them with its own key and
   * publishes the result. Returns milliseconds until it wants calling again.
   */
  work(): Promise<number | undefined> {
    return this.exclusive(async () => {
      const run = this.state.run;
      if (!run || run.done) return undefined;
      try {
        const now = Date.now();
        for (const b of run.others) {
          if (b.sealed || now < b.at) continue;
          b.sealed = true;
          await this.mattering.resume(b.secrets).bid(b.amount).catch(() => {});
        }
        const organiser = this.mattering.resume(run.organiser);
        const view = await organiser.state();
        if (view.phase === "released" && view.awaiting) await organiser.disclose();
        if (["finished", "cancelled", "expired"].includes((await organiser.state()).phase)) run.done = true;
      } catch (error) {
        run.failed = (error as Error).message;
        run.done = true;
      }
      await this.options.saveState(this.state);
      if (run.done) return undefined;
      const next = run.others.filter((b) => !b.sealed).map((b) => b.at - Date.now());
      return Math.max(250, Math.min(1000, ...next));
    });
  }

  /** What the page needs: the listing's session and timing, who has sealed, and once finished, everything to check the result. */
  async view(): Promise<Record<string, unknown>> {
    const base = { mode: this.options.mode, beacon: this.beacon, runs: this.state.runs };
    const run = this.state.run;
    if (!run) return { ...base, run: null };
    const organiser = this.mattering.resume(run.organiser);
    const session = await organiser.state();
    const finished = session.phase === "finished";
    if (finished && this.evidence?.runId !== run.id) this.evidence = { runId: run.id, bundle: await organiser.evidence() };
    return {
      ...base,
      run: {
        id: run.id,
        name: run.name,
        sessionId: run.sessionId,
        invitation: run.invitation,
        terms: session.terms,
        phase: session.phase,
        round: session.round ?? null,
        others: run.others.map((b) => ({ label: b.label, sealed: b.sealed, publicKey: generateKeyPair(b.secrets.signingKey!).publicKey })),
        ...(run.failed ? { failed: run.failed } : {}),
        // What the integrator sees once the bids open: every bid, and the evidence with the keys to check them.
        ...(finished ? { outcome: session.outcome, receipt: session.receipt, evidence: this.evidence!.bundle } : {}),
      },
    };
  }

  async handle(method: string, path: string, body: () => Promise<unknown>): Promise<Reply> {
    try {
      if (method === "POST" && path === "/scenario/start") {
        const name = ((await body()) as { name?: unknown } | null)?.name;
        if (name !== "rental" && name !== "funding") return { status: 400, body: { error: 'name: want "rental" or "funding"' } };
        return { status: 200, body: await this.start(name) };
      }
      if (method === "GET" && path === "/scenario/state") return { status: 200, body: await this.view() };
      return { status: 404, body: { error: "no such route" } };
    } catch (error) {
      return { status: 409, body: { error: (error as Error).message } };
    }
  }
}
