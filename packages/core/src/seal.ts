import {
  assertBeaconInfo,
  assertRound,
  QUICKNET,
  sameBeacon,
  verifyRelease,
  type BeaconInfo,
  type Release,
} from "./beacon.ts";
import { assertCanonicalizable, canonicalEquals } from "./canonical.ts";
import {
  armor,
  assertEnvelope,
  base64Decode,
  ENVELOPE_FORMAT,
  envelopeId,
  frame,
  parseArmor,
  readStanza,
  unframe,
  type Context,
  type Envelope,
  type EnvelopeHeader,
} from "./envelope.ts";
import { MatteringError } from "./errors.ts";
import { tlockDecrypt, tlockEncrypt } from "./tlock.ts";

export interface SealOptions {
  payload: Uint8Array;
  /** The drand round that opens the seal. */
  round: number;
  /** Defaults to drand quicknet. */
  beacon?: BeaconInfo;
  /** Public metadata to bind to the payload. Do not put secrets here. */
  context?: Context;
}

/**
 * Seal `payload` until `round`. Purely local: needs only the beacon's public
 * parameters, no network and no Mattering service.
 */
export async function seal(options: SealOptions): Promise<Envelope> {
  const beacon = options.beacon ?? QUICKNET;
  const context = options.context ?? {};
  assertBeaconInfo(beacon);
  assertRound(options.round);
  assertCanonicalizable(context, "context");
  const header: EnvelopeHeader = { format: ENVELOPE_FORMAT, beacon: { ...beacon }, round: options.round, context };
  const armored = await tlockEncrypt(beacon, options.round, frame(header, options.payload));
  // Re-armor into the one canonical layout rather than trusting the library's.
  const ciphertext = armor(decodeAnyArmor(armored));
  const envelope: Envelope = { ...header, ciphertext };
  assertEnvelope(envelope);
  return envelope;
}

function decodeAnyArmor(text: string): Uint8Array {
  const body = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("-----"))
    .join("");
  return base64Decode(body);
}

// --- verification before opening --------------------------------------------

export interface VerifierPolicy {
  /**
   * Beacons the verifier trusts as time sources. An envelope naming any other
   * beacon is rejected: a sender who controls the beacon controls the "lock".
   */
  acceptedBeacons: readonly BeaconInfo[];
  /** If set, the envelope must open at exactly this round. */
  expectedRound?: number;
  /** If set, the envelope's context must equal this. */
  expectedContext?: Context;
}

export const DEFAULT_POLICY: VerifierPolicy = Object.freeze({ acceptedBeacons: Object.freeze([QUICKNET]) });

export interface Check {
  name: string;
  ok: boolean;
  detail?: string;
}

export interface VerificationResult {
  ok: boolean;
  checks: Check[];
  envelopeId?: string;
}

function result(checks: Check[], id?: string): VerificationResult {
  const base = { ok: checks.every((c) => c.ok), checks };
  return id === undefined ? base : { ...base, envelopeId: id };
}

/**
 * Everything that can be checked while the envelope is still sealed. It says
 * the envelope is well-formed and addressed to an accepted beacon and round.
 * It does not say the ciphertext will open, or what is inside.
 */
export function verifyEnvelope(value: unknown, policy: VerifierPolicy = DEFAULT_POLICY): VerificationResult {
  const checks: Check[] = [];
  try {
    assertEnvelope(value);
    checks.push({ name: "well-formed", ok: true });
  } catch (error) {
    checks.push({ name: "well-formed", ok: false, detail: (error as Error).message });
    return result(checks);
  }
  const envelope = value;

  const accepted = policy.acceptedBeacons.some((b) => sameBeacon(b, envelope.beacon));
  checks.push(
    accepted
      ? { name: "beacon-accepted", ok: true }
      : { name: "beacon-accepted", ok: false, detail: `chain ${envelope.beacon.chainHash} is not an accepted beacon` },
  );

  try {
    const stanza = readStanza(envelope.ciphertext);
    const matches = stanza.round === envelope.round && stanza.chainHash === envelope.beacon.chainHash;
    checks.push(
      matches
        ? { name: "ciphertext-addressed-to-header", ok: true }
        : {
            name: "ciphertext-addressed-to-header",
            ok: false,
            detail: `ciphertext is locked to round ${stanza.round} on chain ${stanza.chainHash}`,
          },
    );
  } catch (error) {
    checks.push({ name: "ciphertext-addressed-to-header", ok: false, detail: (error as Error).message });
  }

  if (policy.expectedRound !== undefined) {
    const ok = envelope.round === policy.expectedRound;
    checks.push(ok ? { name: "round-as-expected", ok } : { name: "round-as-expected", ok, detail: `round is ${envelope.round}, expected ${policy.expectedRound}` });
  }
  if (policy.expectedContext !== undefined) {
    const ok = canonicalEquals(envelope.context, policy.expectedContext);
    checks.push(ok ? { name: "context-as-expected", ok } : { name: "context-as-expected", ok, detail: "context differs from the expected context" });
  }
  return result(checks, envelopeId(envelope));
}

// --- opening -----------------------------------------------------------------

/**
 * Open a sealed envelope with the beacon's signature for its round.
 *
 * Needs the envelope, the release material and nothing else: no sender, no
 * recipient key, no Mattering service. Throws `MatteringError`; the code says
 * which step failed.
 */
export async function open(
  envelope: Envelope,
  release: Release,
  policy: VerifierPolicy = DEFAULT_POLICY,
): Promise<Uint8Array> {
  const pre = verifyEnvelope(envelope, policy);
  if (!pre.ok) {
    const failed = pre.checks.find((c) => !c.ok)!;
    const code = failed.name === "well-formed" || failed.name === "ciphertext-addressed-to-header" ? "MALFORMED" : "POLICY";
    throw new MatteringError(code, `${failed.name}: ${failed.detail ?? "failed"}`);
  }
  if (release.round !== envelope.round) {
    throw new MatteringError("RELEASE_MISMATCH", `release is for round ${release.round}; the envelope opens at round ${envelope.round}`);
  }
  if (!verifyRelease(envelope.beacon, release)) {
    throw new MatteringError("RELEASE_INVALID", `not a valid beacon signature for round ${release.round}`);
  }
  let framed: Uint8Array;
  try {
    framed = await tlockDecrypt(envelope.beacon, release, envelope.ciphertext);
  } catch {
    throw new MatteringError("DECRYPT_FAILED", "ciphertext did not open under the round's signature (corrupt or not a valid seal)");
  }
  return unframe(envelope, framed);
}

/**
 * Check a claimed opening: does this envelope open, under this release
 * material, to exactly this payload? Anyone can run it after the round.
 */
export async function verifyOpen(
  envelope: Envelope,
  payload: Uint8Array,
  release: Release,
  policy: VerifierPolicy = DEFAULT_POLICY,
): Promise<VerificationResult> {
  const pre = verifyEnvelope(envelope, policy);
  if (!pre.ok) return pre;
  const checks = [...pre.checks];
  let opened: Uint8Array | undefined;
  try {
    opened = await open(envelope, release, policy);
    checks.push({ name: "opens-under-release", ok: true });
  } catch (error) {
    const e = error as MatteringError;
    checks.push({ name: "opens-under-release", ok: false, detail: `${e.code ?? "ERROR"}: ${e.message}` });
  }
  if (opened) {
    const same = opened.length === payload.length && opened.every((byte, i) => byte === payload[i]);
    checks.push(same ? { name: "payload-matches", ok: true } : { name: "payload-matches", ok: false, detail: "the envelope opens to different bytes" });
  }
  return result(checks, pre.envelopeId);
}

