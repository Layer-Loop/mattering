/**
 * Version 2 envelopes: sealed until a round and to named recipients. Nobody
 * can read one before the round, and after it only the recipients can, unless
 * one of them discloses the file key. Includes a dishonest sender.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { Decrypter, Encrypter } from "age-encryption";
import { MatteringError, RECIPIENT_ENVELOPE_FORMAT, envelopeId, open, seal, verifyEnvelope, type Envelope, type VerifierPolicy } from "@mattering/core";
import { fileKeyOf, generateRecipientKeys, openAs, openWithFileKey, recipientOf, sealTo, unlock, verifyDisclosure } from "@mattering/core/recipients";
import { TestBeacon } from "@mattering/core/testing";
import { ENVELOPE_FORMAT, armor, frame, type EnvelopeHeader } from "../packages/core/src/envelope.ts";
import { tlockEncrypt } from "../packages/core/src/tlock.ts";

const beacon = new TestBeacon("3c4f6a2b7e151628aed2a6abf7158809cf4f3c2b7e151628aed2a6abf7158809");
const policy: VerifierPolicy = { acceptedBeacons: [beacon.info] };
const ROUND = 500;
const payload = new TextEncoder().encode("offer: 98.40 per unit, 30 days");

async function rejects(promise: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof MatteringError, `expected MatteringError, got ${String(error)}`);
    assert.equal(error.code, code, error.message);
    return true;
  });
}

/** Seal by hand, as a dishonest sender would: any header, any age file inside. */
async function sealRaw(header: EnvelopeHeader, inner: Uint8Array): Promise<Envelope> {
  const armored = await tlockEncrypt(beacon.info, header.round, frame(header, inner));
  const body = armored.split("\n").filter((l) => l !== "" && !l.startsWith("-----")).join("");
  return { ...header, ciphertext: armor(Uint8Array.from(atob(body), (c) => c.charCodeAt(0))) } as Envelope;
}

const header = (recipients: string[]): EnvelopeHeader => ({ format: RECIPIENT_ENVELOPE_FORMAT, beacon: beacon.info, round: ROUND, context: { deal: "D-1" }, recipients: [...recipients].sort() });

test("only the named recipients can read it, and only after the round", async () => {
  const [buyer, seller, outsider] = await Promise.all([generateRecipientKeys(), generateRecipientKeys(), generateRecipientKeys()]);
  assert.equal(await recipientOf(buyer.identity), buyer.recipient);
  const envelope = await sealTo({ payload, round: ROUND, beacon: beacon.info, context: { deal: "D-1" }, recipients: [seller.recipient, buyer.recipient] });
  assert.equal(envelope.format, RECIPIENT_ENVELOPE_FORMAT);
  assert.deepEqual(envelope.recipients, [buyer.recipient, seller.recipient].sort(), "recipients are public, sorted");
  assert.equal(verifyEnvelope(envelope, policy).ok, true);

  // Before the round: no release exists, and an earlier round's does not fit.
  await rejects(openAs(envelope, beacon.release(ROUND - 1), buyer.identity, policy), "RELEASE_MISMATCH");

  const release = beacon.release(ROUND);
  assert.deepEqual(await openAs(envelope, release, buyer.identity, policy), payload);
  assert.deepEqual(await openAs(envelope, release, seller.identity, policy), payload);
  await rejects(openAs(envelope, release, outsider.identity, policy), "DECRYPT_FAILED");
  await rejects(open(envelope, release, policy), "POLICY");

  // Anyone can take off the time lock; what is left is a standard age file the public cannot read.
  const file = await unlock(envelope, release, policy);
  assert.equal(new TextDecoder("latin1").decode(file).includes("98.40"), false);
  const standard = new Decrypter();
  standard.addIdentity(seller.identity);
  assert.deepEqual(await standard.decrypt(file), payload, "any age implementation opens it with the identity");
});

test("a recipient can disclose the file key, and anyone can check what the envelope held", async () => {
  const [buyer, seller] = await Promise.all([generateRecipientKeys(), generateRecipientKeys()]);
  const envelope = await sealTo({ payload, round: ROUND, beacon: beacon.info, recipients: [buyer.recipient, seller.recipient] });
  const release = beacon.release(ROUND);
  const key = await fileKeyOf(envelope, release, buyer.identity, policy);
  assert.match(key, /^[0-9a-f]{32}$/);
  assert.equal(await fileKeyOf(envelope, release, seller.identity, policy), key, "every recipient unwraps the same file key");
  assert.deepEqual(await openWithFileKey(envelope, release, key, policy), payload);

  const verdict = await verifyDisclosure(envelope, payload, release, key, policy);
  assert.equal(verdict.ok, true, JSON.stringify(verdict.checks));
  assert.equal(verdict.envelopeId, envelopeId(envelope));
  const lie = await verifyDisclosure(envelope, new TextEncoder().encode("offer: 99.90 per unit"), release, key, policy);
  assert.equal(lie.checks.find((c) => c.name === "payload-matches")?.ok, false);
  const wrongKey = await verifyDisclosure(envelope, payload, release, "00".repeat(16), policy);
  assert.equal(wrongKey.checks.find((c) => c.name === "opens-with-file-key")?.ok, false);
  const other = await sealTo({ payload, round: ROUND, beacon: beacon.info, recipients: [buyer.recipient] });
  await rejects(openWithFileKey(other, release, key, policy), "DECRYPT_FAILED");
});

test("who an envelope is for cannot be changed, and has one spelling", async () => {
  const [a, b, c] = await Promise.all([generateRecipientKeys(), generateRecipientKeys(), generateRecipientKeys()]);
  const envelope = await sealTo({ payload, round: ROUND, beacon: beacon.info, recipients: [a.recipient, b.recipient] });
  const release = beacon.release(ROUND);
  // Readdressing the header to someone else breaks the binding inside the time lock.
  const readdressed = { ...envelope, recipients: [a.recipient, c.recipient].sort() };
  assert.notEqual(envelopeId(readdressed), envelopeId(envelope));
  await rejects(unlock(readdressed, release, policy), "BINDING");
  // Unsorted or repeated recipients, too many, or none, are malformed.
  assert.equal(verifyEnvelope({ ...envelope, recipients: [...envelope.recipients!].reverse() }, policy).ok, false);
  assert.equal(verifyEnvelope({ ...envelope, recipients: [] }, policy).ok, false);
  assert.equal(verifyEnvelope({ ...envelope, recipients: ["age1notakey"] }, policy).ok, false);
  await rejects(sealTo({ payload, round: ROUND, beacon: beacon.info, recipients: [a.recipient, a.recipient] }), "MALFORMED");
  // A version 1 envelope cannot carry recipients, nor a version 2 one go without.
  const { recipients: _r, ...bare } = envelope;
  assert.equal(verifyEnvelope(bare, policy).ok, false);
  assert.equal(verifyEnvelope({ ...envelope, format: ENVELOPE_FORMAT }, policy).ok, false);
  await rejects(unlock(await seal({ payload, round: ROUND, beacon: beacon.info }), release, policy), "POLICY");
});

test("a dishonest sender can shut out a named recipient, but not show recipients different contents", async () => {
  const [a, b, stranger] = await Promise.all([generateRecipientKeys(), generateRecipientKeys(), generateRecipientKeys()]);
  const release = beacon.release(ROUND);

  // Named A and B, but actually encrypted to A and a stranger. Nothing shows it
  // while sealed or after unlocking: the stanzas do not say whose key they use.
  const encrypter = new Encrypter();
  encrypter.addRecipient(a.recipient);
  encrypter.addRecipient(stranger.recipient);
  const shut = await sealRaw(header([a.recipient, b.recipient]), await encrypter.encrypt(payload));
  assert.equal(verifyEnvelope(shut, policy).ok, true);
  await unlock(shut, release, policy);
  assert.deepEqual(await openAs(shut, release, a.identity, policy), payload);
  await rejects(openAs(shut, release, b.identity, policy), "DECRYPT_FAILED");

  // Two contents in one envelope: A's stanza from one file, B's from another,
  // under one header. age authenticates the whole header under the file key,
  // so no file key makes the header valid for both, and neither opens.
  const forA = new Encrypter();
  forA.addRecipient(a.recipient);
  const fileA = await forA.encrypt(new TextEncoder().encode("price 90"));
  const forB = new Encrypter();
  forB.addRecipient(b.recipient);
  const fileB = await forB.encrypt(new TextEncoder().encode("price 99"));
  const latin = (f: Uint8Array): string => new TextDecoder("latin1").decode(f);
  const stanzaOf = (f: Uint8Array): string => latin(f).split("\n").slice(1, 3).join("\n");
  const textA = latin(fileA);
  const macAt = textA.indexOf("\n--- ") + 1;
  const spliced = Uint8Array.from(textA.slice(0, macAt) + stanzaOf(fileB) + "\n" + textA.slice(macAt), (ch) => ch.charCodeAt(0));
  const two = await sealRaw(header([a.recipient, b.recipient]), spliced);
  await unlock(two, release, policy); // well-formed: two X25519 stanzas, a MAC, the payload
  await rejects(openAs(two, release, a.identity, policy), "DECRYPT_FAILED");
  await rejects(openAs(two, release, b.identity, policy), "DECRYPT_FAILED");

  // Extra or foreign stanzas are refused when the time lock comes off.
  const three = new Encrypter();
  for (const r of [a.recipient, b.recipient, stranger.recipient]) three.addRecipient(r);
  await rejects(unlock(await sealRaw(header([a.recipient, b.recipient]), await three.encrypt(payload)), release, policy), "BINDING");
});
