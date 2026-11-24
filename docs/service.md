# The witness and registry service

A small HTTP service that keeps the witness log, enforces deadlines on the beacon's clock, collects cosignatures from transparency-log witnesses, stores envelopes, and publishes everything a verifier needs. The registry is the same service read as a public record.

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
| `MATTERING_ORIGIN` | Witness only: the log's origin, such as `example.com/log`. Fix it before the first policy | derived from the witness's key |
| `MATTERING_COSIGNERS` | Witness only: comma-separated `vkey=url` pairs, the URL being the cosigner's add-checkpoint prefix | none |
| `MATTERING_NAME` | Cosigner only: its name in signature lines | `localhost/mattering-cosigner` |
| `MATTERING_LOGS` | Cosigner only: comma-separated verifier keys of the logs it cosigns for | none |

Both use drand quicknet. Each prints its verifier key at start: the witness prints its log's key, which a cosigner needs in `MATTERING_LOGS`, and the cosigner prints its own, which a policy names. A cosigner is only worth anything if someone other than the witness's operator runs it.

The witness talks to cosigners with the C2SP tlog-witness protocol, so a cosigner can be the one in this repository or any witness that speaks that protocol, including those on the public witness network. A public witness has to be configured with the log's origin and key first; on that network a maintainer approves each log. That has not been tried. ML-DSA-44 cosignatures, which the protocol recommends, are not supported yet.

To see the whole thing work, including an auction and a round of sealed predictions:

```bash
npm run example:hosted
```

That runs against the real drand network and takes about 45 seconds. Add `-- offline` to run instantly against a simulated beacon.

## Interface

Everything is JSON. Everything served is public, so there is no authentication; a submission authenticates itself by its signature.

| Request | Does |
| --- | --- |
| `GET /` | The witness's public key, the log's origin and verifier key, its beacon, and the log size |
| `POST /policies` | Register a policy (an auction or a statement policy). Returns its hash |
| `GET /policies` | List registered policies |
| `GET /policies/<hash>/evidence` | Everything a verifier needs for that policy, as far as it exists: policy, log, closing checkpoint, the witnessed checkpoint with its cosignatures, envelopes, and the release signature once emitted |
| `GET /policies/<hash>/result` | The outcome as the service computes it. A convenience; recompute it from the evidence |
| `POST /submissions` | Body `{ submission, envelope }`. Returns a receipt, or refuses |
| `GET /log?from=<n>` | Log entries from index `n`: submissions and close entries |
| `GET /checkpoint` | A signed checkpoint of the log as it is now |
| `GET /envelopes/<id>` | One stored envelope |
| `GET /submitters/<key>` | The registry view: every commitment by that key and, once released, what it opened to |

Errors come back as `{ error, code }` with status 400 (malformed), 404 (not found), 409 (refused by policy, including late submissions) or 503 (the beacon cannot be reached).

A cosigner speaks plain text, as [C2SP tlog-witness](https://c2sp.org/tlog-witness) specifies: `POST /add-checkpoint` with the old size, a consistency proof and a signed checkpoint, answered with a cosignature line, or 400, 403, 404, 409 (with the latest cosigned size) or 422. `GET /` gives its verifier key.

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
| `log.jsonl` | One entry per line (a submission or a close entry), append-only |
| `policies/<hash>.json` | Registered policies |
| `envelopes/<id>.json` | Sealed envelopes |
| `closings/<hash>.json` | Closing checkpoint and witnessed checkpoint per policy |

A restart reloads all of it. A submission is written to the store before its receipt is returned. A cosigner keeps `cosigner-key.json` and `cosigned.json`, the latest checkpoint it has cosigned for each log; the second file is what stops it cosigning a fork after a restart.

## Before this could be a real service

None of this is done:

- **Key protection.** The signing key is a file on disk. Whoever reads it can forge receipts and checkpoints.
- **Abuse limits.** Anyone can register policies and submit entries without limit. Requests are capped at 256 KB and nothing else.
- **Durability.** One directory on one machine, with no backup or replication. Losing the envelopes makes their bids unresolvable.
- **Scale.** The log is held in memory and the Merkle root is recomputed in full on every submission.
- **Transport.** Plain HTTP. Put it behind TLS.
- **Operations.** No monitoring, no key rotation, no plan for what a compromised key means for past receipts.
- **Independent cosigners.** The design needs cosigners run by other parties. The formats now allow witnesses on the public witness network to be those parties, but no log has been registered with that network, and no cosigner run by anyone else exists yet.
