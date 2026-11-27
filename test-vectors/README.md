# Test vectors

Known inputs and outputs for Mattering's formats, so that another implementation can check it matches this one. Each file is JSON: a `description` and the `vectors`. Bytes are lowercase hex unless a format says otherwise; envelopes, policies and evidence are given exactly as they travel.

[`tests/vectors.test.ts`](../tests/vectors.test.ts) checks every file against this library on each `npm test`, so the vectors cannot drift from the code. A second implementation should pass the same checks.

| File | What it pins down | Deterministic |
| --- | --- | --- |
| `beacon.json` | drand quicknet's parameters and two real rounds' signatures; a test beacon (secret published) and its releases; releases that must not verify; the round schedule | yes (quicknet rounds are fixed history) |
| `canonical.json` | RFC 8785 canonical JSON of the values Mattering accepts (plain JSON, safe integers, no `null`), the labelled hash `SHA-256(label ‖ 0x00 ‖ canonical JSON)`, and values that must be refused | yes |
| `commitment.json` | Pedersen commitments on Ristretto255: the blinding generator, commitments for given amounts and blindings, and one that must not open | yes |
| `merkle.json` | RFC 6962 leaf hashes, the root of every prefix of a 7-leaf log, inclusion proofs and consistency proofs | yes |
| `note.json` | C2SP signed notes: verifier keys, a checkpoint, the log's Ed25519 signature line, a timestamped cosignature line, and the whole note | yes |
| `envelope.json` | Version 1 envelopes, one to the test beacon and one to real drand quicknet round 1,000,000: their ids, the payload each opens to with its round's release, a release that must not open it, and a tampered envelope that must not open | recorded once |
| `recipients.json` | A version 2 envelope sealed to two age X25519 recipients: each recipient opens it, the file key opens it for anyone, a stranger cannot | recorded once |
| `auction.json` | A complete sealed-bid auction on a witness log with one cosigner: the evidence, and the result verifying it must give | recorded once |
| `auction-v4.json` | A funding auction under policy version 4: lowest bid wins, a public reserve, bids sealed to the organiser alone. The organiser's identity, or the file keys it discloses, give the result; without them every bid is unresolved | recorded once |
| `negotiation.json` | One step of a sealed negotiation under both firms' mandates: the evidence, the disclosed file keys, the mandates' openings, and the outcome | recorded once |

"Recorded once" means the encryption is randomised by design (tlock and age), so running the generator again produces different but equally valid vectors. The recorded ones are what is published.

## The test beacon

Most vectors use a local test beacon whose secret key is in `beacon.json`, so that rounds can be released without waiting for drand. Whoever holds that secret can open anything sealed to it: it is for testing only, and a verifier must never accept it outside tests. Its `chainHash` is `SHA-256("mattering/test-beacon/v1" ‖ 0x00 ‖ public key)`. Two vectors in `envelope.json` and `beacon.json` use the real drand quicknet network instead.

## Regenerating

Only when a format changes:

```bash
npm run vectors                       # all of them
npm run vectors -- auction-v4.json    # only the files named; the rest stay as recorded
```

It needs internet access to fetch the two quicknet rounds from a public drand relay. Commit the new files, and say what changed.

## Status

Proof of concept, not security reviewed. These vectors pin down what this implementation does, not that it is right; the formats are specified in [docs/protocol.md](../docs/protocol.md).
