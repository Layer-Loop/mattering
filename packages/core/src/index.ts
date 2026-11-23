export { MatteringError, type MatteringErrorCode } from "./errors.ts";
export {
  QUICKNET,
  SUPPORTED_SCHEME,
  assertBeaconInfo,
  firstRoundAtOrAfter,
  sameBeacon,
  timeOfRound,
  verifyRelease,
  type BeaconInfo,
  type Release,
} from "./beacon.ts";
export { canonicalBytes, hashCanonical, hashLabelled, type Json } from "./canonical.ts";
export {
  ENVELOPE_FORMAT,
  assertEnvelope,
  envelopeId,
  parseEnvelope,
  readStanza,
  serializeEnvelope,
  type Context,
  type Envelope,
  type EnvelopeHeader,
} from "./envelope.ts";
export {
  DEFAULT_POLICY,
  open,
  seal,
  verifyEnvelope,
  verifyOpen,
  type Check,
  type SealOptions,
  type VerificationResult,
  type VerifierPolicy,
} from "./seal.ts";
export { generateKeyPair, type KeyPair } from "./signing.ts";
export { BLINDING_GENERATOR_HEX, commit, opensTo, randomBlinding } from "./commitment.ts";
export {
  CHECKPOINT_FORMAT,
  RECEIPT_FORMAT,
  SUBMISSION_FORMAT,
  Witness,
  isEquivocation,
  logRoot,
  receiptHonoured,
  signSubmission,
  verifyCheckpointSignature,
  verifyReceipt,
  verifySubmissionSignature,
  type Checkpoint,
  type Receipt,
  type Submission,
} from "./witness.ts";
export {
  BID_FORMAT,
  POLICY_FORMAT,
  policyHash,
  prepareBid,
  sameOutcome,
  verifyAuction,
  verifySealedSubmission,
  type AuctionInputs,
  type AuctionPolicy,
  type AuctionResult,
  type Bid,
  type BidOutcome,
  type PreparedBid,
} from "./auction.ts";
export { inclusionProof, leafHash, merkleRoot, rootFromInclusionProof } from "./merkle.ts";
export { deadlineRound, type BeaconSource } from "./source.ts";
export {
  COSIGNATURE_FORMAT,
  Cosigner,
  checkpointId,
  verifyCosignature,
  verifyEvidence,
  type Cosignature,
  type Evidence,
  type PolicyTerms,
} from "./evidence.ts";
export {
  STATEMENT_FORMAT,
  STATEMENT_POLICY_FORMAT,
  prepareStatement,
  statementPolicyHash,
  verifySealedStatement,
  verifyStatements,
  type Statement,
  type StatementInputs,
  type StatementOutcome,
  type StatementPolicy,
  type StatementsResult,
} from "./statement.ts";
