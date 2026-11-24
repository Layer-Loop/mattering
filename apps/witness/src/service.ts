/**
 * The witness and registry as a service: policies, submissions, the log,
 * closing on the beacon's clock, cosignatures, and published evidence.
 *
 * This file has no HTTP, no file system and no timers in it, so it runs the
 * same on a laptop and in a hosted runtime. State goes through a `ServiceStore`.
 */
import {
  MatteringError,
  POLICY_FORMAT,
  STATEMENT_POLICY_FORMAT,
  Witness,
  assertEnvelope,
  deadlineRound,
  envelopeId,
  policyHash,
  sameBeacon,
  statementPolicyHash,
  countCosignatures,
  parseVkey,
  verifyAuction,
  verifySealedStatement,
  verifySealedSubmission,
  verifyStatements,
  verifySubmissionSignature,
  type AuctionPolicy,
  type AuctionResult,
  type BeaconSource,
  type Checkpoint,
  type Envelope,
  type PolicyTerms,
  type Receipt,
  type Release,
  type StatementPolicy,
  type StatementsResult,
  type LogEntry,
  type Submission,
  type WitnessedCheckpoint,
  isSubmission,
  closeEntry,
  entryLeafHash,
} from "@mattering/core";

export type AnyPolicy = AuctionPolicy | StatementPolicy;
export type PolicyKind = "auction" | "statements";

/**
 * Send one C2SP tlog-witness add-checkpoint request to the cosigner with this
 * verifier key. Resolves to its HTTP status and body, or undefined if it
 * cannot be reached.
 */
export type CosignRequest = (cosigner: string, body: string) => Promise<{ status: number; body: string } | undefined>;

export interface StoredClosing {
  closing: Checkpoint;
  witnessed?: WitnessedCheckpoint;
}

export interface StoredState {
  /** The witness's signing key, if one has been saved. */
  secretKey?: string;
  /** The log's leaf hashes in order, lowercase hex. The entries themselves stay in the store. */
  leafHashes: string[];
  /** Policies not yet retired, with the closings of those that have closed. Retired ones are read on demand. */
  policies: AnyPolicy[];
  closings: Record<string, StoredClosing>;
}

/**
 * Where a witness keeps its state. Every write must be durable before it
 * resolves. The service holds only leaf hashes in memory, so a log can grow
 * long; entries are read back from here when evidence or the log is asked for.
 */
export interface ServiceStore {
  load(): Promise<StoredState>;
  saveKey(secretKey: string): Promise<void>;
  appendEntry(index: number, entry: LogEntry, leafHash: string): Promise<void>;
  /** Entries [from, to) in log order. */
  readEntries(from: number, to: number): Promise<LogEntry[]>;
  savePolicy(hash: string, policy: AnyPolicy): Promise<void>;
  /** One policy and its closing, retired or not. */
  loadPolicy(hash: string): Promise<{ policy: AnyPolicy; closing?: StoredClosing | undefined } | undefined>;
  /** The policy is released and its evidence final: `load` need not return it any more. */
  retirePolicy(hash: string): Promise<void>;
  saveEnvelope(id: string, envelope: Envelope): Promise<void>;
  loadEnvelope(id: string): Promise<Envelope | undefined>;
  saveClosing(hash: string, value: StoredClosing): Promise<void>;
}

/** A store that forgets everything when the process ends. For tests and demonstrations. */
export function memoryStore(): ServiceStore {
  const state: { secretKey?: string; leafHashes: string[]; policies: Map<string, AnyPolicy>; closings: Record<string, StoredClosing> } = { leafHashes: [], policies: new Map(), closings: {} };
  const retired = new Set<string>();
  const entries: LogEntry[] = [];
  const envelopes = new Map<string, Envelope>();
  return {
    load: async () => {
      const active = [...state.policies].filter(([hash]) => !retired.has(hash));
      const closings = Object.fromEntries(Object.entries(state.closings).filter(([hash]) => !retired.has(hash)));
      return structuredClone({ ...(state.secretKey ? { secretKey: state.secretKey } : {}), leafHashes: state.leafHashes, policies: active.map(([, p]) => p), closings });
    },
    saveKey: async (secretKey) => void (state.secretKey = secretKey),
    appendEntry: async (index, entry, leafHash) => {
      entries[index] = structuredClone(entry);
      state.leafHashes[index] = leafHash;
    },
    readEntries: async (from, to) => structuredClone(entries.slice(from, to)),
    savePolicy: async (hash, policy) => void state.policies.set(hash, structuredClone(policy)),
    loadPolicy: async (hash) => {
      const policy = state.policies.get(hash);
      return policy && structuredClone({ policy, closing: state.closings[hash] });
    },
    retirePolicy: async (hash) => void retired.add(hash),
    saveEnvelope: async (id, envelope) => void envelopes.set(id, envelope),
    loadEnvelope: async (id) => envelopes.get(id),
    saveClosing: async (hash, value) => void (state.closings[hash] = structuredClone(value)),
  };
}

export interface ServiceOptions {
  store: ServiceStore;
  /** This witness's own view of the beacon. */
  source: BeaconSource;
  /** The log's C2SP origin. Defaults to one derived from the witness's key. Fix it before the first policy. */
  origin?: string | undefined;
  /** The witness's signing key, if it is kept outside the store (a deployment secret). Otherwise the store's, or a new one. */
  secretKey?: string | undefined;
  cosign?: CosignRequest;
  /**
   * Refuse a policy whose `logFrom` is more than this many entries behind the
   * log, so that no policy's evidence has to carry a long stretch of other
   * policies' entries. Default 10,000.
   */
  maxPolicyLag?: number;
}

interface PolicyRecord {
  hash: string;
  kind: PolicyKind;
  policy: AnyPolicy;
  /** Submissions under this policy so far. Kept for open policies only. */
  count: number;
  closing?: Checkpoint;
  witnessed?: WitnessedCheckpoint | undefined;
}

export interface EvidenceBundle {
  policy: AnyPolicy;
  policyHash: string;
  /** "open": accepting submissions. "closed": sealed, waiting for release. "released": can be opened. */
  state: "open" | "closed" | "released";
  /** The log from the policy's `logFrom` to its closing checkpoint. */
  entries?: LogEntry[];
  /** The log before `logFrom`, as its compact range. */
  prefix?: string[];
  closing?: Checkpoint;
  witnessed?: WitnessedCheckpoint | undefined;
  envelopes?: Record<string, Envelope>;
  release?: Release;
}

function describe(policy: unknown): { hash: string; kind: PolicyKind } {
  const format = (policy as { format?: unknown } | null)?.format;
  if (format === POLICY_FORMAT) return { hash: policyHash(policy as AuctionPolicy), kind: "auction" };
  if (format === STATEMENT_POLICY_FORMAT) return { hash: statementPolicyHash(policy as StatementPolicy), kind: "statements" };
  throw new MatteringError("MALFORMED", "unknown policy format");
}

function notFound(what: string): MatteringError {
  return Object.assign(new MatteringError("MALFORMED", `${what} not found`), { notFound: true });
}

const HEX32 = /^[0-9a-f]{64}$/;
/** Most entries returned by one read of the log. */
export const LOG_PAGE = 1000;
const DEFAULT_MAX_POLICY_LAG = 10_000;

export class WitnessService {
  private readonly results = new Map<string, AuctionResult | StatementsResult>();
  /** The latest size each cosigner has cosigned for this log, as far as this process knows. */
  private readonly cosignedSize = new Map<string, number>();
  /** Cosignature lines already collected for the log at one size, by cosigner, so no cosigner is asked twice for the same checkpoint. */
  private collected: { size: number; lines: Map<string, string> } = { size: -1, lines: new Map() };
  private queue: Promise<unknown> = Promise.resolve();

  private constructor(
    private readonly options: ServiceOptions,
    private readonly witness: Witness,
    private readonly policies: Map<string, PolicyRecord>,
  ) {}

  /** Load a witness from its store, creating its signing key on first use. */
  static async open(options: ServiceOptions): Promise<WitnessService> {
    const stored = await options.store.load();
    const policies = new Map<string, PolicyRecord>();
    const closings: [string, Checkpoint][] = [];
    for (const policy of stored.policies) {
      const { hash, kind } = describe(policy);
      const saved = stored.closings[hash];
      const record: PolicyRecord = { hash, kind, policy, count: 0 };
      if (saved) {
        record.closing = saved.closing;
        record.witnessed = saved.witnessed;
        closings.push([hash, saved.closing]);
      }
      policies.set(hash, record);
    }
    const witness = new Witness(options.secretKey ?? stored.secretKey, { leafHashes: stored.leafHashes, closings }, options.origin);
    if (!options.secretKey && !stored.secretKey) await options.store.saveKey(witness.keys.secretKey);
    // Count what open policies already hold. They are recent, so this reads only the end of the log.
    const open = [...policies.values()].filter((r) => !r.closing);
    if (open.length > 0) {
      const from = Math.min(...open.map((r) => r.policy.logFrom));
      for (let at = from; at < witness.size; at += LOG_PAGE) {
        for (const entry of await options.store.readEntries(at, Math.min(at + LOG_PAGE, witness.size))) {
          const record = isSubmission(entry) ? policies.get(entry.policyHash) : undefined;
          if (record && !record.closing) record.count += 1;
        }
      }
    }
    return new WitnessService(options, witness, policies);
  }

  get publicKey(): string {
    return this.witness.publicKey;
  }

  /** The log's origin and verifier key: what a cosigner is configured with. */
  get origin(): string {
    return this.witness.origin;
  }

  get vkey(): string {
    return this.witness.vkey;
  }

  /** Run state-changing work one at a time, so the log has one order. */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn);
    this.queue = run.catch(() => {});
    return run;
  }

  /** A policy, whether still live in memory or retired to the store. */
  private async lookup(hash: string): Promise<PolicyRecord> {
    const live = HEX32.test(hash) ? this.policies.get(hash) : undefined;
    if (live) return live;
    const saved = HEX32.test(hash) ? await this.options.store.loadPolicy(hash) : undefined;
    if (!saved) throw notFound("policy");
    const record: PolicyRecord = { hash, kind: describe(saved.policy).kind, policy: saved.policy, count: 0 };
    if (saved.closing) {
      record.closing = saved.closing.closing;
      record.witnessed = saved.closing.witnessed;
    }
    return record;
  }

  /** The log's size now: what a new policy names as its `logFrom`. */
  get size(): number {
    return this.witness.size;
  }

  info(): { witness: string; origin: string; vkey: string; beacon: BeaconSource["beacon"]; size: number; policies: number } {
    return { witness: this.publicKey, origin: this.origin, vkey: this.vkey, beacon: this.options.source.beacon, size: this.witness.size, policies: this.policies.size };
  }

  /** The policies still live: open, or closed and not yet released. */
  listPolicies(): { policyHash: string; kind: PolicyKind; closeRound: number; releaseRound: number; closed: boolean }[] {
    return [...this.policies.values()].map((r) => ({ policyHash: r.hash, kind: r.kind, closeRound: r.policy.closeRound, releaseRound: r.policy.releaseRound, closed: r.closing !== undefined }));
  }

  registerPolicy(policy: unknown): Promise<{ policyHash: string }> {
    return this.exclusive(async () => {
      const { hash, kind } = describe(policy);
      const typed = policy as AnyPolicy;
      if (this.policies.has(hash) || (await this.options.store.loadPolicy(hash))) return { policyHash: hash };
      if (typed.witness !== this.publicKey) throw new MatteringError("POLICY", "the policy names a different witness");
      if (typed.origin !== this.origin) throw new MatteringError("POLICY", "the policy names a different log");
      if (typed.logFrom > this.witness.size) throw new MatteringError("POLICY", "the policy's logFrom is beyond the end of the log");
      if (typed.logFrom < this.witness.size - (this.options.maxPolicyLag ?? DEFAULT_MAX_POLICY_LAG)) {
        throw new MatteringError("POLICY", "the policy's logFrom is too far behind the log; make the policy from the log's current size");
      }
      if (!sameBeacon(typed.beacon, this.options.source.beacon)) throw new MatteringError("POLICY", "this witness does not watch the policy's beacon");
      if (typed.closeRound <= (await deadlineRound(this.options.source)).round) throw new MatteringError("POLICY", "the policy's close round has already passed");
      await this.options.store.savePolicy(hash, typed);
      this.policies.set(hash, { hash, kind, policy: typed, count: 0 });
      return { policyHash: hash };
    });
  }

  submit(submission: Submission, envelope: Envelope): Promise<Receipt> {
    return this.exclusive(async () => {
      if (!verifySubmissionSignature(submission)) throw new MatteringError("MALFORMED", "submission is malformed or its signature is invalid");
      const record = await this.lookup(submission.policyHash);
      // A retired policy was released long ago; nothing more can join it.
      if (!this.policies.has(record.hash)) throw new MatteringError("POLICY", "late: this policy closed at its close round");
      assertEnvelope(envelope);
      const verifier = { acceptedBeacons: [this.options.source.beacon] };
      const checks =
        record.kind === "auction"
          ? verifySealedSubmission(record.policy as AuctionPolicy, submission, envelope, verifier)
          : verifySealedStatement(record.policy as StatementPolicy, submission, envelope, verifier);
      const failed = checks.find((c) => !c.ok);
      if (failed) throw new MatteringError("MALFORMED", `submission rejected: ${failed.name}${failed.detail ? ` (${failed.detail})` : ""}`);
      if ((record.kind === "auction") !== (submission.commitment !== undefined)) {
        throw new MatteringError("MALFORMED", record.kind === "auction" ? "an auction submission needs a commitment" : "a statement submission carries no commitment");
      }
      // The deadline: the close round has been emitted as far as this witness
      // has seen, or is due by this witness's clock and the beacon's schedule,
      // whichever comes first. Nothing the submitter says about time is consulted.
      const now = await this.closeDue();
      if (record.closing || record.policy.closeRound <= now) {
        throw new MatteringError("POLICY", "late: this policy closed at its close round");
      }
      // Durable first, then acknowledged: a receipt is never given for an entry that could be lost.
      await this.options.store.saveEnvelope(envelopeId(envelope), envelope);
      await this.options.store.appendEntry(this.witness.size, submission, entryLeafHash(submission));
      const receipt = this.witness.submit(submission);
      record.count += 1;
      return receipt;
    });
  }

  /** Close every policy whose close round has been emitted, and collect cosignatures. Call regularly. */
  tick(): Promise<void> {
    return this.exclusive(async () => {
      await this.closeDue();
    });
  }

  /** Returns the round deadlines are judged against. */
  private async closeDue(): Promise<number> {
    const source = this.options.source;
    const { latest, round: now } = await deadlineRound(source);
    const waiting: { record: PolicyRecord; have: number }[] = [];
    for (const record of this.policies.values()) {
      const terms: PolicyTerms = record.policy;
      if (!record.closing && terms.closeRound <= now) {
        const closeRelease = await source.get(terms.closeRound);
        // Without the close round's signature the closing checkpoint cannot be
        // made yet. submit() already refuses, so nothing gets in meanwhile.
        if (!closeRelease) continue;
        // The close entry is part of the log, so it is stored like any entry, before the closing is signed.
        const entry = closeEntry(record.hash, closeRelease);
        await this.options.store.appendEntry(this.witness.size, entry, entryLeafHash(entry));
        record.closing = this.witness.close(record.hash, source.beacon, closeRelease);
        await this.saveClosing(record);
      }
      const have = record.closing ? countCosignatures(terms, record.closing, record.witnessed).cosigners.length : 0;
      if (record.closing && now < terms.releaseRound && latest.round >= terms.closeRound && this.options.cosign && have < terms.cosigners.length) {
        waiting.push({ record, have });
      }
    }
    if (waiting.length > 0) await this.witnessClosings(waiting);
    // Once released, a policy's evidence can no longer change: let it go from memory.
    for (const record of [...this.policies.values()]) {
      if (record.closing && latest.round >= record.policy.releaseRound) {
        await this.options.store.retirePolicy(record.hash);
        this.policies.delete(record.hash);
        this.witness.forget(record.hash);
      }
    }
    return now;
  }

  /**
   * Show the log as it stands now to the cosigners of every policy still
   * waiting for cosignatures, asking each cosigner once, and keep a policy's
   * cosigned checkpoint if more of its cosigners vouched for it than before.
   * The log extends every closing checkpoint made so far, so one checkpoint
   * serves them all.
   */
  private async witnessClosings(waiting: { record: PolicyRecord; have: number }[]): Promise<void> {
    const size = this.witness.size;
    const checkpoint = this.witness.logCheckpoint(size);
    if (this.collected.size !== size) this.collected = { size, lines: new Map() };
    const cosigners = new Set(waiting.flatMap(({ record }) => record.policy.cosigners));
    for (const cosigner of cosigners) {
      if (this.collected.lines.has(cosigner)) continue;
      const lines = await this.requestCosignature(cosigner, checkpoint, size);
      if (lines) this.collected.lines.set(cosigner, lines);
    }
    for (const { record, have } of waiting) {
      const lines = record.policy.cosigners.map((c) => this.collected.lines.get(c) ?? "").join("");
      const witnessed = { checkpoint: checkpoint + lines, proof: this.witness.consistency(record.closing!.size, size) };
      if (countCosignatures(record.policy, record.closing!, witnessed).cosigners.length > have) {
        record.witnessed = witnessed;
        await this.saveClosing(record);
      }
    }
  }

  /** One cosigner's signature lines for `checkpoint`, or undefined. Follows a 409 once, as the protocol intends. */
  private async requestCosignature(cosigner: string, checkpoint: string, size: number): Promise<string | undefined> {
    const name = parseVkey(cosigner).name;
    for (let attempt = 0; attempt < 2; attempt++) {
      const old = this.cosignedSize.get(cosigner) ?? 0;
      if (old > size) return undefined;
      const body = `old ${old}\n` + this.witness.consistency(old, size).map((p) => p + "\n").join("") + "\n" + checkpoint;
      const reply = await this.options.cosign!(cosigner, body).catch(() => undefined);
      if (reply?.status === 409 && /^(0|[1-9][0-9]*)\n$/.test(reply.body)) {
        this.cosignedSize.set(cosigner, Number(reply.body.trim()));
        continue;
      }
      if (reply?.status !== 200) return undefined;
      this.cosignedSize.set(cosigner, size);
      // Keep only this cosigner's lines; a response may carry several signatures.
      return reply.body.split("\n").filter((line) => line.startsWith(`\u2014 ${name} `)).map((line) => line + "\n").join("") || undefined;
    }
    return undefined;
  }

  private saveClosing(record: PolicyRecord): Promise<void> {
    return this.options.store.saveClosing(record.hash, record.witnessed ? { closing: record.closing!, witnessed: record.witnessed } : { closing: record.closing! });
  }

  /** Up to `LOG_PAGE` entries from `from`. Read on from `from + entries.length` for more. */
  async log(from = 0): Promise<{ size: number; from: number; entries: LogEntry[] }> {
    const size = this.witness.size;
    return { size, from, entries: from >= size ? [] : await this.options.store.readEntries(from, Math.min(size, from + LOG_PAGE)) };
  }

  /** Leaf hashes [from, to), lowercase hex. */
  leafHashes(from: number, to: number): string[] {
    const out: string[] = [];
    for (let i = Math.max(0, from); i < Math.min(to, this.witness.size); i++) out.push(this.witness.leafHash(i));
    return out;
  }

  /**
   * A second witness with this one's key and origin, holding the log's first
   * `size` leaves and nothing after them. For demonstrating what a dishonest
   * operator could sign; it changes nothing here and is never shown to a cosigner.
   */
  copyUpTo(size: number): Witness {
    return new Witness(this.witness.keys.secretKey, { leafHashes: this.leafHashes(0, size), closings: [] }, this.origin);
  }

  /** Submissions under a policy so far, in log order, from its `logFrom` up to its close or the end of the log. */
  async submissions(hash: string): Promise<Submission[]> {
    const record = await this.lookup(hash);
    const end = record.closing?.size ?? this.witness.size;
    const out: Submission[] = [];
    for (let at = record.policy.logFrom; at < end; at += LOG_PAGE) {
      for (const entry of await this.options.store.readEntries(at, Math.min(at + LOG_PAGE, end))) if (isSubmission(entry) && entry.policyHash === hash) out.push(entry);
    }
    return out;
  }

  /** How many submissions name this policy, while it is live; 0 for any other. */
  count(hash: string): number {
    return this.policies.get(hash)?.count ?? 0;
  }

  async checkpoint(): Promise<Checkpoint> {
    return this.witness.checkpoint(this.options.source.beacon, await this.options.source.latest());
  }

  async envelope(id: string): Promise<Envelope> {
    const envelope = HEX32.test(id) ? await this.options.store.loadEnvelope(id) : undefined;
    if (!envelope) throw notFound("envelope");
    return envelope;
  }

  /** The policy's state without loading its envelopes. */
  async phase(hash: string): Promise<{ state: EvidenceBundle["state"]; cosignatures: number }> {
    const record = await this.lookup(hash);
    if (!record.closing) return { state: "open", cosignatures: 0 };
    const release = await this.options.source.get(record.policy.releaseRound);
    const cosignatures = countCosignatures(record.policy, record.closing, record.witnessed).cosigners.length;
    return { state: release ? "released" : "closed", cosignatures };
  }

  /** Everything a verifier needs for one policy, as far as it exists yet. */
  async evidence(hash: string): Promise<EvidenceBundle> {
    const record = await this.lookup(hash);
    const base = { policy: record.policy, policyHash: hash };
    if (!record.closing) return { ...base, state: "open" };
    const from = record.policy.logFrom;
    const entries = await this.options.store.readEntries(from, record.closing.size);
    const envelopes: Record<string, Envelope> = {};
    for (const entry of entries) {
      if (isSubmission(entry) && entry.policyHash === hash) envelopes[entry.envelopeId] = await this.envelope(entry.envelopeId);
    }
    const closed = { ...base, entries, prefix: this.witness.prefix(from), closing: record.closing, ...(record.witnessed ? { witnessed: record.witnessed } : {}), envelopes };
    const release = await this.options.source.get(record.policy.releaseRound);
    return release ? { ...closed, state: "released", release } : { ...closed, state: "closed" };
  }

  /**
   * The outcome as this service computes it. A convenience: anyone can and
   * should recompute it from `evidence` with the same library.
   */
  async result(hash: string): Promise<{ state: EvidenceBundle["state"]; kind: PolicyKind; result?: AuctionResult | StatementsResult }> {
    const record = await this.lookup(hash);
    const bundle = await this.evidence(hash);
    if (bundle.state !== "released") return { state: bundle.state, kind: record.kind };
    let result = this.results.get(hash);
    if (!result) {
      const verifier = { acceptedBeacons: [this.options.source.beacon] };
      const inputs = { entries: bundle.entries!, prefix: bundle.prefix, closing: bundle.closing!, witnessed: bundle.witnessed, envelopes: bundle.envelopes!, release: bundle.release! };
      result =
        record.kind === "auction"
          ? await verifyAuction({ policy: record.policy as AuctionPolicy, ...inputs }, verifier)
          : await verifyStatements({ policy: record.policy as StatementPolicy, ...inputs }, verifier);
      this.results.set(hash, result);
      // A small cache: the oldest result goes first.
      if (this.results.size > 64) this.results.delete(this.results.keys().next().value!);
    }
    return { state: "released", kind: record.kind, result };
  }

  /**
   * The registry view: everything one key has committed to, and what has
   * opened. It reads the whole log, so it gets slower as the log grows.
   */
  async submitter(key: string): Promise<{ submitter: string; commitments: Record<string, unknown>[] }> {
    if (!HEX32.test(key)) throw notFound("submitter");
    const commitments: Record<string, unknown>[] = [];
    const found: [number, Submission][] = [];
    for (let at = 0; at < this.witness.size; at += LOG_PAGE) {
      for (const [i, entry] of (await this.options.store.readEntries(at, Math.min(at + LOG_PAGE, this.witness.size))).entries()) {
        if (isSubmission(entry) && entry.submitter === key) found.push([at + i, entry]);
      }
    }
    for (const [index, entry] of found) {
      const record = await this.lookup(entry.policyHash);
      const item: Record<string, unknown> = { index, policyHash: entry.policyHash, kind: record.kind, envelopeId: entry.envelopeId, releaseRound: record.policy.releaseRound };
      if (!record.closing) item.state = "sealed, policy open";
      else if (index >= record.closing.size) item.state = "late";
      else {
        const { state, result } = await this.result(entry.policyHash);
        if (state !== "released" || !result) item.state = "sealed";
        else if (!result.ok) item.state = "evidence invalid";
        else {
          const outcomes: { index: number }[] = "bids" in result ? result.bids : result.statements;
          const { index: _i, ...outcome } = (outcomes.find((o) => o.index === index) ?? { index }) as { index: number } & Record<string, unknown>;
          delete outcome.submitter;
          delete outcome.author;
          delete outcome.envelopeId;
          Object.assign(item, { state: "opened" }, outcome);
        }
      }
      commitments.push(item);
    }
    return { submitter: key, commitments };
  }
}
