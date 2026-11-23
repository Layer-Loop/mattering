# The witness and registry service

A small HTTP service that keeps the witness log, enforces deadlines on the beacon's clock, collects cosignatures, stores envelopes, and publishes everything a verifier needs. The registry is the same service read as a public record.

**Status: experimental and unreviewed.** It is tested on localhost against a simulated beacon. Its first run against live drand found a deadline bug, since fixed. Its only deployment is the demonstration at mattering.ai, where each visitor gets a throwaway instance; it has not been run as a shared, long-lived service.

## Running it

```bash
npm run witness
```

```bash
npm run cosigner
```

| Variable | Meaning | Default |
| --- | --- | --- |
| `MATTERING_DATA` | Directory for state and the signing key | `./witness-data` or `./cosigner-data` |
| `PORT` | Port to listen on | 8787 (witness), 8788 (cosigner) |
| `MATTERING_RELAYS` | Comma-separated drand relay URLs | drand's public relays |
| `MATTERING_COSIGNERS` | Witness only: comma-separated `publicKey=url` pairs | none |

Both use drand quicknet. A cosigner is only worth anything if someone other than the witness's operator runs it.

To see the whole thing work, including an auction and a round of sealed predictions:

```bash
npm run example:hosted
```

That runs against the real drand network and takes about 45 seconds. Add `-- offline` to run instantly against a simulated beacon.

## Interface

Everything is JSON. Everything served is public, so there is no authentication; a submission authenticates itself by its signature.

| Request | Does |
| --- | --- |
| `GET /` | The witness's public key, its beacon, and the log size |
| `POST /policies` | Register a policy (an auction or a statement policy). Returns its hash |
| `GET /policies` | List registered policies |
| `GET /policies/<hash>/evidence` | Everything a verifier needs for that policy, as far as it exists: policy, log, closing checkpoint, cosignatures, envelopes, and the release signature once emitted |
| `GET /policies/<hash>/result` | The outcome as the service computes it. A convenience; recompute it from the evidence |
| `POST /submissions` | Body `{ submission, envelope }`. Returns a receipt, or refuses |
| `GET /log?from=<n>` | Log entries from index `n` |
| `GET /checkpoint` | A signed checkpoint of the log as it is now |
| `GET /envelopes/<id>` | One stored envelope |
| `GET /submitters/<key>` | The registry view: every commitment by that key and, once released, what it opened to |

Errors come back as `{ error, code }` with status 400 (malformed), 404 (not found), 409 (refused by policy, including late submissions) or 503 (the beacon cannot be reached).

A cosigner has one route, `POST /cosign` with `{ policyHash, policy, closing }`.

## What the service checks before giving a receipt

- The policy is registered, names this witness, and uses this witness's beacon.
- The submission is well-formed and signed.
- The envelope is the one the submission names, is locked to the policy's release round on the policy's beacon, and carries the expected context.
- The policy's close round has not been emitted as far as the service has seen, and is not yet due by the service's own clock and the beacon's schedule.

It does not and cannot check what is inside the envelope.

## State

The service keeps its state through a small storage interface (`ServiceStore`), so the same code runs on a laptop and in a hosted runtime. Three stores exist:

| Store | Where | Used by |
| --- | --- | --- |
| Files | A directory of plain files, below | `npm run witness` |
| Memory | Nothing kept after the process ends | Tests and the laptop showcase |
| Durable Object storage | Cloudflare | The hosted demonstration ([showcase.md](showcase.md)) |

The file store, under `MATTERING_DATA`:

| File | Contents |
| --- | --- |
| `witness-key.json` | The signing key. Created on first run, readable only by its owner |
| `log.jsonl` | One submission per line, append-only |
| `policies/<hash>.json` | Registered policies |
| `envelopes/<id>.json` | Sealed envelopes |
| `closings/<hash>.json` | Closing checkpoint and cosignatures per policy |

A restart reloads all of it. A submission is written to the store before its receipt is returned. A cosigner keeps `cosigner-key.json` and `cosigned.jsonl`; the second file is what stops it signing two different closings for one policy across restarts.

## Before this could be a real service

None of this is done:

- **Key protection.** The signing key is a file on disk. Whoever reads it can forge receipts and checkpoints.
- **Abuse limits.** Anyone can register policies and submit entries without limit. Requests are capped at 256 KB and nothing else.
- **Durability.** One directory on one machine, with no backup or replication. Losing the envelopes makes their bids unresolvable.
- **Scale.** The log is held in memory and the Merkle root is recomputed in full on every submission.
- **Transport.** Plain HTTP. Put it behind TLS.
- **Operations.** No monitoring, no key rotation, no plan for what a compromised key means for past receipts.
- **Independent cosigners.** The design needs cosigners run by other parties. None exist.
