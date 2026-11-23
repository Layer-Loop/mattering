/**
 * The part of verification every witnessed policy shares: is the published
 * evidence (log, closing checkpoint, cosignatures, release) valid, and which
 * entries were on time?
 */
import { bytesToHex } from "@noble/hashes/utils";
import { assertBeaconInfo, assertRound, isLowerHex, sameBeacon, verifyRelease, type BeaconInfo, type Release } from "./beacon.ts";
import { hashCanonical } from "./canonical.ts";
import { MatteringError } from "./errors.ts";
import type { Check, VerifierPolicy } from "./seal.ts";
import { signCanonical, verifyCanonical, generateKeyPair, type KeyPair } from "./signing.ts";
import type { BeaconSource } from "./source.ts";
import { logRoot, verifyCheckpointSignature, type Checkpoint, type Submission } from "./witness.ts";

/** The fields every policy has, whatever it is a policy for. */
export interface PolicyTerms {
  beacon: BeaconInfo;
  /** Submissions close when the witness sees this round. */
  closeRound: number;
  /** Sealed content opens at this round. Must be later than `closeRound`. */
  releaseRound: number;
  /** The witness's Ed25519 public key. */
  witness: string;
  /** Independent parties who must countersign the closing checkpoint before release. */
  cosigners: string[];
  /** How many of `cosigners` must have signed. 0 means the witness is trusted alone. */
  cosignerThreshold: number;
}

export const TERMS_KEYS = ["beacon", "closeRound", "cosignerThreshold", "cosigners", "releaseRound", "witness"] as const;

export function assertTerms(terms: PolicyTerms): void {
  assertBeaconInfo(terms.beacon, "policy.beacon");
  assertRound(terms.closeRound, "policy.closeRound");
  assertRound(terms.releaseRound, "policy.releaseRound");
  if (terms.releaseRound <= terms.closeRound) throw new MatteringError("MALFORMED", "policy: releaseRound must be after closeRound");
  if (!isLowerHex(terms.witness, 32)) throw new MatteringError("MALFORMED", "policy.witness");
  if (!Array.isArray(terms.cosigners) || !terms.cosigners.every((c) => isLowerHex(c, 32)) || new Set(terms.cosigners).size !== terms.cosigners.length) {
    throw new MatteringError("MALFORMED", "policy.cosigners: want distinct public keys");
  }
  if (terms.cosigners.includes(terms.witness)) throw new MatteringError("MALFORMED", "policy.cosigners: the witness cannot cosign for itself");
  if (!Number.isSafeInteger(terms.cosignerThreshold) || terms.cosignerThreshold < 0 || terms.cosignerThreshold > terms.cosigners.length) {
    throw new MatteringError("MALFORMED", "policy.cosignerThreshold");
  }
}

// --- cosignatures ------------------------------------------------------------

export const COSIGNATURE_FORMAT = "mattering.cosignature/1";
const COSIGNATURE_LABEL = "mattering/cosignature/v1";
const CHECKPOINT_ID_LABEL = "mattering/checkpoint-id/v1";

export function checkpointId(checkpoint: Checkpoint): string {
  return bytesToHex(hashCanonical(CHECKPOINT_ID_LABEL, checkpoint));
}

/**
 * A cosigner's statement: "I was shown this closing checkpoint, and the latest
 * beacon round I had seen at that moment was `observed`."
 */
export interface Cosignature {
  format: typeof COSIGNATURE_FORMAT;
  cosigner: string;
  checkpoint: string;
  observed: Release;
  signature: string;
}

export function verifyCosignature(cosignature: Cosignature, closing: Checkpoint, terms: PolicyTerms): boolean {
  if (cosignature?.format !== COSIGNATURE_FORMAT || !terms.cosigners.includes(cosignature.cosigner)) return false;
  if (cosignature.checkpoint !== checkpointId(closing)) return false;
  const { signature, ...unsigned } = cosignature;
  if (!verifyCanonical(COSIGNATURE_LABEL, unsigned, signature, cosignature.cosigner)) return false;
  const round = cosignature.observed?.round;
  return round >= terms.closeRound && round < terms.releaseRound && verifyRelease(terms.beacon, cosignature.observed);
}

/**
 * A cosigner. It countersigns a closing checkpoint only if, by its own view of
 * the beacon, the release round has not happened yet, and it never signs two
 * different closing checkpoints for one policy. It does not judge the log's
 * contents and cannot read any bid.
 */
export class Cosigner {
  readonly keys: KeyPair;
  /** policyHash -> the cosignature given. Persist this; forgetting it allows equivocation. */
  readonly signed: Map<string, Cosignature>;

  constructor(private readonly source: BeaconSource, secretKey?: string, signed?: Iterable<[string, Cosignature]>) {
    this.keys = generateKeyPair(secretKey);
    this.signed = new Map(signed);
  }

  get publicKey(): string {
    return this.keys.publicKey;
  }

  async cosign(policyHash: string, terms: PolicyTerms, closing: Checkpoint): Promise<Cosignature> {
    assertTerms(terms);
    if (!sameBeacon(terms.beacon, this.source.beacon)) throw new MatteringError("POLICY", "cosigner does not watch this policy's beacon");
    if (!terms.cosigners.includes(this.publicKey)) throw new MatteringError("POLICY", "this cosigner is not named by the policy");
    if (!verifyCheckpointSignature(closing, terms.witness) || closing.closes !== policyHash) {
      throw new MatteringError("MALFORMED", "not a closing checkpoint for this policy signed by its witness");
    }
    if (closing.observed.round !== terms.closeRound || !verifyRelease(terms.beacon, closing.observed)) {
      throw new MatteringError("MALFORMED", "closing checkpoint does not cite the close round");
    }
    const previous = this.signed.get(policyHash);
    if (previous) {
      if (previous.checkpoint === checkpointId(closing)) return previous;
      throw new MatteringError("POLICY", "already cosigned a different closing checkpoint for this policy");
    }
    const observed = await this.source.latest();
    if (observed.round >= terms.releaseRound) throw new MatteringError("POLICY", "too late: the release round has been emitted");
    if (observed.round < terms.closeRound) throw new MatteringError("POLICY", "too early: this cosigner has not seen the close round");
    const unsigned: Omit<Cosignature, "signature"> = { format: COSIGNATURE_FORMAT, cosigner: this.publicKey, checkpoint: checkpointId(closing), observed };
    const cosignature = { ...unsigned, signature: signCanonical(COSIGNATURE_LABEL, unsigned, this.keys.secretKey) };
    this.signed.set(policyHash, cosignature);
    return cosignature;
  }
}

// --- evidence ----------------------------------------------------------------

export interface Evidence {
  /** The witness's log, in order, at least up to the closing checkpoint's size. */
  entries: readonly Submission[];
  closing: Checkpoint;
  cosignatures?: readonly Cosignature[];
  /** The beacon's signature for the policy's release round. */
  release: Release;
}

export interface EvidenceVerdict {
  ok: boolean;
  checks: Check[];
  /** On-time entries for this policy, in log order, first entry per submitter marked. */
  onTime: { index: number; submission: Submission; counts: boolean }[];
}

export function verifyEvidence(policyHash: string, terms: PolicyTerms, evidence: Evidence, verifier: VerifierPolicy): EvidenceVerdict {
  const { entries, closing, release } = evidence;
  const checks: Check[] = [];
  const add = (name: string, ok: boolean, detail: string): void => {
    checks.push(ok ? { name, ok } : { name, ok, detail });
  };
  add("beacon-accepted", verifier.acceptedBeacons.some((b) => sameBeacon(b, terms.beacon)), "the policy's beacon is not one this verifier accepts");
  add("closing-checkpoint-signed-by-witness", verifyCheckpointSignature(closing, terms.witness), "not signed by the policy's witness");
  add("closing-checkpoint-is-for-this-policy", closing?.closes === policyHash, "the checkpoint closes a different policy");
  add(
    "closed-at-the-close-round",
    closing?.observed?.round === terms.closeRound && verifyRelease(terms.beacon, closing.observed),
    "the closing checkpoint must cite the beacon's signature for the close round",
  );
  const cosigners = new Set((evidence.cosignatures ?? []).filter((c) => verifyCosignature(c, closing, terms)).map((c) => c.cosigner));
  add(
    "closing-checkpoint-cosigned-before-release",
    cosigners.size >= terms.cosignerThreshold,
    `${cosigners.size} valid cosignature(s); the policy requires ${terms.cosignerThreshold}`,
  );
  const haveLog = Number.isSafeInteger(closing?.size) && entries.length >= closing.size;
  add("log-matches-closing-checkpoint", haveLog && logRoot(entries.slice(0, closing.size)) === closing.root, "the supplied log is not the one the witness signed");
  add("release-valid", release?.round === terms.releaseRound && verifyRelease(terms.beacon, release), "not the beacon's signature for the release round");
  const ok = checks.every((c) => c.ok);
  const onTime: EvidenceVerdict["onTime"] = [];
  if (ok) {
    const seen = new Set<string>();
    for (let index = 0; index < closing.size; index++) {
      const submission = entries[index]!;
      if (submission.policyHash !== policyHash) continue;
      onTime.push({ index, submission, counts: !seen.has(submission.submitter) });
      seen.add(submission.submitter);
    }
  }
  return { ok, checks, onTime };
}
