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

The sealer and the opener share nothing but the envelope file. Neither talks to a Mattering service, because there is none in Phase 1.

## Code

| Module (`packages/core/src`) | Role | Network |
| --- | --- | --- |
| `canonical.ts` | Canonical JSON, labelled hashing | No |
| `beacon.ts` | Beacon parameters, round arithmetic, signature verification | No |
| `envelope.ts` | Envelope format, strict parsing, armor, frame | No |
| `tlock.ts` | The only caller of `tlock-js` | No |
| `seal.ts` | `seal`, `verifyEnvelope`, `open`, `verifyOpen` | No |
| `drand-http.ts` | Optional: fetch a round's signature from a relay | Yes |
| `testing.ts` | A local beacon for tests. Never accepted by default | No |

`apps/cli` uses only what `packages/core` exports.

## Trust boundaries

| Boundary | What crosses it | How it is checked |
| --- | --- | --- |
| Envelope file → verifier | Untrusted JSON | Strict parse; beacon matched against the verifier's own list |
| Relay → opener | A claimed signature | Verified against the beacon key before use, and again inside `tlock-js` |
| Sealer → drand | Nothing. Sealing uses constants compiled into the package | The constants are drand's published quicknet parameters |

## Planned

| Component | Phase | Owned and run by |
| --- | --- | --- |
| Witness log, receipts, checkpoints | 2 | Anyone; Mattering runs the default public instance |
| Commitments, auction policy, auction verifier | 2 | Library code |
| Three-agent auction example | 3 | Example code |
| Commitment registry | Later | Mattering |
| Range proofs, recipient encryption, durable storage | Later, if review supports them | Undecided |
