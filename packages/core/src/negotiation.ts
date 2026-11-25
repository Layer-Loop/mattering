/**
 * Sealed negotiation: making offers and judging the outcome. Exported as
 * `@mattering/core/negotiation`; it needs recipient encryption.
 *
 * Offers are sealed to both parties only, so after the release round the
 * outcome can be worked out by the parties, or by anyone a party gives the
 * offers' file keys to, such as an auditor. Everyone who can open an offer
 * reads the same offer (see `recipient-seal.ts`), so everyone who can judge a
 * step reaches the same outcome. A party who cannot open the other's offer
 * gets "unresolved", never a different answer, and can ask for its file key.
 */
import { bytesToHex } from "@noble/hashes/utils";
import type { Release } from "./beacon.ts";
import { canonicalBytes } from "./canonical.ts";
import { envelopeId, type Envelope } from "./envelope.ts";
import { MatteringError } from "./errors.ts";
import { suppliedEnvelope } from "./auction.ts";
import { verifyEvidence, type Evidence } from "./evidence.ts";
import {
  OFFER_FORMAT,
  SIDES,
  negotiationPolicyHash,
  offerContext,
  offerRecipients,
  sideOf,
  verifySealedOffer,
  type NegotiationPolicy,
  type Side,
} from "./negotiation-policy.ts";
import { fileKeyOf, openAs, openWithFileKey, sealTo } from "./recipient-seal.ts";
import type { Check, VerifierPolicy } from "./seal.ts";
import type { KeyPair } from "./signing.ts";
import { signSubmission, type Submission } from "./witness.ts";
import { withinMandate, type MandateOpening, type MandateStatus } from "./mandate.ts";

export * from "./negotiation-policy.ts";

/** What is sealed: one side's price for one step. */
export interface Offer {
  format: typeof OFFER_FORMAT;
  policyHash: string;
  side: Side;
  /** The submitting party's signing key. */
  signer: string;
  price: number;
}

/**
 * Seal one side's offer for a step, sign its submission, and hand both to the
 * witness. Given the agent's mandate opening, it refuses an offer beyond the
 * mandate: the agent's own safeguard, which a dishonest agent can skip.
 */
export async function prepareOffer(policy: NegotiationPolicy, side: Side, price: number, signer: KeyPair, opening?: MandateOpening): Promise<{ envelope: Envelope; submission: Submission }> {
  const hash = negotiationPolicyHash(policy);
  if (policy[side].signer !== signer.publicKey) throw new MatteringError("POLICY", `this key is not the ${side}'s signing key`);
  const mandate = policy[side].mandate;
  if (mandate && opening && withinMandate(mandate, price, opening) !== "within") throw new MatteringError("POLICY", `an offer of ${price} is beyond this agent's mandate`);
  const offer: Offer = { format: OFFER_FORMAT, policyHash: hash, side, signer: signer.publicKey, price };
  const envelope = await sealTo({
    payload: canonicalBytes(offer),
    round: policy.releaseRound,
    beacon: policy.beacon,
    context: offerContext(hash, side),
    recipients: offerRecipients(policy),
  });
  return { envelope, submission: signSubmission({ policyHash: hash, envelopeId: envelopeId(envelope) }, signer) };
}

/**
 * Opens an offer's envelope, or returns undefined if it has no way to. A
 * party opens with its identity; anyone else with file keys a party disclosed.
 */
export type OfferOpener = (envelope: Envelope, release: Release, verifier: VerifierPolicy) => Promise<Uint8Array | undefined>;

/** Open as one of the parties, with its age identity. */
export function asParty(identity: string): OfferOpener {
  return (envelope, release, verifier) => openAs(envelope, release, identity, { acceptedBeacons: verifier.acceptedBeacons });
}

/** Open with disclosed file keys, by envelope id. Envelopes without a key stay unresolved. */
export function withFileKeys(keys: Readonly<Record<string, string>>): OfferOpener {
  return async (envelope, release, verifier) => {
    const key = keys[envelopeId(envelope)];
    return key === undefined ? undefined : openWithFileKey(envelope, release, key, { acceptedBeacons: verifier.acceptedBeacons });
  };
}

export interface StepInputs extends Evidence {
  policy: NegotiationPolicy;
  envelopes: ReadonlyMap<string, Envelope> | Record<string, Envelope>;
}

export interface OfferOutcome {
  index: number;
  submitter: string;
  envelopeId: string;
  side?: Side;
  /**
   * For a valid offer from a side with a mandate: whether the price was within
   * it. "undisclosed" without the opening. Does not change the outcome: an
   * offer beyond its mandate still counts, and shows that the agent exceeded
   * its authority.
   */
  mandate?: MandateStatus;
  /** "ignored": not from a party. "unresolved": could not be opened by whoever is judging. */
  status: "valid" | "invalid" | "unresolved" | "ignored";
  reason?: string;
  price?: number;
}

export type StepOutcome =
  | { deal: true; price: number; buyerOffer: number; sellerOffer: number }
  | { deal: false; reason: string };

export interface StepResult {
  /** True iff the evidence is valid and each side's counting offer could be judged. */
  ok: boolean;
  checks: Check[];
  offers: OfferOutcome[];
  /** Set only when `ok`. */
  outcome?: StepOutcome;
}

async function judgeOffer(policy: NegotiationPolicy, hash: string, side: Side, submission: Submission, envelope: Envelope, release: Release, opener: OfferOpener, verifier: VerifierPolicy): Promise<Pick<OfferOutcome, "status" | "reason" | "price">> {
  const failed = verifySealedOffer(policy, submission, envelope, verifier).find((c) => !c.ok);
  if (failed) return { status: "invalid", reason: `${failed.name}${failed.detail ? `: ${failed.detail}` : ""}` };
  let payload: Uint8Array | undefined;
  try {
    payload = await opener(envelope, release, verifier);
  } catch (error) {
    const code = (error as MatteringError).code;
    // Sealed to us but not openable by us: the sender may have shut us out.
    // Everyone who can open it reads the same offer, so ask for its file key.
    if (code === "DECRYPT_FAILED") return { status: "unresolved", reason: "cannot be opened with this key; ask for its file key" };
    return { status: "invalid", reason: `does not open: ${code ?? "error"}` };
  }
  if (payload === undefined) return { status: "unresolved", reason: "no key to open it" };
  let offer: Offer;
  try {
    offer = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(payload)) as Offer;
    if (bytesToHex(canonicalBytes(offer)) !== bytesToHex(payload)) throw new Error("not canonical");
  } catch {
    return { status: "invalid", reason: "sealed payload is not a canonical offer" };
  }
  if (offer === null || typeof offer !== "object" || Object.keys(offer).sort().join(",") !== "format,policyHash,price,side,signer" || offer.format !== OFFER_FORMAT) {
    return { status: "invalid", reason: "sealed payload is not an offer" };
  }
  if (offer.policyHash !== hash) return { status: "invalid", reason: "offer was sealed for a different step" };
  if (offer.side !== side || offer.signer !== submission.submitter) return { status: "invalid", reason: "offer names a different party than the one who submitted it" };
  if (!Number.isSafeInteger(offer.price) || offer.price < policy.minPrice || offer.price > policy.maxPrice) {
    return { status: "invalid", reason: `price outside ${policy.minPrice}–${policy.maxPrice} ${policy.unit}`, ...(Number.isSafeInteger(offer.price) ? { price: offer.price } : {}) };
  }
  return { status: "valid", price: offer.price };
}

/**
 * Work out one step from its evidence: were both offers in before the close,
 * cosigned before anyone could read them, and what do they give? Needs a way
 * to open the offers: a party's identity, or file keys a party disclosed.
 */
export async function verifyNegotiationStep(inputs: StepInputs, opener: OfferOpener, verifier: VerifierPolicy, openings: Partial<Record<Side, MandateOpening>> = {}): Promise<StepResult> {
  const envelopes = inputs.envelopes instanceof Map ? inputs.envelopes : new Map(Object.entries(inputs.envelopes));
  let hash: string;
  try {
    hash = negotiationPolicyHash(inputs.policy);
  } catch (error) {
    return { ok: false, checks: [{ name: "policy-well-formed", ok: false, detail: (error as Error).message }], offers: [] };
  }
  const evidence = verifyEvidence(hash, inputs.policy, inputs, verifier);
  const checks: Check[] = [{ name: "policy-well-formed", ok: true }, ...evidence.checks];
  if (!evidence.ok) return { ok: false, checks, offers: [] };

  const offers: OfferOutcome[] = [];
  const counted = new Map<Side, OfferOutcome>();
  for (const { index, submission } of evidence.onTime) {
    const base = { index, submitter: submission.submitter, envelopeId: submission.envelopeId };
    const side = sideOf(inputs.policy, submission.submitter);
    if (!side) {
      offers.push({ ...base, status: "ignored", reason: "not from the buyer or the seller" });
      continue;
    }
    if (counted.has(side)) {
      offers.push({ ...base, side, status: "invalid", reason: `a later offer from the ${side}; only the first counts` });
      continue;
    }
    const envelope = suppliedEnvelope(envelopes, submission.envelopeId);
    const outcome: OfferOutcome = envelope
      ? { ...base, side, ...(await judgeOffer(inputs.policy, hash, side, submission, envelope, inputs.release, opener, verifier)) }
      : { ...base, side, status: "unresolved", reason: "envelope not supplied" };
    const mandate = inputs.policy[side].mandate;
    if (mandate && outcome.status === "valid") outcome.mandate = withinMandate(mandate, outcome.price!, openings[side]);
    counted.set(side, outcome);
    offers.push(outcome);
  }

  const unresolved = SIDES.find((s) => counted.get(s)?.status === "unresolved");
  if (unresolved) {
    checks.push({ name: "offers-judged", ok: false, detail: `the ${unresolved}'s offer could not be opened` });
    return { ok: false, checks, offers };
  }
  checks.push({ name: "offers-judged", ok: true });
  const buyer = counted.get("buyer");
  const seller = counted.get("seller");
  let outcome: StepOutcome;
  if (buyer?.status !== "valid") outcome = { deal: false, reason: buyer ? "the buyer's offer is invalid" : "the buyer made no offer in time" };
  else if (seller?.status !== "valid") outcome = { deal: false, reason: seller ? "the seller's offer is invalid" : "the seller made no offer in time" };
  else if (buyer.price! < seller.price!) outcome = { deal: false, reason: "the offers did not cross" };
  // Both sides committed before seeing the other's: split the difference, rounding down.
  else outcome = { deal: true, price: Math.floor((buyer.price! + seller.price!) / 2), buyerOffer: buyer.price!, sellerOffer: seller.price! };
  return { ok: true, checks, offers, outcome };
}

export interface NegotiationResult {
  ok: boolean;
  steps: StepResult[];
  /** Why the chain of steps is not one negotiation, if it is not. */
  problem?: string;
  /** The outcome of the last step, when every step is ok. */
  outcome?: StepOutcome & { step: number };
}

/**
 * Work out a whole negotiation: the steps must form one chain (same parties
 * and terms, each naming the one before, each starting after the previous
 * opened), and every step before the last must have ended without a deal.
 */
export async function verifyNegotiation(steps: readonly StepInputs[], opener: OfferOpener, verifier: VerifierPolicy): Promise<NegotiationResult> {
  const results: StepResult[] = [];
  const fail = (problem: string): NegotiationResult => ({ ok: false, steps: results, problem });
  if (steps.length === 0) return fail("no steps supplied");
  const same = ["negotiationId", "item", "unit", "minPrice", "maxPrice", "rule", "witness", "origin"] as const;
  let previousHash = "";
  for (const [i, inputs] of steps.entries()) {
    const policy = inputs.policy;
    const first = steps[0]!.policy;
    if (policy.step !== i + 1) return fail(`step ${i + 1} is numbered ${policy.step}`);
    if (policy.previous !== previousHash) return fail(`step ${i + 1} does not name the step before it`);
    if (same.some((f) => policy[f] !== first[f]) || JSON.stringify([policy.buyer, policy.seller, policy.beacon]) !== JSON.stringify([first.buyer, first.seller, first.beacon])) {
      return fail(`step ${i + 1} changes the parties or the terms`);
    }
    if (i > 0 && policy.closeRound <= steps[i - 1]!.policy.releaseRound) return fail(`step ${i + 1} closes before step ${i} opened`);
    const result = await verifyNegotiationStep(inputs, opener, verifier);
    results.push(result);
    if (!result.ok) return fail(`step ${i + 1} could not be judged`);
    if (result.outcome?.deal && i < steps.length - 1) return fail(`the negotiation ended in a deal at step ${i + 1}; later steps do not count`);
    previousHash = negotiationPolicyHash(policy);
  }
  return { ok: true, steps: results, outcome: { ...results.at(-1)!.outcome!, step: steps.length } };
}

/**
 * A party's disclosure of one step: the file keys of every offer it can open,
 * by envelope id. Given to an auditor with the evidence, it lets them run
 * `verifyNegotiationStep` with `withFileKeys` and reach the same outcome.
 */
export async function discloseStep(inputs: StepInputs, identity: string, verifier: VerifierPolicy): Promise<Record<string, string>> {
  const envelopes = inputs.envelopes instanceof Map ? inputs.envelopes : new Map(Object.entries(inputs.envelopes));
  const keys: Record<string, string> = {};
  const hash = negotiationPolicyHash(inputs.policy);
  for (const entry of inputs.entries) {
    if (!("submitter" in entry) || entry.policyHash !== hash) continue;
    const envelope = suppliedEnvelope(envelopes, entry.envelopeId);
    if (!envelope) continue;
    try {
      keys[entry.envelopeId] = await fileKeyOf(envelope, inputs.release, identity, { acceptedBeacons: verifier.acceptedBeacons });
    } catch {
      // Not openable with this identity: nothing to disclose for it.
    }
  }
  return keys;
}
