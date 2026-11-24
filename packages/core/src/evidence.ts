/**
 * The part of verification every witnessed policy shares: is the published
 * evidence (log, closing checkpoint, witness cosignatures, release) valid, and
 * which entries were on time?
 */
import { bytesToHex, hexToBytes } from "@noble/hashes/utils";
import { assertBeaconInfo, assertRound, sameBeacon, timeOfRound, verifyRelease, type BeaconInfo, type Release } from "./beacon.ts";
import { MatteringError } from "./errors.ts";
import { leafHash, rootFromCompactRange, verifyConsistency } from "./merkle.ts";
import { cosignatureTime, fromBase64, isKeyName, parseCheckpointText, parseNote, parseVkey, type NoteKey } from "./note.ts";
import type { Check, VerifierPolicy } from "./seal.ts";
import { isLowerHex } from "./beacon.ts";
import { isCloseEntry, isSubmission, submissionLeaf, verifyCheckpointSignature, type Checkpoint, type LogEntry, type Submission } from "./witness.ts";

/** The fields every policy has, whatever it is a policy for. */
export interface PolicyTerms {
  beacon: BeaconInfo;
  /** Submissions close when the witness sees this round. */
  closeRound: number;
  /** Sealed content opens at this round. Must be later than `closeRound`. */
  releaseRound: number;
  /** The witness's Ed25519 public key. */
  witness: string;
  /** The witness's log, by its C2SP origin line. */
  origin: string;
  /**
   * Independent witnesses, as C2SP verifier keys, who must cosign the log at
   * or after the closing checkpoint, timestamped before the release round.
   */
  cosigners: string[];
  /** How many of `cosigners` must have cosigned. 0 means the witness is trusted alone. */
  cosignerThreshold: number;
  /**
   * The log's size when the policy was made. Its entries all come after this
   * point, so evidence covers the log from here to the close rather than from
   * the log's beginning. A witness refuses a policy that names a size its log
   * has not reached.
   */
  logFrom: number;
}

export const TERMS_KEYS = ["beacon", "closeRound", "cosignerThreshold", "cosigners", "logFrom", "origin", "releaseRound", "witness"] as const;

export function assertTerms(terms: PolicyTerms): void {
  assertBeaconInfo(terms.beacon, "policy.beacon");
  assertRound(terms.closeRound, "policy.closeRound");
  assertRound(terms.releaseRound, "policy.releaseRound");
  if (terms.releaseRound <= terms.closeRound) throw new MatteringError("MALFORMED", "policy: releaseRound must be after closeRound");
  if (!isLowerHex(terms.witness, 32)) throw new MatteringError("MALFORMED", "policy.witness");
  if (!isKeyName(terms.origin)) throw new MatteringError("MALFORMED", "policy.origin: want a log origin, such as example.com/log");
  if (!Number.isSafeInteger(terms.logFrom) || terms.logFrom < 0) throw new MatteringError("MALFORMED", "policy.logFrom: want a log size");
  if (!Array.isArray(terms.cosigners)) throw new MatteringError("MALFORMED", "policy.cosigners: want verifier keys");
  const keys = terms.cosigners.map(parseVkey);
  if (new Set(keys.map((k) => `${k.name} ${k.publicKey}`)).size !== keys.length) throw new MatteringError("MALFORMED", "policy.cosigners: want distinct keys");
  if (keys.some((k) => k.publicKey === terms.witness)) throw new MatteringError("MALFORMED", "policy.cosigners: the witness cannot cosign for itself");
  if (!Number.isSafeInteger(terms.cosignerThreshold) || terms.cosignerThreshold < 0 || terms.cosignerThreshold > keys.length) {
    throw new MatteringError("MALFORMED", "policy.cosignerThreshold");
  }
  // A witness that shows one version of its log to some cosigners and another
  // to the rest could otherwise collect a full set of cosignatures for each.
  if (keys.length > 0 && terms.cosignerThreshold * 2 <= keys.length) {
    throw new MatteringError("MALFORMED", "policy.cosignerThreshold: must be more than half of the cosigners");
  }
}

// --- witness cosignatures ----------------------------------------------------

/**
 * Evidence that independent witnesses saw the log, at or after the closing
 * checkpoint, before the bids could be read.
 */
export interface WitnessedCheckpoint {
  /** A C2SP checkpoint of the policy's log with its witnesses' cosignature lines. */
  checkpoint: string;
  /** RFC 6962 consistency proof from the closing checkpoint to `checkpoint`, as base64 lines. */
  proof: string[];
}

export interface CosignatureCount {
  /** Distinct policy cosigners whose cosignature is valid and early enough. */
  cosigners: string[];
  /** Why none counted, when none did. */
  problem?: string;
}

/**
 * Which of the policy's cosigners vouch for the closing checkpoint: each must
 * have cosigned this log's checkpoint, consistent with the closing one, with a
 * timestamp before the release round was due. A witness that wants to rewrite
 * its log after reading the bids cannot get such a cosignature, because an
 * honest cosigner never signs a fork and dates what it signs.
 */
export function countCosignatures(terms: PolicyTerms, closing: Checkpoint, witnessed: WitnessedCheckpoint | undefined): CosignatureCount {
  if (!witnessed) return { cosigners: [], problem: "no witnessed checkpoint supplied" };
  let note;
  let body;
  try {
    note = parseNote(witnessed.checkpoint);
    body = parseCheckpointText(note.text);
  } catch {
    return { cosigners: [], problem: "the witnessed checkpoint is malformed" };
  }
  if (body.origin !== terms.origin) return { cosigners: [], problem: "the witnessed checkpoint is for a different log" };
  const proof = Array.isArray(witnessed.proof) ? witnessed.proof.map((p) => (typeof p === "string" ? fromBase64(p) : undefined)) : [];
  if (!Array.isArray(witnessed.proof) || proof.some((p) => p?.length !== 32) || !isLowerHex(closing?.root, 32)) return { cosigners: [], problem: "the consistency proof is malformed" };
  if (!verifyConsistency(closing.size, body.size, hexToBytes(closing.root), hexToBytes(body.root), proof as Uint8Array[])) {
    return { cosigners: [], problem: "the witnessed log is not an extension of the closing checkpoint" };
  }
  const deadline = timeOfRound(terms.beacon, terms.releaseRound);
  const cosigners: string[] = [];
  let late = false;
  for (const vkey of terms.cosigners) {
    const key: NoteKey = parseVkey(vkey);
    const time = cosignatureTime(note, key);
    if (time === undefined) continue;
    if (time < deadline) cosigners.push(vkey);
    else late = true;
  }
  return cosigners.length > 0 ? { cosigners } : { cosigners, problem: late ? "cosigned only after the release round" : "no valid cosignature from the policy's cosigners" };
}

// --- evidence ----------------------------------------------------------------

export interface Evidence {
  /** The witness's log in order, from entry `logFrom` of the policy at least up to the closing checkpoint's size. */
  entries: readonly LogEntry[];
  /**
   * The log's first `logFrom` entries, as the roots of the perfect subtrees
   * covering them (lowercase hex, largest first). Empty or absent when
   * `logFrom` is 0.
   */
  prefix?: readonly string[] | undefined;
  closing: Checkpoint;
  witnessed?: WitnessedCheckpoint | undefined;
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
  const count = terms.cosignerThreshold === 0 ? { cosigners: [] } : countCosignatures(terms, closing, evidence.witnessed);
  add(
    "closing-checkpoint-cosigned-before-release",
    count.cosigners.length >= terms.cosignerThreshold,
    `${count.cosigners.length} valid cosignature(s); the policy requires ${terms.cosignerThreshold}${"problem" in count && count.problem ? ` (${count.problem})` : ""}`,
  );
  // Only the stretch from logFrom to the close is supplied; everything before
  // it is summarised by the prefix, which the closing root pins down.
  const from = terms.logFrom;
  const span = Number.isSafeInteger(closing?.size) ? closing.size - from : -1;
  const prefix = evidence.prefix ?? [];
  const wellFormed = span > 0 && entries.length >= span && Array.isArray(prefix) && prefix.every((p) => isLowerHex(p, 32));
  const root = wellFormed ? rootFromCompactRange(prefix.map((p) => hexToBytes(p)), from, entries.slice(0, span).map((e) => leafHash(submissionLeaf(e)))) : undefined;
  const haveLog = root !== undefined && bytesToHex(root) === closing.root;
  add("log-matches-closing-checkpoint", haveLog, "the supplied log is not the one the witness signed");
  // The closing is fixed by the log itself: the checkpoint must end at this
  // policy's close entry, and no earlier close entry for it may exist.
  const last = haveLog ? entries[span - 1] : undefined;
  add(
    "closing-is-the-close-entry",
    isCloseEntry(last) && last.policyHash === policyHash && last.observed?.round === closing.observed?.round && last.observed?.signature === closing.observed?.signature,
    "the closing checkpoint must end with this policy's close entry",
  );
  add(
    "closed-only-once",
    haveLog && !entries.slice(0, span - 1).some((e) => isCloseEntry(e) && e.policyHash === policyHash),
    "the log closed this policy earlier; entries after that first close do not count",
  );
  add("release-valid", release?.round === terms.releaseRound && verifyRelease(terms.beacon, release), "not the beacon's signature for the release round");
  const ok = checks.every((c) => c.ok);
  const onTime: EvidenceVerdict["onTime"] = [];
  if (ok) {
    const seen = new Set<string>();
    for (let i = 0; i < span - 1; i++) {
      const submission = entries[i]!;
      if (!isSubmission(submission) || submission.policyHash !== policyHash) continue;
      onTime.push({ index: from + i, submission, counts: !seen.has(submission.submitter) });
      seen.add(submission.submitter);
    }
  }
  return { ok, checks, onTime };
}
