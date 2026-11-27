/**
 * Sealing to named recipients: version 2 envelopes. A separate entry point,
 * `@mattering/core/recipients`, so that code which never seals to recipients
 * does not carry the age library.
 *
 * The payload is first encrypted with age to the recipients' X25519 keys, then
 * time-locked like any envelope. The header names the recipients, and the time
 * lock binds the header to the age file inside, so who an envelope is for
 * cannot be changed. Before the round nobody can read it, recipients included;
 * after it only the recipients can, unless one of them discloses the file key.
 */
import { bytesToHex } from "@noble/hashes/utils";
import { RECIPIENT_ENVELOPE_FORMAT, assertRecipients, envelopeId, isRecipientEnvelope, type Envelope } from "./envelope.ts";
import { bidRecipients, policyHash, prepareBidWith, suppliedEnvelope, type AnyAuctionPolicy, type AuctionInputs, type BidOpener, type PreparedBid } from "./auction.ts";
import type { KeyPair } from "./signing.ts";
import type { Release } from "./beacon.ts";
import { MatteringError } from "./errors.ts";
import { ageDecryptWithFileKey, ageDecryptWithIdentity, ageEncrypt, ageFileKey, ageHeader } from "./recipients.ts";
import { DEFAULT_POLICY, baseHeader, removeTimeLock, sealHeader, verifyEnvelope, type Check, type SealOptions, type VerificationResult, type VerifierPolicy } from "./seal.ts";

export { generateRecipientKeys, recipientOf, type RecipientKeys } from "./recipients.ts";

export interface SealToOptions extends SealOptions {
  /** Age X25519 recipients (`age1…`), 1 to 16. They are sorted; duplicates are refused. */
  recipients: readonly string[];
}

/** Seal `payload` until `round` and to `recipients`. Purely local, like `seal`. */
export async function sealTo(options: SealToOptions): Promise<Envelope> {
  const recipients = [...options.recipients].sort();
  assertRecipients(recipients, "recipients");
  const header = { ...baseHeader(options), format: RECIPIENT_ENVELOPE_FORMAT, recipients } as const;
  // Recipients inside, time lock outside: the time lock binds the header,
  // recipients included, to the age file.
  return sealHeader(header, await ageEncrypt(recipients, options.payload));
}

/**
 * Remove the time lock from a version 2 envelope. Anyone can, once the round
 * has come. The result is the age file inside, still encrypted to the
 * envelope's recipients; it is checked to hold one X25519 key stanza per named
 * recipient and nothing else. Which stanza belongs to which recipient cannot
 * be checked without their keys.
 */
export async function unlock(envelope: Envelope, release: Release, policy: VerifierPolicy = DEFAULT_POLICY): Promise<Uint8Array> {
  if (!isRecipientEnvelope(envelope)) throw new MatteringError("POLICY", "this envelope has no recipients: open it with open()");
  const file = await removeTimeLock(envelope, release, policy);
  const { stanzaTypes } = ageHeader(file);
  if (stanzaTypes.length !== envelope.recipients!.length || stanzaTypes.some((t) => t !== "X25519")) {
    throw new MatteringError("BINDING", "the age file inside does not hold one X25519 key stanza per named recipient");
  }
  return file;
}

/** Open a version 2 envelope as one of its recipients, with that recipient's identity (`AGE-SECRET-KEY-1…`). */
export async function openAs(envelope: Envelope, release: Release, identity: string, policy: VerifierPolicy = DEFAULT_POLICY): Promise<Uint8Array> {
  return ageDecryptWithIdentity(await unlock(envelope, release, policy), identity);
}

/**
 * The file key of a version 2 envelope, as a recipient recovers it: 16 bytes,
 * lowercase hex. Handing it to someone lets them read this envelope, and only
 * this one, without the recipient's identity.
 */
export async function fileKeyOf(envelope: Envelope, release: Release, identity: string, policy: VerifierPolicy = DEFAULT_POLICY): Promise<string> {
  return bytesToHex(await ageFileKey(await unlock(envelope, release, policy), identity));
}

/** Open a version 2 envelope with a disclosed file key. */
export async function openWithFileKey(envelope: Envelope, release: Release, fileKey: string, policy: VerifierPolicy = DEFAULT_POLICY): Promise<Uint8Array> {
  return ageDecryptWithFileKey(await unlock(envelope, release, policy), fileKey);
}

/**
 * Check a disclosure: does this version 2 envelope, under this release and
 * this file key, open to exactly this payload? Anyone given the key can run
 * it; nobody needs a recipient's identity.
 */
export async function verifyDisclosure(
  envelope: Envelope,
  payload: Uint8Array,
  release: Release,
  fileKey: string,
  policy: VerifierPolicy = DEFAULT_POLICY,
): Promise<VerificationResult> {
  const pre = verifyEnvelope(envelope, policy);
  if (!pre.ok) return pre;
  const checks: Check[] = [...pre.checks];
  let opened: Uint8Array | undefined;
  try {
    opened = await openWithFileKey(envelope, release, fileKey, policy);
    checks.push({ name: "opens-with-file-key", ok: true });
  } catch (error) {
    const e = error as MatteringError;
    checks.push({ name: "opens-with-file-key", ok: false, detail: `${e.code ?? "ERROR"}: ${e.message}` });
  }
  if (opened) {
    const same = opened.length === payload.length && opened.every((byte, i) => byte === payload[i]);
    checks.push(same ? { name: "payload-matches", ok: true } : { name: "payload-matches", ok: false, detail: "the envelope opens to different bytes" });
  }
  const ok = checks.every((c) => c.ok);
  return pre.envelopeId === undefined ? { ok, checks } : { ok, checks, envelopeId: pre.envelopeId };
}

// --- auctions whose bids are sealed to recipients (policy version 4) ----------------

/**
 * Seal a bid to an auction whose policy names recipients: to the release round
 * and to those recipients only. Everything else is as `prepareBid`.
 */
export async function prepareBidTo(policy: AnyAuctionPolicy, amount: number, keys: KeyPair): Promise<PreparedBid> {
  const recipients = bidRecipients(policy);
  if (recipients.length === 0) throw new MatteringError("MALFORMED", "this auction names no recipients: use prepareBid");
  return prepareBidWith(policy, amount, keys, (options) => sealTo({ ...options, recipients }));
}

/** Open bids as one of the recipients, with its age identity. */
export function bidOpenerAs(identity: string): BidOpener {
  return (envelope, release, verifier) => openAs(envelope, release, identity, { acceptedBeacons: verifier.acceptedBeacons });
}

/** Open bids with file keys a recipient disclosed, by envelope id. A bid with no key stays unresolved. */
export function bidOpenerWithFileKeys(keys: Readonly<Record<string, string>>): BidOpener {
  return async (envelope, release, verifier) => {
    const key = keys[envelopeId(envelope)];
    return key === undefined ? undefined : openWithFileKey(envelope, release, key, { acceptedBeacons: verifier.acceptedBeacons });
  };
}

/**
 * What a recipient (the organiser) discloses about a released auction, to an
 * auditor or to the bidders: the file key of every bid it can open. With
 * these, `verifyAuction(inputs, verifier, bidOpenerWithFileKeys(keys))` reaches
 * the same result without the recipient's identity.
 */
export async function discloseBids(inputs: AuctionInputs, identity: string, verifier: VerifierPolicy): Promise<Record<string, string>> {
  const envelopes = inputs.envelopes instanceof Map ? inputs.envelopes : new Map(Object.entries(inputs.envelopes));
  const hash = policyHash(inputs.policy);
  const keys: Record<string, string> = {};
  for (const entry of inputs.entries) {
    if (!("submitter" in entry) || entry.policyHash !== hash) continue;
    const envelope = suppliedEnvelope(envelopes, entry.envelopeId);
    if (!envelope || !isRecipientEnvelope(envelope)) continue;
    try {
      keys[entry.envelopeId] = await fileKeyOf(envelope, inputs.release, identity, { acceptedBeacons: verifier.acceptedBeacons });
    } catch {
      // Not openable with this identity: nothing to disclose for it.
    }
  }
  return keys;
}
