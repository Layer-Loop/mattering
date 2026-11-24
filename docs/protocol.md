# Protocol note

**Version:** envelope format 1. **Status:** implemented, except where a paragraph says "not built".

This note is meant to be enough to write a second implementation, and enough for a reviewer to find what is wrong.

## 1. Parties

| Party | Does | Trusted for |
| --- | --- | --- |
| **Sealer** | Creates an envelope | Nothing. Knows the payload and may reveal it |
| **Beacon** (drand quicknet) | Emits one BLS signature per round | Not emitting early (secrecy) and emitting at all (opening) |
| **Verifier / opener** | Checks and opens envelopes | Nothing. Anyone can be one |
| **Witness** | Records submissions in a log and closes policies | Not refusing submissions. With cosigners, nothing else |
| **Cosigner** | A transparency-log witness, such as one on the public witness network: cosigns the log, dated, and never cosigns a fork of it | Not colluding with the witness, and dating honestly. A policy says how many must cosign |

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
{ format: "mattering.submission/1", policyHash, envelopeId, submitter, commitment?, signature }
```

`submitter` is an Ed25519 public key. What that key stands for is outside Mattering. `commitment` is present for auction bids and absent otherwise.

**Log.** A Merkle tree as in RFC 6962 section 2.1 (Certificate Transparency), over SHA-256. A leaf is the canonical JSON of an entry: a submission, or a close entry (below). Entries are in arrival order. The implementation is checked against the Certificate Transparency reference vectors. The log has an **origin**, its name in the C2SP formats public witnesses use, such as `example.com/log`; policies name it.

**Close entry**, written into the log by the witness when it closes a policy:

```text
{ format: "mattering.close/1", policyHash, observed: { round, signature } }
```

The first close entry for a policy fixes which entries count: those before it. Because it is in the log, the cosignatures that date the log (below) also date the closing.

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

**Deadline.** A policy names a **close round** and a later **release round**. Once the witness has seen the close round's signature it appends the policy's close entry and issues the closing checkpoint for the policy, ending with that entry and with `observed` set to that signature, and refuses further submissions under the policy. A submission is on time if it comes before the close entry. The verifier requires `observed.round` to equal the close round, so a witness cannot close early; requires the closing checkpoint to end with this policy's close entry; and requires no earlier close entry for the policy in the log.

The witness treats a policy as closed from whichever comes first: it has seen the close round, or the close round is due by the witness's own clock and the beacon's published schedule. The second rule is needed because relays can serve a "latest" round that is behind the real beacon; a witness relying on the relay alone accepted a late submission when first run against live drand. A bidder's own clock and any timestamp a bidder supplies play no part. A verifier cannot check when an entry arrived: that the witness applied this rule is part of trusting the witness.

What this gives, and what it does not:

| Property | Holds? |
| --- | --- |
| The witness did not close before the close round | Yes. The closing checkpoint must cite that round's signature |
| A receipted submission cannot be silently dropped | Yes, detectable with the receipt |
| The log given to a verifier is the one the witness signed | Yes. The verifier recomputes the root |
| The witness cannot show two different logs | Detectable when two checkpoints of the same size are compared |
| The witness cannot refuse a submission | **No.** Refusal leaves no evidence |
| The witness cannot rewrite the log after the release round, when it can read every entry | Yes, if the policy requires cosigners, fewer than the threshold collude with it, and their clocks are honest. With no cosigners: **no** |
| The witness cannot move the closing after the release round | Yes, under the same conditions. The first close entry decides, and it was cosigned before the release |
| The witness cannot add a submission between the close round and its close entry | **No.** It cannot read the other entries at that point, so the entry is blind, but it is late |
| The witness cannot reorder entries before signing | **No.** Order does not affect the outcome (section 7) |

**Cosignatures.** These use the formats of the public witness network, unchanged, so that a public witness can serve as a cosigner without knowing anything about Mattering:

- [C2SP signed-note](https://c2sp.org/signed-note): text signed by named Ed25519 keys, with keys published as `<name>+<key id>+<key>`.
- [C2SP tlog-checkpoint](https://c2sp.org/tlog-checkpoint): the log's origin, size and root as a signed note. The witness signs it with its own key under the origin's name.
- [C2SP tlog-witness](https://c2sp.org/tlog-witness): a log submits a checkpoint with an RFC 6962 consistency proof from the last checkpoint that cosigner signed, to `POST <prefix>/add-checkpoint`. The cosigner refuses anything that is not consistent with what it has already cosigned.
- [C2SP tlog-cosignature](https://c2sp.org/tlog-cosignature): an Ed25519 cosignature (type 0x04) over `cosignature/v1`, a `time` line and the checkpoint. It says that, as of that time, this was the largest tree the cosigner had seen for the log and that it is consistent with everything earlier.

The implementation matches the Go reference implementation's published signed-note vectors byte for byte. ML-DSA-44 cosignatures (type 0x06), which the specification recommends for new witnesses, are not supported yet; they are ignored like any unknown key's.

A policy names the log's `origin`, a list of cosigners as verifier keys, and a threshold, which must be more than half of the cosigners. The evidence for a policy carries a **witnessed checkpoint**:

```text
{ checkpoint: <C2SP checkpoint with cosignature lines>, proof: [ base64 hash, ... ] }
```

`proof` is the RFC 6962 consistency proof from the closing checkpoint to `checkpoint`. A verifier counts a cosigner if the checkpoint is for the policy's origin, the log it describes extends the closing checkpoint, and the cosigner's cosignature is valid and dated before the release round's scheduled time. It requires the threshold from distinct named cosigners.

Why this matters: after the release round the witness can read every bid. Without cosigners it could then build a different log with a winning entry of its own and sign a closing checkpoint for it. With cosigners, the log up to and including the close entry was cosigned before anything could be read. A rewritten log is a fork, which an honest cosigner never cosigns. A log extended after the release, with a later bid and a second close entry, can be cosigned, but the cosignature is dated after the release, and the first close entry still decides.

The threshold must be a majority because a witness could otherwise show one version of its log to some cosigners and another to the rest, and collect a full set of cosignatures for each.

That a cosignature was made before the release rests on the cosigner's clock and honesty, not on cryptography. The time is the cosigner's own statement.

Not built: anchoring checkpoints to a public ledger, which would replace trust in cosigners with trust in that ledger.

## 7. Sealed bids

**Policy**, immutable, identified by `policyHash = H("mattering/auction-policy/v1", canonical(policy))`:

```text
{ format: "mattering.auction-policy/2", auctionId, beacon, closeRound, releaseRound, witness, origin,
  cosigners, cosignerThreshold, minBid, maxBid, rule: "highest-bid", tieBreak: "release-round-signature" }
```

**Bid**, the payload sealed to `releaseRound`, as canonical JSON:

```text
{ format: "mattering.bid/1", policyHash, bidder, amount, blinding }
```

The envelope's `context` is `{ kind: "mattering.bid/1", policyHash, bidder }`. The submission carries a Pedersen commitment `C = amount·B + blinding·B'` on Ristretto255, where `B` is the basepoint and `B'` is the hash-to-group of SHA3-512 of `B`'s encoding. These are the default generators of the dalek `bulletproofs` library.

**While sealed**, anyone can check that a submission is signed, names this policy, and names an envelope that is well-formed, locked to the release round on the policy's beacon, and carries the expected context. Nothing about the amount can be checked.

**After release**, the verifier takes the policy, the log, the closing checkpoint, the envelopes and the release round's signature, and:

1. Checks the evidence: policy well-formed, beacon accepted by the verifier, closing checkpoint signed by the policy's witness and citing the close round, enough valid cosignatures, log root equal to the checkpoint's, the checkpoint ending with the policy's first close entry, release signature valid.
2. Takes the submissions before the close entry that name this policy, in order. Only a submitter's first entry counts.
3. For each, opens the envelope and requires: the payload is a canonical bid; `policyHash` and `bidder` inside the bid equal the policy's hash and the submission's `submitter`; `C` opens to `amount` and `blinding`; `minBid ≤ amount ≤ maxBid`.
4. A bid failing any check is **invalid**, with the reason, and attributable to its submitter's key. A bid whose envelope was not supplied is **unresolved**, and the auction then has no result.
5. The winner is the highest valid amount. Among equal amounts, the lowest `H("mattering/tie-break/v1", releaseSignature ‖ envelopeId)` wins.

The `bidder` inside the seal is what stops copying. Anyone can submit someone else's envelope under their own key, but it will be invalid, because the envelope names its real bidder. For the same reason entries are not de-duplicated by envelope: doing so would let a copier who reached the log first void the genuine bid.

Arrival order does not affect who wins. The tie-break depends on a value nobody knew at submission time, though a colluding drand threshold would know it.

**What the commitment is for.** In this auction, nothing that the opened bid does not already give: every bid is opened, so the amount and the range are checked in the clear. It is included so that a later version can keep losing bids sealed and prove facts about them. The link between commitment and ciphertext is checked **after** opening only. Before opening, a submission can carry a commitment to one amount beside a ciphertext holding another, and nobody can tell; the tests demonstrate this. Closing that gap needs a proof this design does not have. See research question 9.

## 8. Sealed statements and the registry

A **statement** is text committed before a deadline and opened for everyone at a set round: a prediction, a decision, an answer.

**Statement policy**, identified by `H("mattering/statement-policy/v1", canonical(policy))`:

```text
{ format: "mattering.statement-policy/2", topic, beacon, closeRound, releaseRound, witness, origin, cosigners, cosignerThreshold }
```

**Statement**, the sealed payload, at most 16,384 bytes as canonical JSON:

```text
{ format: "mattering.statement/1", policyHash, author, text }
```

The envelope's context is `{ kind: "mattering.statement/1", policyHash, author }`. The submission carries no commitment. Deadlines, receipts, cosignatures and verification are exactly as for bids: after release, a verifier checks the evidence and opens each on-time envelope, and a statement is valid if it is canonical, names this policy, and names the submitter as its author. One statement per author counts.

The **registry** is the witness log read as a public record: for any key, what it committed to, under which policy, and what each commitment opened to. The service in [service.md](service.md) serves this view. It is a convenience over the evidence, which anyone can fetch and check.

A statement proves that a key committed to some text before the close. It says nothing about who or what controls the key, or whether the same party also committed to the opposite under another key.

## 9. Things this design does not do

- Keep anything secret after the release round.
- Encrypt to a recipient.
- Prove a range, or anything else, about a sealed value before it opens.
- Store envelopes durably. Whoever needs an envelope opened must keep it.
- Identify or authenticate agents. A submitter is a public key, and what that key stands for is someone else's problem.
