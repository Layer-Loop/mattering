# Architecture

## Components

```text
                 public parameters only
 ┌──────────┐   (key, chain hash, schedule)   ┌─────────────────┐
 │  Sealer  │ ◄────────────────────────────── │  drand quicknet │
 └────┬─────┘                                 └────────┬────────┘
      │ envelope.json                                  │ signature for the round,
      │ (a file; any transport or storage)             │ public, from any relay
      ▼                                                ▼
 ┌──────────────────────────────────────────────────────────────┐
 │  Verifier / opener: checks the envelope against its own      │
 │  beacon policy, verifies the signature, opens                │
 └──────────────────────────────────────────────────────────────┘
```

The sealer and the opener share nothing but the envelope file. Neither talks to a Mattering service, because sealing and opening need none.

In the auction, a **witness** sits between bidders and verifier. Bidders hand it signed submissions and get receipts. It publishes the log and a closing checkpoint. It never holds a key that opens anything.

## Code

| Module (`packages/core/src`) | Role | Network |
| --- | --- | --- |
| `canonical.ts` | Canonical JSON, labelled hashing | No |
| `beacon.ts` | Beacon parameters, round arithmetic, signature verification | No |
| `envelope.ts` | Envelope format, strict parsing, armor, frame | No |
| `tlock.ts` | The only caller of `tlock-js` | No |
| `seal.ts` | `seal`, `verifyEnvelope`, `open`, `verifyOpen` | No |
| `recipients.ts` | The only caller of the age library (`age-encryption`) | No |
| `recipient-seal.ts` | Version 2 envelopes: `sealTo`, `unlock`, `openAs`, file-key disclosure. Exported as `@mattering/core/recipients`, so code that does not need it does not carry age | No |
| `signing.ts` | Ed25519 over labelled canonical hashes | No |
| `commitment.ts` | Pedersen commitments on Ristretto255 | No |
| `merkle.ts` | RFC 6962 tree hash, inclusion and consistency proofs, an incremental tree, and roots rebuilt from a compact prefix | No |
| `witness.ts` | Submission, receipt and checkpoint formats and checks; an in-memory witness | No |
| `evidence.ts` | Policy terms, counting witness cosignatures, shared evidence checks | No |
| `note.ts` | C2SP signed notes, checkpoints and Ed25519 cosignatures, as public witnesses use them | No |
| `cosigner.ts` | A transparency-log witness speaking C2SP tlog-witness | No |
| `auction.ts` | Policy, bid preparation, auction verifier | No |
| `statement.ts` | Sealed statements and their verifier | No |
| `negotiation-policy.ts` | Negotiation steps: the policy and the checks a witness makes on sealed offers. No recipient encryption needed | No |
| `mandate.ts` | Agent mandates: issuing, checking, and testing an offer against a committed limit | No |
| `negotiation.ts` | Making offers, judging steps and chains, disclosing to an auditor. Exported as `@mattering/core/negotiation` | No |
| `source.ts` | The interface for a party's own view of the beacon | No |
| `drand-http.ts` | Optional: fetch a round's signature from a relay | Yes |
| `testing.ts` | A local beacon for tests. Never accepted by default | No |

`apps/cli` uses only what `packages/core` exports.

## Trust boundaries

| Boundary | What crosses it | How it is checked |
| --- | --- | --- |
| Envelope file → verifier | Untrusted JSON | Strict parse; beacon matched against the verifier's own list |
| Bidder → witness | A signed submission | Signature checked; the witness cannot read the bid |
| Witness → verifier | The policy's stretch of the log, the prefix before it, and the closing checkpoint | Root rebuilt from the prefix and the entries; checkpoint signature and cited beacon round checked |
| Relay → opener | A claimed signature | Verified against the beacon key before use, and again inside `tlock-js` |
| Sealer → drand | Nothing. Sealing uses constants compiled into the package | The constants are drand's published quicknet parameters |

## The service

`apps/witness` wraps the core's witness in an HTTP service with file storage, adds a cosigner service, and a client. One service runs one long-lived log shared by many policies, holding only leaf hashes and live policies in memory. Cosigners are reached with the C2SP tlog-witness protocol, so a public witness can take the place of the one here. Each cosigner keeps its own clock. See [service.md](service.md).

The showcase (`apps/showcase`) runs its rooms on one such log through a small log host (`log-host.ts`): in the same process on a laptop, and on Cloudflare in one Durable Object that every room reaches. See [showcase.md](showcase.md).

```text
 bidders ── signed submission + envelope ──► witness service ──► receipt
                                                  │  at the close round
                                                  ├── close entry + closing checkpoint
                                                  ├── log checkpoint + consistency proof ──► cosigner(s) ──► dated cosignature
                                                  ▼
 verifiers ◄── evidence: policy, log, closing, witnessed checkpoint, envelopes, release
```

## Planned

| Component | Owned and run by |
| --- | --- |
| A deployed public witness and registry | Mattering. The demonstration's shared log is the first step; it has been accepted onto the Witness Network's testing list, but no public witness cosigns it yet |
| Cosigners | Parties independent of Mattering |
| Anchoring checkpoints to a public ledger | Mattering's witness |
| Range proofs, durable storage | Undecided; only if review supports them |
