# Protocol note

**Version:** envelope format 1. **Status:** sections 1 to 5 are implemented. Sections 6 to 9 are a design that has not been built and will change.

This note is meant to be enough to write a second implementation, and enough for a reviewer to find what is wrong.

## 1. Parties

| Party | Does | Trusted for |
| --- | --- | --- |
| **Sealer** | Creates an envelope | Nothing. Knows the payload and may reveal it |
| **Beacon** (drand quicknet) | Emits one BLS signature per round | Not emitting early (secrecy) and emitting at all (opening) |
| **Verifier / opener** | Checks and opens envelopes | Nothing. Anyone can be one |
| **Witness** (Phase 2) | Records submissions in a log | Not backdating entries. Other misbehaviour is detectable |

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

---

*Everything below is design, not code.*

## 6. Submissions and the witness log

Sealing proves nothing about when. A deadline needs someone to say "I saw this before then", and that someone is the **witness**: a service that keeps an append-only log of submissions. Mattering intends to run a public witness; the format is open and anyone can run another.

**Submission**, signed by the submitter's Ed25519 key:

```text
{ format: "mattering.submission/1", envelopeId, policyHash, submitter, commitment?, signature }
```

**Log.** A Merkle tree over submission hashes in arrival order, as in Certificate Transparency (RFC 6962). The intent is to reuse an existing checkpoint and proof format, not define one.

**Receipt**, returned to the submitter: a witness-signed statement of the entry's index and the tree it is in, with an inclusion proof. A receipt is a promise. If the entry is later missing from the log, the receipt proves the witness misbehaved.

**Checkpoint.** A witness-signed tree size and root. Each checkpoint also carries the most recent drand round signature the witness has seen, which proves the checkpoint was made after that round. Checkpoints are published and periodically anchored somewhere the witness does not control.

**Deadline.** A policy names a **close round** and a later **release round**. The witness publishes a closing checkpoint for the policy after the close round and before the release round. A submission is on time if it is in the tree of the closing checkpoint.

What this gives, and what it does not:

| Property | Holds? |
| --- | --- |
| A submission in the closing checkpoint existed before release | Yes, if the witness did not backdate the checkpoint. The embedded drand round bounds it from below; only external anchoring bounds it from above |
| A receipted submission cannot be silently dropped | Yes, detectable with the receipt |
| The witness cannot show two different logs | Detectable if two checkpoints are ever compared; anchoring makes this routine |
| The witness cannot refuse a submission | **No.** Refusal leaves no evidence |
| The witness cannot add its own late submission by backdating | **No**, without an external anchor made before the release round |

## 7. Sealed bids

**Policy**, immutable, identified by `policyHash = H("mattering/auction-policy/v1", canonical(policy))`:

```text
{ format, auctionId, beacon, closeRound, releaseRound, witness, minBid, maxBid, rule: "highest-bid", tieBreak: "release-round-randomness" }
```

**Bid**, the payload sealed to `releaseRound`:

```text
{ policyHash, bidder, amount, blinding }
```

The envelope's `context` is `{ policyHash, bidder }`. The submission carries a Pedersen commitment `C = amount·B + blinding·B'` on Ristretto255.

After release, for each on-time submission the verifier opens the envelope and requires:

1. `policyHash` and `bidder` inside the bid equal those in the context and the submission, and `bidder` signed the submission. This is what stops one bidder resubmitting another's ciphertext as their own.
2. `C` opens to `amount` and `blinding`.
3. `minBid ≤ amount ≤ maxBid`.

A bid that fails any check is invalid and publicly attributable to its submitter. The winner is the highest valid bid. Ties are broken by an ordering derived from the release round's signature, which nobody knew at submission time.

**What the commitment is for.** In this auction, nothing: every bid is opened, so the range and the amount are checked in the clear. It is included so that a later version can keep losing bids sealed and prove facts about them. Doing that soundly needs a proof that the committed amount is the amount in the ciphertext, which this design does not have. See research question 2.

## 8. Commitment registry

The same log, read as a public record: who committed to what envelope, when, under which policy, and what it opened to. The intended first use is agents that seal a prediction or a decision before an outcome is known. Not designed in detail.

## 9. Things this design does not do

- Keep anything secret after the release round.
- Encrypt to a recipient.
- Prove a range, or anything else, about a sealed value before it opens.
- Store envelopes durably. Whoever needs an envelope opened must keep it.
- Identify or authenticate agents. A submitter is a public key, and what that key stands for is someone else's problem.
