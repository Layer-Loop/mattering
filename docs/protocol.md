# Protocol note

**Version:** envelope format 1. **Status:** sections 1 to 7 are implemented, except where a paragraph says "not built". Section 8 is an intention only.

This note is meant to be enough to write a second implementation, and enough for a reviewer to find what is wrong.

## 1. Parties

| Party | Does | Trusted for |
| --- | --- | --- |
| **Sealer** | Creates an envelope | Nothing. Knows the payload and may reveal it |
| **Beacon** (drand quicknet) | Emits one BLS signature per round | Not emitting early (secrecy) and emitting at all (opening) |
| **Verifier / opener** | Checks and opens envelopes | Nothing. Anyone can be one |
| **Witness** | Records submissions in a log | Not backdating entries. Other misbehaviour is detectable |

There is no party that holds plaintext or keys on anyone's behalf.

## 2. Encodings

- **Canonical JSON** is RFC 8785, restricted: values are strings, booleans, integers within ±(2^53 − 1), arrays and objects. No null, no fractions, no ill-formed Unicode. Anything else is rejected before hashing.
- **Labelled hash:** `H(label, data) = SHA-256(label ‖ 0x00 ‖ data)`, with `label` in UTF-8. Every hash in the protocol uses a distinct label.
- **Hex** is lowercase.

## 3. The envelope

```json
{
  "format": "mattering.envelope/1",
  "beacon": {
    "chainHash": "52db9ba7…e971",
    "publicKey": "83cf0f28…e45a",
    "scheme": "bls-unchained-g1-rfc9380",
    "genesisTime": 1692803367,
    "period": 3
  },
  "round": 34213670,
  "context": { "purpose": "demo" },
  "ciphertext": "-----BEGIN AGE ENCRYPTED FILE-----\n…\n-----END AGE ENCRYPTED FILE-----\n"
}
```

| Field | Meaning |
| --- | --- |
| `format` | Exactly `mattering.envelope/1` |
| `beacon` | The drand chain the seal is locked to. All five fields are required. Only the scheme shown is supported |
| `round` | The round whose signature opens the seal |
| `context` | Public metadata chosen by the caller, as a canonical JSON object. Not secret |
| `ciphertext` | An armored [age](https://age-encryption.org/v1) file with exactly one `tlock` stanza, as produced by drand's tlock tools |

No other fields are allowed. The **header** is the envelope without `ciphertext`.

**Armor** must be in one layout: the begin line, standard padded base64 in 64-character lines, the end line, each ended by a single `\n`. A reader decodes, re-encodes and requires the text to be identical. The `ciphertext` string can be given unchanged to drand's own `tle` tool.

**Identifiers**

- `headerHash = H("mattering/envelope-header/v1", canonical(header))`
- `envelopeId = H("mattering/envelope/v1", canonical(envelope))`, written as hex

## 4. Sealing

1. Build the header.
2. Build the frame: `"MTRG" ‖ 0x01 ‖ headerHash ‖ payload`.
3. Encrypt the frame with tlock to `round` under `beacon.publicKey`.
4. Re-armor the result into the canonical layout.

The frame exists because the tlock/age format has no input for associated data. Putting `headerHash` inside the ciphertext binds the round, beacon and context to the payload: an envelope whose header was changed still decrypts, but the frame check fails.

Sealing is local. It needs the beacon's public parameters and nothing else.

## 5. Verifying and opening

**While sealed** (`verifyEnvelope`), with a policy listing the beacons the verifier accepts:

1. The envelope is well-formed (section 3).
2. `beacon` equals an accepted beacon in all five fields.
3. The `tlock` stanza in the age header names the same round and chain hash as the header.
4. Optionally, `round` and `context` equal values the verifier expects.

This shows the envelope is addressed correctly. It does not show that it will open or what it holds. A sealer can submit a well-formed envelope containing garbage, and that is only discovered at opening.

Step 2 matters. A sealer could name a beacon whose key they hold and open the seal whenever they like. The verifier must choose the clock.

**Opening** (`open`) takes the envelope and a **release**: `{ round, signature }`, the beacon's signature for the round.

1. Run the sealed checks.
2. `release.round` equals `envelope.round`.
3. `release.signature` is a valid BLS signature on `SHA-256(round as 8 bytes, big-endian)` under `beacon.publicKey`, with domain separation tag `BLS_SIG_BLS12381G1_XMD:SHA-256_SSWU_RO_NUL_`.
4. tlock decryption succeeds.
5. The result starts with `"MTRG" ‖ 0x01 ‖ headerHash`. The rest is the payload.

Each step fails with its own error code. The signature is public once emitted and can come from any source.

**Verifying an opening** (`verifyOpen`) repeats the opening and compares the result with a claimed payload.

## 6. Submissions and the witness log

Sealing proves nothing about when. A deadline needs someone to say "I saw this before then", and that someone is the **witness**: a party that keeps an append-only log of submissions. Mattering intends to run a public witness; the formats are open and anyone can run another.

All signatures are Ed25519 over `H(label, canonical(object without its signature field))`.

**Submission**, signed by the submitter (label `mattering/submission/v1`):

```text
{ format: "mattering.submission/1", policyHash, envelopeId, submitter, commitment, signature }
```

`submitter` is an Ed25519 public key. What that key stands for is outside Mattering.

**Log.** A Merkle tree as in RFC 6962 section 2.1 (Certificate Transparency), over SHA-256. A leaf is the canonical JSON of a submission. Entries are in arrival order. The implementation is checked against the Certificate Transparency reference vectors.

**Receipt**, returned to the submitter (label `mattering/receipt/v1`):

```text
{ format: "mattering.receipt/1", witness, index, size, root, proof, signature }
```

It states that the submission is entry `index` of a tree with `size` entries and root `root`, with an RFC 6962 audit path. A receipt is a promise. If a log published later does not have that entry at that index under that root, the receipt proves the witness misbehaved.

**Checkpoint** (label `mattering/checkpoint/v1`):

```text
{ format: "mattering.checkpoint/1", witness, size, root, observed: { round, signature }, closes?, signature }
```

`observed` is a beacon round signature the witness had seen, which proves the checkpoint was made after that round. `closes`, when present, is a policy hash and marks the closing checkpoint for that policy.

**Deadline.** A policy names a **close round** and a later **release round**. Once the witness has seen the close round's signature it issues the closing checkpoint for the policy, with `observed` set to that signature, and refuses further submissions under the policy. A submission is on time if its index is below the closing checkpoint's `size`. The verifier requires `observed.round` to equal the close round, so a witness cannot close early.

The deadline is measured on the beacon's clock as seen by the witness. A bidder's own clock and any timestamp a bidder supplies play no part.

What this gives, and what it does not:

| Property | Holds? |
| --- | --- |
| The witness did not close before the close round | Yes. The closing checkpoint must cite that round's signature |
| A receipted submission cannot be silently dropped | Yes, detectable with the receipt |
| The log given to a verifier is the one the witness signed | Yes. The verifier recomputes the root |
| The witness cannot show two different logs | Detectable when two checkpoints of the same size are compared |
| The witness cannot refuse a submission | **No.** Refusal leaves no evidence |
| The witness cannot add a submission after the close round and before signing the closing checkpoint | **No.** Nothing bounds the checkpoint's time from above. That needs the checkpoint to be anchored somewhere the witness does not control before the release round. **Not built** |
| The witness cannot reorder entries before signing | **No.** Order does not affect the outcome (section 7) |

Also not built: consistency proofs between checkpoints (a verifier is given the whole log instead), persistence, and any network interface. The witness is an in-process object.

## 7. Sealed bids

**Policy**, immutable, identified by `policyHash = H("mattering/auction-policy/v1", canonical(policy))`:

```text
{ format: "mattering.auction-policy/1", auctionId, beacon, closeRound, releaseRound, witness,
  minBid, maxBid, rule: "highest-bid", tieBreak: "release-round-signature" }
```

**Bid**, the payload sealed to `releaseRound`, as canonical JSON:

```text
{ format: "mattering.bid/1", policyHash, bidder, amount, blinding }
```

The envelope's `context` is `{ kind: "mattering.bid/1", policyHash, bidder }`. The submission carries a Pedersen commitment `C = amount·B + blinding·B'` on Ristretto255, where `B` is the basepoint and `B'` is the hash-to-group of SHA3-512 of `B`'s encoding. These are the default generators of the dalek `bulletproofs` library.

**While sealed**, anyone can check that a submission is signed, names this policy, and names an envelope that is well-formed, locked to the release round on the policy's beacon, and carries the expected context. Nothing about the amount can be checked.

**After release**, the verifier takes the policy, the log, the closing checkpoint, the envelopes and the release round's signature, and:

1. Checks the evidence: policy well-formed, beacon accepted by the verifier, closing checkpoint signed by the policy's witness and citing the close round, log root equal to the checkpoint's, release signature valid.
2. Takes the entries below the closing size that name this policy, in order. Only a submitter's first entry counts.
3. For each, opens the envelope and requires: the payload is a canonical bid; `policyHash` and `bidder` inside the bid equal the policy's hash and the submission's `submitter`; `C` opens to `amount` and `blinding`; `minBid ≤ amount ≤ maxBid`.
4. A bid failing any check is **invalid**, with the reason, and attributable to its submitter's key. A bid whose envelope was not supplied is **unresolved**, and the auction then has no result.
5. The winner is the highest valid amount. Among equal amounts, the lowest `H("mattering/tie-break/v1", releaseSignature ‖ envelopeId)` wins.

The `bidder` inside the seal is what stops copying. Anyone can submit someone else's envelope under their own key, but it will be invalid, because the envelope names its real bidder. For the same reason entries are not de-duplicated by envelope: doing so would let a copier who reached the log first void the genuine bid.

Arrival order does not affect who wins. The tie-break depends on a value nobody knew at submission time, though a colluding drand threshold would know it.

**What the commitment is for.** In this auction, nothing that the opened bid does not already give: every bid is opened, so the amount and the range are checked in the clear. It is included so that a later version can keep losing bids sealed and prove facts about them. The link between commitment and ciphertext is checked **after** opening only. Before opening, a submission can carry a commitment to one amount beside a ciphertext holding another, and nobody can tell; the tests demonstrate this. Closing that gap needs a proof this design does not have. See research question 9.

## 8. Commitment registry

The same log, read as a public record: who committed to what envelope, when, under which policy, and what it opened to. The intended first use is agents that seal a prediction or a decision before an outcome is known. Not designed in detail and not built.

## 9. Things this design does not do

- Keep anything secret after the release round.
- Encrypt to a recipient.
- Prove a range, or anything else, about a sealed value before it opens.
- Store envelopes durably. Whoever needs an envelope opened must keep it.
- Identify or authenticate agents. A submitter is a public key, and what that key stands for is someone else's problem.
