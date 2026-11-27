/**
 * Writes the test vectors in this folder. Run it only when a format changes:
 *
 *   npm run vectors                       all of them
 *   npm run vectors -- auction-v4.json    only the files named, leaving the rest as recorded
 *
 * Most vectors are deterministic: canonical JSON, hashes, commitments,
 * signatures, Merkle proofs and signed notes come out the same every time.
 * Sealing is not: tlock and age encryption are randomised by design, so the
 * envelopes, auctions and negotiations here are recorded once, with what
 * opening and verifying them must give. `tests/vectors.test.ts` checks every
 * file against the library, so a vector cannot drift from the code.
 *
 * Fetches two real drand quicknet rounds from a public relay, so it needs
 * internet access.
 */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex, hexToBytes, utf8ToBytes } from "@noble/hashes/utils";
import {
  BLINDING_GENERATOR_HEX,
  COSIGNATURE_ED25519,
  Cosigner,
  NEGOTIATION_POLICY_FORMAT,
  POLICY_FORMAT,
  AUCTION_POLICY_FORMAT,
  QUICKNET,
  SIGNATURE_ED25519,
  canonicalBytes,
  checkpointText,
  commit,
  consistencyProof,
  cosign,
  envelopeId,
  firstRoundAtOrAfter,
  formatVkey,
  generateKeyPair,
  hashCanonical,
  inclusionProof,
  issueMandate,
  leafHash,
  merkleRoot,
  policyHash,
  prepareBid,
  scheduleClock,
  seal,
  signNote,
  timeOfRound,
  verifyAuction,
  type AuctionInputs,
  type AuctionPolicy,
  type SealedAuctionPolicy,
  type NegotiationPolicy,
} from "@mattering/core";
import { fetchRelease } from "@mattering/core/drand-http";
import { discloseStep, negotiationPolicyHash, prepareOffer, verifyNegotiationStep, withFileKeys, type StepInputs } from "@mattering/core/negotiation";
import { bidOpenerAs, bidOpenerWithFileKeys, discloseBids, fileKeyOf, generateRecipientKeys, prepareBidTo, sealTo } from "@mattering/core/recipients";
import { TestBeacon, TestClock } from "@mattering/core/testing";
import { WitnessService, memoryStore } from "@mattering/witness";

const here = dirname(fileURLToPath(import.meta.url));
const hex = (b: Uint8Array): string => bytesToHex(b);
const text = (s: string): string => hex(utf8ToBytes(s));
/** A fixed secret key, so the same name gives the same key in every run. */
const secret = (name: string): string => hex(sha256(utf8ToBytes(`mattering test vector key: ${name}`)));
/** Files named on the command line, if any: only these are written, so recorded vectors elsewhere stay as published. */
const only = process.argv.slice(2);
const write = (name: string, description: string, vectors: unknown): void => {
  if (only.length > 0 && !only.includes(name)) return;
  writeFileSync(join(here, name), JSON.stringify({ description, vectors }, null, 2) + "\n");
  console.log(`wrote ${name}`);
};

// A test beacon with a published secret. Whoever holds it can open anything sealed to it: test only.
const beacon = new TestBeacon(secret("test beacon").slice(0, 62) + "01");
const testVerifier = { acceptedBeacons: [beacon.info] };

// --- beacon -------------------------------------------------------------------------
// Two real, past drand quicknet rounds: the time lock against the real network.
const quicknetRounds = [1_000_000, 1_000_001];
const quicknet = await Promise.all(quicknetRounds.map((r) => fetchRelease(QUICKNET, r)));
write("beacon.json", "Beacons and their releases. A release verifies against the beacon's public key; quicknet's are real, the test beacon's secret is published for testing only.", {
  quicknet: { info: QUICKNET, releases: quicknet },
  testBeacon: { secret: beacon.secretHex, info: beacon.info, releases: [42, 43, 100].map((r) => beacon.release(r)) },
  invalid: [
    { why: "round 1,000,000's signature presented as round 1,000,001's", beacon: "quicknet", release: { round: 1_000_001, signature: quicknet[0]!.signature } },
    { why: "one byte of the signature changed", beacon: "quicknet", release: { round: 1_000_000, signature: quicknet[0]!.signature.slice(0, -2) + (quicknet[0]!.signature.endsWith("00") ? "01" : "00") } },
  ],
  schedule: [0, 1_692_803_367, 1_692_803_370, 1_800_000_000].map((t) => ({ unixSeconds: t, firstRoundAtOrAfter: firstRoundAtOrAfter(QUICKNET, t), timeOfThatRound: timeOfRound(QUICKNET, firstRoundAtOrAfter(QUICKNET, t)) })),
});

// --- canonical JSON and labelled hashes ---------------------------------------------
const canonicalCases: unknown[] = [
  { b: 2, a: 1 },
  { nested: { z: [3, 2, 1], a: "x" }, empty: {}, list: [] },
  { unicode: "£10,000 · café · 😀", escape: "quote \" backslash \\ newline \n" },
  { numbers: [0, -1, 9007199254740991, 123456789012], truth: [true, false] },
];
// Mattering accepts only plain JSON with safe integers: no null, no fractions, no integers past 2^53 - 1.
const rejected = [{ why: "null", value: { a: null } }, { why: "a fraction", value: { a: 1.5 } }, { why: "an integer past 2^53 - 1", value: { a: 9007199254740992 } }];
write("canonical.json", "RFC 8785 canonical JSON of plain values with safe integers only, and Mattering's labelled hash: SHA-256 over the label's UTF-8 bytes, a zero byte, then the canonical JSON's UTF-8 bytes. The rejected values must be refused.", {
  accepted: canonicalCases.map((value) => ({
    value,
    canonical: new TextDecoder().decode(canonicalBytes(value)),
    hashes: Object.fromEntries(["mattering/auction-policy/v1", "mattering/submission/v1"].map((label) => [label, hex(hashCanonical(label, value))])),
  })),
  rejected,
});

// --- commitments ------------------------------------------------------------------------
const blindings = [1, 2, 3].map((i) => {
  // A valid scalar: a fixed hash, big-endian, with its top four bits cleared so it is below the group order.
  const b = sha256(utf8ToBytes(`mattering test vector blinding ${i}`));
  b[0] = b[0]! & 0x0f;
  return hex(b);
});
write("commitment.json", "Pedersen commitments on Ristretto255: amount·G + blinding·H, where G is the Ristretto255 base point and H the blinding generator below. A blinding is a non-zero scalar below the group order, as 32 bytes of big-endian hex.", {
  blindingGenerator: BLINDING_GENERATOR_HEX,
  commitments: [
    { amount: 0, blinding: blindings[0], commitment: commit(0, blindings[0]!) },
    { amount: 4200, blinding: blindings[1], commitment: commit(4200, blindings[1]!) },
    { amount: 976_000, blinding: blindings[2], commitment: commit(976_000, blindings[2]!) },
  ],
  notOpening: [{ why: "the amount is one more", commitment: commit(4200, blindings[1]!), amount: 4201, blinding: blindings[1] }],
});

// --- Merkle trees -------------------------------------------------------------------------
const leaves = Array.from({ length: 7 }, (_, i) => text(`leaf ${i}`));
const leafHashes = leaves.map((l) => leafHash(hexToBytes(l)));
write("merkle.json", "RFC 6962 Merkle trees: leaf hashes, the root of every prefix, inclusion proofs and consistency proofs. Leaves are given as hex bytes.", {
  leaves,
  leafHashes: leafHashes.map(hex),
  roots: Array.from({ length: leaves.length + 1 }, (_, n) => ({ size: n, root: hex(merkleRoot(leafHashes.slice(0, n))) })),
  inclusion: [[0, 1], [2, 5], [6, 7], [3, 7]].map(([index, size]) => ({ index, size, proof: inclusionProof(leafHashes.slice(0, size), index!).map(hex) })),
  consistency: [[1, 2], [3, 7], [4, 7], [6, 7]].map(([oldSize, newSize]) => ({ oldSize, newSize, proof: consistencyProof(leafHashes.slice(0, newSize), oldSize!).map(hex) })),
});

// --- signed notes, checkpoints and cosignatures ------------------------------------------
const logKey = generateKeyPair(secret("log"));
const cosignerKey = generateKeyPair(secret("cosigner"));
const origin = "example.com/vector-log";
const cpText = checkpointText(origin, 7, hex(merkleRoot(leafHashes)));
const signed = signNote(cpText, origin, logKey.secretKey);
const cosigned = cosign(cpText, "cosigner.example", cosignerKey.secretKey, 1_800_000_000);
write("note.json", "C2SP signed notes: verifier keys, a checkpoint signed by its log (Ed25519, type 0x01), and a timestamped cosignature (type 0x04). Ed25519 is deterministic, so the signatures are exact.", {
  log: { secretKey: logKey.secretKey, publicKey: logKey.publicKey, vkey: formatVkey({ name: origin, type: SIGNATURE_ED25519, publicKey: logKey.publicKey }) },
  cosigner: { secretKey: cosignerKey.secretKey, publicKey: cosignerKey.publicKey, vkey: formatVkey({ name: "cosigner.example", type: COSIGNATURE_ED25519, publicKey: cosignerKey.publicKey }) },
  checkpointText: cpText,
  logSignatureLine: signed,
  cosignature: { timestamp: 1_800_000_000, signatureLine: cosigned },
  // The whole note: the text, a blank line, then one signature line each.
  note: `${cpText}\n${signed}${cosigned}`,
});

// --- envelopes ------------------------------------------------------------------------------
const payload = utf8ToBytes("Bid: £4,200 for lot 7. Sealed for the Mattering test vectors.\n");
const sealedTest = await seal({ payload, round: 42, beacon: beacon.info, context: { purpose: "test vector", lot: "7" } });
const sealedQuicknet = await seal({ payload, round: quicknetRounds[0]!, context: { purpose: "test vector, real drand quicknet" } });
const tampered = structuredClone(sealedTest);
tampered.context = { ...tampered.context, lot: "8" };
write("envelope.json", "Version 1 envelopes (mattering.envelope/1). Each opens to the payload with its round's release, and fails with any other round's. Encryption is randomised, so these were sealed once and recorded.", {
  payload: hex(payload),
  envelopes: [
    { name: "test beacon, round 42", beacon: "testBeacon", envelope: sealedTest, envelopeId: envelopeId(sealedTest), opensWith: beacon.release(42), payload: hex(payload), doesNotOpenWith: beacon.release(43) },
    { name: "real drand quicknet, round 1,000,000", beacon: "quicknet", envelope: sealedQuicknet, envelopeId: envelopeId(sealedQuicknet), opensWith: quicknet[0], payload: hex(payload), doesNotOpenWith: quicknet[1] },
  ],
  invalid: [{ why: "the context was changed after sealing; the header no longer matches what was sealed", beacon: "testBeacon", envelope: tampered, release: beacon.release(42) }],
});

// --- version 2: sealed to recipients ----------------------------------------------------------
const alice = await generateRecipientKeys();
const bob = await generateRecipientKeys();
const stranger = await generateRecipientKeys();
const toBoth = await sealTo({ payload, round: 42, beacon: beacon.info, recipients: [alice.recipient, bob.recipient], context: { purpose: "test vector, to recipients" } });
write("recipients.json", "Version 2 envelopes (mattering.envelope/2): locked to a round and to age X25519 recipients. A recipient opens it with the round's release and its identity; its file key lets anyone else open that one envelope. A stranger cannot.", {
  identities: { alice, bob, stranger },
  envelope: toBoth,
  envelopeId: envelopeId(toBoth),
  release: beacon.release(42),
  payload: hex(payload),
  fileKey: await fileKeyOf(toBoth, beacon.release(42), alice.identity, testVerifier),
});

// --- a witnessed, cosigned auction ---------------------------------------------------------------
async function witnessWorld(name: string) {
  const clock = new TestClock(beacon, 10);
  const cosigner = new Cosigner({ name: `${name}-cosigner.example`, logs: [], clock: scheduleClock(clock.source()), secretKey: secret(`${name} cosigner`) });
  const service = await WitnessService.open({
    store: memoryStore(),
    source: clock.source(),
    origin: `${name}.example/log`,
    secretKey: secret(`${name} witness`),
    now: () => clock.now * 1000,
    cosign: async (_vkey, body) => {
      const reply = await cosigner.addCheckpoint(body);
      return { status: reply.status, body: reply.body };
    },
  });
  cosigner.addLog(service.vkey);
  return { clock, cosigner, service };
}

{
  const { clock, cosigner, service } = await witnessWorld("auction");
  const policy: AuctionPolicy = { format: POLICY_FORMAT, auctionId: "test-vector-lot-7", beacon: beacon.info, closeRound: 100, releaseRound: 110, witness: service.publicKey, origin: service.origin, logFrom: 0, cosigners: [cosigner.vkey], cosignerThreshold: 1, minBid: 100, maxBid: 10_000, rule: "highest-bid", tieBreak: "release-round-signature" };
  await service.registerPolicy(policy);
  const bidders = ["a", "b", "c"].map((n) => generateKeyPair(secret(`bidder ${n}`)));
  for (const [i, amount] of [4200, 5100, 3900].entries()) {
    const bid = await prepareBid(policy, amount, bidders[i]!);
    await service.submit(bid.submission, bid.envelope);
  }
  clock.advanceTo(100);
  await service.tick();
  clock.advanceTo(110);
  await service.tick();
  const evidence = (await service.evidence(policyHash(policy))) as unknown as AuctionInputs;
  const result = await verifyAuction(evidence, testVerifier);
  if (!result.ok) throw new Error(`the auction vector does not verify: ${JSON.stringify(result.checks)}`);
  write("auction.json", "A sealed-bid auction on a witness log with one cosigner, closed at round 100 and released at round 110 of the test beacon. Verifying the evidence must give the result below. The bid amounts exist only inside the envelopes and the commitments.", {
    beacon: "testBeacon",
    policyHash: policyHash(policy),
    evidence,
    expected: { ok: true, winner: { submitter: result.winner!.submitter, amount: result.winner!.amount }, bids: result.bids.map((b) => ({ submitter: b.submitter, amount: b.amount, status: b.status })), checks: result.checks.map((c) => c.name) },
    tampered: { why: "a bid's entry is removed from the log after the close", failingCheck: "log-matches-closing-checkpoint" },
  });
}

// --- an auction whose bids are sealed to the organiser (policy version 4) ---------------------------
{
  const { clock, cosigner, service } = await witnessWorld("funding");
  const organiser = await generateRecipientKeys();
  const policy: SealedAuctionPolicy = { format: AUCTION_POLICY_FORMAT, auctionId: "test-vector-INV-88213-funding", unit: "bps", beacon: beacon.info, closeRound: 100, releaseRound: 110, witness: service.publicKey, origin: service.origin, logFrom: 0, cosigners: [cosigner.vkey], cosignerThreshold: 1, minBid: 50, maxBid: 1500, rule: "lowest-bid", reserve: 900, recipients: [organiser.recipient], tieBreak: "release-round-signature" };
  await service.registerPolicy(policy);
  const funders = ["a", "b", "c"].map((n) => generateKeyPair(secret(`funder ${n}`)));
  for (const [i, amount] of [720, 640, 910].entries()) {
    const bid = await prepareBidTo(policy, amount, funders[i]!);
    await service.submit(bid.submission, bid.envelope);
  }
  clock.advanceTo(100);
  await service.tick();
  clock.advanceTo(110);
  await service.tick();
  const evidence = (await service.evidence(policyHash(policy))) as unknown as AuctionInputs;
  const result = await verifyAuction(evidence, testVerifier, bidOpenerAs(organiser.identity));
  if (!result.ok) throw new Error(`the funding auction vector does not verify: ${JSON.stringify(result.checks)}`);
  const fileKeys = await discloseBids(evidence, organiser.identity, testVerifier);
  const outsider = await verifyAuction(evidence, testVerifier);
  const disclosed = await verifyAuction(evidence, testVerifier, bidOpenerWithFileKeys(fileKeys));
  if (JSON.stringify(disclosed.winner) !== JSON.stringify(result.winner)) throw new Error("disclosure gives a different winner");
  write("auction-v4.json", "A funding auction under policy version 4: the lowest bid wins, with a public reserve of 900 bps, and every bid sealed to the organiser alone. The organiser's identity, or the file keys it discloses, open the bids and must give the result below; with neither, every bid is unresolved though the evidence itself checks out. Bid 910 does not meet the reserve but is still valid; the winner is the lowest bid, 640.", {
    beacon: "testBeacon",
    policyHash: policyHash(policy),
    organiser,
    evidence,
    fileKeys,
    expected: {
      ok: true,
      reserveMet: result.reserveMet,
      winner: { submitter: result.winner!.submitter, amount: result.winner!.amount },
      bids: result.bids.map((b) => ({ submitter: b.submitter, amount: b.amount, status: b.status })),
      checks: result.checks.map((c) => c.name),
      withoutKeys: { ok: outsider.ok, bids: outsider.bids.map((b) => b.status) },
    },
  });
}

// --- a negotiation step under mandates ------------------------------------------------------------
{
  const { clock, cosigner, service } = await witnessWorld("negotiation");
  const buyerOrg = generateKeyPair(secret("buyer organisation"));
  const sellerOrg = generateKeyPair(secret("seller organisation"));
  const buyer = { signer: generateKeyPair(secret("buyer agent")), box: alice };
  const seller = { signer: generateKeyPair(secret("seller agent")), box: bob };
  const buyerMandate = issueMandate(buyerOrg, { organisationName: "Acme Treasury Ltd", agent: buyer.signer.publicKey, side: "buyer", unit: "GBP", limit: 9_750, expires: 4_000_000_000 });
  const sellerMandate = issueMandate(sellerOrg, { organisationName: "Bolt Ltd", agent: seller.signer.publicKey, side: "seller", unit: "GBP", limit: 9_600, expires: 4_000_000_000 });
  const policy: NegotiationPolicy = {
    format: NEGOTIATION_POLICY_FORMAT,
    negotiationId: "test-vector-INV-2041",
    step: 1,
    previous: "",
    item: "Pay invoice INV-2041 (£10,000) 60 days early: the amount paid now",
    unit: "GBP",
    minPrice: 9_000,
    maxPrice: 10_000,
    buyer: { signer: buyer.signer.publicKey, recipient: buyer.box.recipient, mandate: buyerMandate.mandate },
    seller: { signer: seller.signer.publicKey, recipient: seller.box.recipient, mandate: sellerMandate.mandate },
    rule: "midpoint-if-crossed",
    beacon: beacon.info,
    closeRound: 100,
    releaseRound: 110,
    witness: service.publicKey,
    origin: service.origin,
    logFrom: 0,
    cosigners: [cosigner.vkey],
    cosignerThreshold: 1,
  };
  await service.registerPolicy(policy);
  for (const [side, price, keys] of [["buyer", 9_700, buyer.signer], ["seller", 9_650, seller.signer]] as const) {
    const offer = await prepareOffer(policy, side, price, keys);
    await service.submit(offer.submission, offer.envelope);
  }
  clock.advanceTo(100);
  await service.tick();
  clock.advanceTo(110);
  await service.tick();
  const evidence = (await service.evidence(negotiationPolicyHash(policy))) as unknown as StepInputs;
  const fileKeys = await discloseStep(evidence, buyer.box.identity, testVerifier);
  const openings = { buyer: buyerMandate.opening, seller: sellerMandate.opening };
  const result = await verifyNegotiationStep(evidence, withFileKeys(fileKeys), testVerifier, openings);
  if (!result.ok) throw new Error(`the negotiation vector does not verify: ${JSON.stringify(result.checks)}`);
  write("negotiation.json", "One step of a sealed negotiation under mandates, on a witness log with one cosigner. The offers are sealed to both parties (alice is the buyer, bob the seller, as in recipients.json). With the disclosed file keys and the mandates' openings, verifying must give the outcome below; with no keys, the offers stay unresolved.", {
    beacon: "testBeacon",
    policyHash: negotiationPolicyHash(policy),
    evidence,
    fileKeys,
    openings,
    expected: { ok: true, outcome: result.outcome, offers: result.offers.filter((o) => o.side).map((o) => ({ side: o.side, price: o.price, mandate: o.mandate, status: o.status })), checks: result.checks.map((c) => c.name) },
  });
}
