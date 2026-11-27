/**
 * A sealed-bid auction over envelopes and a witness log: the policy, how a
 * bidder prepares a bid, and a verifier that recomputes the outcome from
 * public artifacts alone. See docs/protocol.md section 7.
 */
import { bytesToHex, hexToBytes } from "@noble/hashes/utils";
import type { BeaconInfo, Release } from "./beacon.ts";
import { canonicalBytes, hashCanonical, hashLabelled } from "./canonical.ts";
import { commit, opensTo, randomBlinding } from "./commitment.ts";
import { assertRecipients, envelopeId, isRecipientEnvelope, type Context, type Envelope } from "./envelope.ts";
import { MatteringError } from "./errors.ts";
import { open, seal, verifyEnvelope, type Check, type VerifierPolicy } from "./seal.ts";
import type { KeyPair } from "./signing.ts";
import { assertTerms, verifyEvidence, type PolicyTerms, type WitnessedCheckpoint } from "./evidence.ts";
import { signSubmission, verifySubmissionSignature, type Checkpoint, type LogEntry, type Submission } from "./witness.ts";

export const POLICY_FORMAT = "mattering.auction-policy/3";
/**
 * Version 4 adds what an auction for funding or procurement needs: the lowest
 * bid can win, a public reserve, a unit, and bids sealed to named recipients
 * (the organiser) instead of opening to everyone. Version 3 policies still
 * verify, unchanged.
 */
export const AUCTION_POLICY_FORMAT = "mattering.auction-policy/4";
export const BID_FORMAT = "mattering.bid/1";
const POLICY_LABEL = "mattering/auction-policy/v1";
const TIE_BREAK_LABEL = "mattering/tie-break/v1";

export interface AuctionPolicy extends PolicyTerms {
  format: typeof POLICY_FORMAT;
  auctionId: string;
  minBid: number;
  maxBid: number;
  rule: "highest-bid";
  tieBreak: "release-round-signature";
}

export interface SealedAuctionPolicy extends PolicyTerms {
  format: typeof AUCTION_POLICY_FORMAT;
  auctionId: string;
  /** What the amounts count, such as "GBP" or "bps". Not interpreted. */
  unit: string;
  minBid: number;
  maxBid: number;
  /** "highest-bid" for selling; "lowest-bid" for buying, funding and procurement. */
  rule: "highest-bid" | "lowest-bid";
  /** Optional and public: no winner unless the best valid bid reaches it (at least it, or at most it for "lowest-bid"). */
  reserve?: number;
  /** Age X25519 recipients every bid is sealed to, sorted. Empty: bids open to everyone at the release round. */
  recipients: string[];
  tieBreak: "release-round-signature";
}

/** Either version of an auction policy. */
export type AnyAuctionPolicy = AuctionPolicy | SealedAuctionPolicy;

/** Opens an envelope sealed to recipients, as one of them or with a disclosed file key; undefined if it cannot. */
export type BidOpener = (envelope: Envelope, release: Release, verifier: VerifierPolicy) => Promise<Uint8Array | undefined>;

const V4_KEYS = "auctionId,beacon,closeRound,cosignerThreshold,cosigners,format,logFrom,maxBid,minBid,origin,recipients,releaseRound,rule,tieBreak,unit,witness";

export function assertPolicy(policy: AnyAuctionPolicy): void {
  if (policy.format === AUCTION_POLICY_FORMAT) return assertSealedAuctionPolicy(policy);
  const keys = Object.keys(policy).sort().join(",");
  if (keys !== "auctionId,beacon,closeRound,cosignerThreshold,cosigners,format,logFrom,maxBid,minBid,origin,releaseRound,rule,tieBreak,witness") throw new MatteringError("MALFORMED", `policy: unexpected fields (${keys})`);
  if (policy.format !== POLICY_FORMAT) throw new MatteringError("MALFORMED", "policy.format");
  if (typeof policy.auctionId !== "string" || policy.auctionId === "") throw new MatteringError("MALFORMED", "policy.auctionId");
  assertTerms(policy);
  if (!Number.isSafeInteger(policy.minBid) || !Number.isSafeInteger(policy.maxBid) || policy.minBid < 0 || policy.maxBid < policy.minBid) throw new MatteringError("MALFORMED", "policy: bid range");
  if (policy.rule !== "highest-bid" || policy.tieBreak !== "release-round-signature") throw new MatteringError("MALFORMED", "policy: unsupported rule");
}

function assertSealedAuctionPolicy(policy: SealedAuctionPolicy): void {
  const keys = Object.keys(policy).filter((k) => k !== "reserve").sort().join(",");
  if (keys !== V4_KEYS) throw new MatteringError("MALFORMED", `policy: unexpected fields (${Object.keys(policy).sort().join(",")})`);
  if (typeof policy.auctionId !== "string" || policy.auctionId === "") throw new MatteringError("MALFORMED", "policy.auctionId");
  if (typeof policy.unit !== "string" || policy.unit === "" || policy.unit.length > 32) throw new MatteringError("MALFORMED", "policy.unit");
  assertTerms(policy);
  if (!Number.isSafeInteger(policy.minBid) || !Number.isSafeInteger(policy.maxBid) || policy.minBid < 0 || policy.maxBid < policy.minBid) throw new MatteringError("MALFORMED", "policy: bid range");
  if (policy.rule !== "highest-bid" && policy.rule !== "lowest-bid") throw new MatteringError("MALFORMED", "policy: unsupported rule");
  if (policy.tieBreak !== "release-round-signature") throw new MatteringError("MALFORMED", "policy: unsupported tie-break");
  if ("reserve" in policy && (!Number.isSafeInteger(policy.reserve) || policy.reserve! < policy.minBid || policy.reserve! > policy.maxBid)) throw new MatteringError("MALFORMED", "policy.reserve: want a whole number within the bid range");
  if (!Array.isArray(policy.recipients)) throw new MatteringError("MALFORMED", "policy.recipients");
  if (policy.recipients.length > 0) {
    assertRecipients(policy.recipients, "policy.recipients");
    if (policy.recipients.join("\n") !== [...policy.recipients].sort().join("\n")) throw new MatteringError("MALFORMED", "policy.recipients: want them sorted");
  }
}

/** The recipients a policy's bids are sealed to; empty when they open to everyone. */
export function bidRecipients(policy: AnyAuctionPolicy): readonly string[] {
  return policy.format === AUCTION_POLICY_FORMAT ? policy.recipients : [];
}

export function policyHash(policy: AnyAuctionPolicy): string {
  assertPolicy(policy);
  return bytesToHex(hashCanonical(POLICY_LABEL, policy));
}

/** What is sealed. The amount and the commitment's opening travel together. */
export interface Bid {
  format: typeof BID_FORMAT;
  policyHash: string;
  bidder: string;
  amount: number;
  blinding: string;
}

export function bidContext(hash: string, bidder: string): Context {
  return { kind: BID_FORMAT, policyHash: hash, bidder };
}

export interface PreparedBid {
  envelope: Envelope;
  submission: Submission;
}

/**
 * Everything a bidder does, locally: seal the bid to the release round, commit
 * to the amount, and sign a submission naming the envelope. The bidder then
 * hands both to the witness and can go offline for good.
 */
export async function prepareBid(policy: AnyAuctionPolicy, amount: number, keys: KeyPair): Promise<PreparedBid> {
  if (bidRecipients(policy).length > 0) throw new MatteringError("MALFORMED", "this auction seals bids to recipients: use prepareBidTo from @mattering/core/recipients");
  return prepareBidWith(policy, amount, keys, (options) => seal(options));
}

/**
 * The bid itself, sealed by `sealer`: `seal` for bids that open to everyone,
 * `sealTo` with the policy's recipients for the rest (see
 * `prepareBidTo` in `@mattering/core/recipients`).
 */
export async function prepareBidWith(policy: AnyAuctionPolicy, amount: number, keys: KeyPair, sealer: (options: { payload: Uint8Array; round: number; beacon: BeaconInfo; context: Context }) => Promise<Envelope>): Promise<PreparedBid> {
  const hash = policyHash(policy);
  const blinding = randomBlinding();
  const bid: Bid = { format: BID_FORMAT, policyHash: hash, bidder: keys.publicKey, amount, blinding };
  const envelope = await sealer({
    payload: canonicalBytes(bid),
    round: policy.releaseRound,
    beacon: policy.beacon,
    context: bidContext(hash, keys.publicKey),
  });
  const submission = signSubmission({ policyHash: hash, envelopeId: envelopeId(envelope), commitment: commit(amount, blinding) }, keys);
  return { envelope, submission };
}

/**
 * What anyone can check about a submission while bids are still sealed. It
 * says nothing about the amount, and cannot: a well-formed envelope may still
 * hold an invalid bid.
 */
export function verifySealedSubmission(policy: AnyAuctionPolicy, submission: Submission, envelope: Envelope, verifier: VerifierPolicy): Check[] {
  const hash = policyHash(policy);
  const checks: Check[] = [
    { name: "submission-signed", ok: verifySubmissionSignature(submission) },
    { name: "submission-for-this-policy", ok: submission.policyHash === hash },
  ];
  const sealed = verifyEnvelope(envelope, {
    acceptedBeacons: verifier.acceptedBeacons,
    expectedRound: policy.releaseRound,
    expectedContext: bidContext(hash, submission.submitter),
  });
  checks.push(...sealed.checks);
  checks.push({ name: "envelope-is-the-submitted-one", ok: sealed.envelopeId === submission.envelopeId });
  // Sealed to exactly the recipients the policy names, or, if it names none, to no one in particular.
  const want = bidRecipients(policy);
  const got = isRecipientEnvelope(envelope) ? (envelope.recipients ?? []) : [];
  checks.push({ name: "sealed-to-the-policy-recipients", ok: want.length === got.length && want.every((r, i) => r === got[i]) });
  return checks;
}

// --- adjudication ------------------------------------------------------------

export type BidStatus = "valid" | "invalid" | "unresolved";

export interface BidOutcome {
  index: number;
  submitter: string;
  envelopeId: string;
  status: BidStatus;
  /** Why an invalid bid is invalid, or why an unresolved one could not be judged. */
  reason?: string;
  amount?: number;
}

export interface AuctionInputs {
  policy: AnyAuctionPolicy;
  /** The witness's log in order, from the policy's `logFrom` at least up to the closing checkpoint's size. */
  entries: readonly LogEntry[];
  /** The log before `logFrom`, as its compact range. Absent when `logFrom` is 0. */
  prefix?: readonly string[] | undefined;
  closing: Checkpoint;
  /** Witness cosignatures on the log at or after the closing checkpoint, if the policy requires any. */
  witnessed?: WitnessedCheckpoint | undefined;
  /** Envelopes by envelope id. Missing ones leave their bids unresolved. */
  envelopes: ReadonlyMap<string, Envelope> | Record<string, Envelope>;
  /** The beacon's signature for the policy's release round. */
  release: Release;
}

export interface AuctionResult {
  /** True iff the evidence is valid and every on-time bid could be judged. */
  ok: boolean;
  checks: Check[];
  bids: BidOutcome[];
  /** Set only when `ok`. Absent if there was no valid bid, or the best did not reach the reserve. */
  winner?: { submitter: string; envelopeId: string; amount: number };
  /** Version 4 policies with a reserve: whether the best valid bid reached it. */
  reserveMet?: boolean;
}

function tieBreakKey(release: Release, id: string): string {
  return bytesToHex(hashLabelled(TIE_BREAK_LABEL, new Uint8Array([...hexToBytes(release.signature), ...hexToBytes(id)])));
}

async function judge(policy: AnyAuctionPolicy, hash: string, submission: Submission, envelope: Envelope, release: Release, verifier: VerifierPolicy, opener: BidOpener | undefined): Promise<{ status: BidStatus; reason?: string; amount?: number }> {
  const sealedChecks = verifySealedSubmission(policy, submission, envelope, verifier);
  const failed = sealedChecks.find((c) => !c.ok);
  if (failed) return { status: "invalid", reason: `${failed.name}${failed.detail ? `: ${failed.detail}` : ""}` };
  let payload: Uint8Array;
  try {
    if (isRecipientEnvelope(envelope)) {
      // Only a recipient, or someone it has disclosed the file key to, can open it. Anyone else cannot judge it.
      let opened: Uint8Array | undefined;
      try {
        opened = opener ? await opener(envelope, release, verifier) : undefined;
      } catch (error) {
        // Not openable with the key given: the wrong key, or a bidder that shut this recipient out.
        // Everyone who can open it reads the same bid, so the answer is its file key, not a verdict.
        if ((error as MatteringError).code === "DECRYPT_FAILED") return { status: "unresolved", reason: "cannot be opened with this key; ask a recipient for its file key" };
        throw error;
      }
      if (!opened) return { status: "unresolved", reason: "sealed to recipients, and no key to open it was given" };
      payload = opened;
    } else {
      payload = await open(envelope, release, { acceptedBeacons: verifier.acceptedBeacons });
    }
  } catch (error) {
    return { status: "invalid", reason: `does not open: ${(error as MatteringError).code}` };
  }
  let bid: Bid;
  try {
    bid = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(payload)) as Bid;
    if (bytesToHex(canonicalBytes(bid)) !== bytesToHex(payload)) throw new Error("not canonical");
  } catch {
    return { status: "invalid", reason: "sealed payload is not a canonical bid" };
  }
  if (bid === null || typeof bid !== "object" || Object.keys(bid).sort().join(",") !== "amount,bidder,blinding,format,policyHash" || bid.format !== BID_FORMAT) {
    return { status: "invalid", reason: "sealed payload is not a bid" };
  }
  if (bid.policyHash !== hash) return { status: "invalid", reason: "bid was sealed for a different policy" };
  if (bid.bidder !== submission.submitter) return { status: "invalid", reason: "bid was sealed by a different bidder" };
  if (!Number.isSafeInteger(bid.amount)) return { status: "invalid", reason: "amount is not an integer" };
  if (submission.commitment === undefined) return { status: "invalid", reason: "submission carries no commitment", amount: bid.amount };
  if (!opensTo(submission.commitment, bid.amount, bid.blinding)) return { status: "invalid", reason: "commitment does not match the sealed amount", amount: bid.amount };
  if (bid.amount < policy.minBid || bid.amount > policy.maxBid) return { status: "invalid", reason: "amount is outside the permitted range", amount: bid.amount };
  return { status: "valid", amount: bid.amount };
}

/**
 * Recompute an auction's outcome from public artifacts. Deterministic: the
 * same inputs always give the same result, whoever runs it.
 */
export async function verifyAuction(inputs: AuctionInputs, verifier: VerifierPolicy, opener?: BidOpener): Promise<AuctionResult> {
  const { policy, release } = inputs;
  const envelopes = inputs.envelopes instanceof Map ? inputs.envelopes : new Map(Object.entries(inputs.envelopes));
  const checks: Check[] = [];
  const add = (name: string, ok: boolean, detail?: string): boolean => {
    checks.push(ok || detail === undefined ? { name, ok } : { name, ok, detail });
    return ok;
  };

  let hash: string;
  try {
    hash = policyHash(policy);
    add("policy-well-formed", true);
  } catch (error) {
    add("policy-well-formed", false, (error as Error).message);
    return { ok: false, checks, bids: [] };
  }
  const evidence = verifyEvidence(hash, policy, inputs, verifier);
  checks.push(...evidence.checks);
  if (!evidence.ok) return { ok: false, checks, bids: [] };

  const bids: BidOutcome[] = [];
  for (const { index, submission, counts } of evidence.onTime) {
    const base = { index, submitter: submission.submitter, envelopeId: submission.envelopeId };
    // Entries are not de-duplicated by envelope. An envelope names its bidder
    // inside the seal, so only that bidder's own submission of it can be valid;
    // refusing "repeats" would let a copier who reached the log first void the
    // genuine bid.
    if (!counts) {
      bids.push({ ...base, status: "invalid", reason: "a later submission by the same bidder" });
      continue;
    }
    // An envelope is identified by its hash. Anything else offered under that
    // id is simply not the envelope, so the bid is unresolved, never invalid:
    // otherwise whoever supplies the evidence could void a bid by swapping it.
    const envelope = suppliedEnvelope(envelopes, submission.envelopeId);
    if (!envelope) {
      bids.push({ ...base, status: "unresolved", reason: "envelope not supplied" });
      continue;
    }
    bids.push({ ...base, ...(await judge(policy, hash, submission, envelope, release, verifier, opener)) });
  }

  const complete = add("every-on-time-bid-judged", bids.every((b) => b.status !== "unresolved"), "an on-time envelope is missing, so the outcome cannot be established");
  if (!complete) return { ok: false, checks, bids };

  const valid = bids.filter((b) => b.status === "valid");
  if (valid.length === 0) return { ok: true, checks, bids };
  const lowest = policy.format === AUCTION_POLICY_FORMAT && policy.rule === "lowest-bid";
  const top = lowest ? Math.min(...valid.map((b) => b.amount!)) : Math.max(...valid.map((b) => b.amount!));
  const best = valid
    .filter((b) => b.amount === top)
    .sort((a, b) => (tieBreakKey(release, a.envelopeId) < tieBreakKey(release, b.envelopeId) ? -1 : 1))[0]!;
  if (policy.format === AUCTION_POLICY_FORMAT && policy.reserve !== undefined) {
    const met = lowest ? top <= policy.reserve : top >= policy.reserve;
    if (!met) return { ok: true, checks, bids, reserveMet: false };
    return { ok: true, checks, bids, reserveMet: true, winner: { submitter: best.submitter, envelopeId: best.envelopeId, amount: best.amount! } };
  }
  return { ok: true, checks, bids, winner: { submitter: best.submitter, envelopeId: best.envelopeId, amount: best.amount! } };
}

/** The envelope supplied for `id`, if and only if it really is that envelope. */
export function suppliedEnvelope(envelopes: ReadonlyMap<string, Envelope>, id: string): Envelope | undefined {
  const envelope = envelopes.get(id);
  try {
    return envelope && envelopeId(envelope) === id ? envelope : undefined;
  } catch {
    return undefined;
  }
}

/** Does a result announced by someone else match what the evidence gives? */
export function sameOutcome(result: AuctionResult, claimed: { submitter: string; amount: number } | undefined): boolean {
  if (!result.ok) return false;
  if (!result.winner || !claimed) return result.winner === undefined && claimed === undefined;
  return result.winner.submitter === claimed.submitter && result.winner.amount === claimed.amount;
}

