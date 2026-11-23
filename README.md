# Mattering

Seal digital information until a future time, and let anyone check the seal and the opening for themselves.

**Status: experimental proof of concept. It has not had a security review. Do not protect anything valuable with it.** It exists to be read, run and criticised.

Mattering does not invent cryptography. The time lock is [drand](https://drand.love)'s tlock, called through drand's own library. What Mattering adds is a documented envelope format, the checks around it, and (planned) a witness log, a commitment registry and an auction between software agents that shows it working.

## What works today

**Sealing**

- **Seal** bytes to a future drand round. This runs locally and needs no service.
- **Verify** a sealed envelope: is it well-formed, and is it locked to a time source and round the verifier accepts?
- **Open** it once the round's signature exists, with only the envelope file and that public signature. The sender does not need to be online and no Mattering service is involved.
- **Verify an opening**: does this envelope open to exactly these bytes?

**Witnessed commitments and a sealed-bid auction**

- A **witness log** of signed submissions, with receipts and checkpoints, that closes on the beacon's clock.
- **Pedersen commitments** to bid amounts.
- A **verifier** that recomputes an auction's outcome from published files, and says which bids were invalid and why.
- An **example** in which three software agents bid, go away, and the result is checked by a separate program.

**A witness and registry service**

- An **HTTP service** that keeps the log, enforces deadlines, stores envelopes and publishes the evidence for anyone to check.
- **Cosigners**: independent parties who countersign an auction's close before any bid can be read, so the witness cannot rewrite the log afterwards.
- **Sealed statements**: commit to a prediction or decision before a deadline; it opens for everyone at a set time.
- A **registry view**: everything one key has committed to, and what each commitment opened to.

The service runs on localhost and has never been deployed; [docs/service.md](docs/service.md) lists what stands between it and a real one. Not built: range proofs, recipient encryption, durable storage. [docs/claims.md](docs/claims.md) lists every claim with its status, and is the document to check before saying anything about what Mattering guarantees.

## See it

**The Sealed Room** is a web page that runs a sealed-bid auction between three agents and invites you to cheat. It is the quickest way to see what this does.

```bash
npm install
npm run showcase
```

Then open http://127.0.0.1:8790. Use `npm run showcase:offline` if you have no internet connection. More in [docs/showcase.md](docs/showcase.md).

## Try it

Needs Node.js 22 or later.

```bash
npm install
npm test
```

Seal a file for one minute on the real drand network, then open it:

```bash
echo "hello, later" > note.txt
npm run mattering -- seal --payload note.txt --out note.envelope.json --after 60
npm run mattering -- verify note.envelope.json
npm run mattering -- open note.envelope.json --out -    # fails until the minute has passed
```

`npm run mattering -- --help` lists every command.

Run the three-agent auction, then re-check its result from the files it wrote:

```bash
npm run example
npm run example:verify
```

Run the witness service with a cosigner, an auction and a round of sealed predictions, over HTTP against the real drand network (about 45 seconds):

```bash
npm run example:hosted
```

The first example runs offline against a local test beacon. Its agents are plain functions; an agent driven by a language model would plug in at the same point and would have no more say in the checks than these do.

From code:

```ts
import { seal, open, verifyEnvelope, firstRoundAtOrAfter, QUICKNET } from "@mattering/core";
import { fetchRelease } from "@mattering/core/drand-http";

const round = firstRoundAtOrAfter(QUICKNET, Date.now() / 1000 + 60);
const envelope = await seal({ payload, round, context: { purpose: "demo" } });

verifyEnvelope(envelope).ok;                         // while still sealed
const release = await fetchRelease(QUICKNET, round); // after the round
const opened = await open(envelope, release);
```

## What a seal does and does not give you

It gives you, assuming drand behaves as designed:

- Nobody can read the payload before the round, including the recipient and Mattering.
- After the round, anyone holding the envelope can open it. Nobody can stop that by going offline.
- The envelope opens to one payload only, and its round, beacon and context cannot be swapped without the opening failing.

It does not give you:

- **Secrecy from the sender.** The sender knows the payload and can disclose it whenever they like.
- **Proof of when it was sealed.** An envelope carries no trustworthy creation time. The witness log supplies a deadline, and it is only as trustworthy as the witness and its cosigners.
- **Secrecy after the round.** Opening is public. There is no private recipient in this version.
- **Protection if drand fails.** If a threshold of drand's operators collude, seals open early. If the network stops, they do not open. If the envelope file is lost, it is gone.
- **Long-term or post-quantum secrecy.** The time lock rests on pairing-based cryptography that a large quantum computer would break. Someone who stores an envelope today could open it then.

The full list is in [docs/threat-model.md](docs/threat-model.md).

## Layout

| Path | Contents |
| --- | --- |
| `packages/core` | The SDK: envelopes, witness log, commitments, auction verifier |
| `apps/cli` | The `mattering` command |
| `apps/witness` | The witness and registry service, a cosigner, and a client |
| `apps/showcase` | The Sealed Room: a web page for demonstrations |
| `apps/cloudflare` | The same room as a Cloudflare Worker, for the website |
| `examples/agent-auction` | Three agents, one auction, and a standalone verifier |
| `examples/hosted-registry` | The same through the hosted service, plus sealed predictions |
| `tests` | 52 tests: sealing, tampering, replay, early opening, cheating bidders, a cheating witness, a cheating coordinator, and the service over HTTP |
| `docs/protocol.md` | The envelope, submission, log, auction and statement formats |
| `docs/service.md` | Running the witness service, its interface, and what it lacks |
| `docs/showcase.md` | The demonstration page: what is real and what is staged |
| `docs/claims.md` | Every claim, what it rests on, and which test shows it |
| `docs/threat-model.md` | Who can attack what, and what is out of scope |
| `docs/research-questions.md` | Questions for a cryptographer |
| `docs/architecture.md` | Components and trust boundaries |

## Tests

`npm test` runs offline. It uses a local test beacon with its own key, so the time lock is exercised for real: a ciphertext made for round 42 does not open with round 41's signature, even when every Mattering check is bypassed.

`npm run test:live` runs one test against the real drand network. It needs internet access to a drand relay and takes about ten seconds.

## Dependencies

| Package | Version | Licence | Used for |
| --- | --- | --- | --- |
| [tlock-js](https://github.com/drand/tlock-js) | 0.9.0 | Apache-2.0 or MIT | Time-lock encryption and decryption (drand's implementation) |
| [drand-client](https://github.com/drand/drand-client) | 1.2.5 | Apache-2.0 or MIT | Beacon types; verifies signatures inside tlock-js |
| [@noble/curves](https://github.com/paulmillr/noble-curves) | 1.9.7 | MIT | Beacon signature verification (BLS12-381), Ed25519 signatures, Ristretto255 commitments |
| [@noble/hashes](https://github.com/paulmillr/noble-hashes) | 1.8.0 | MIT | SHA-256, SHA3-512 |
| [canonicalize](https://github.com/erdtman/canonicalize) | 2.1.0 | Apache-2.0 | RFC 8785 canonical JSON |
| [esbuild](https://esbuild.github.io) | development only | MIT | Bundling the library for the showcase page |

Versions are pinned exactly. `tlock-js` was last published in July 2025; whether it is maintained actively enough to build on is an open question in [docs/research-questions.md](docs/research-questions.md).

## Licence

[MIT](LICENSE).
