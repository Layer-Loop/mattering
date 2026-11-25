# Mattering

> **Proof of concept. Not yet security reviewed. Do not protect anything valuable with this tool.**
> Feel free to run and test. Feedback and suggestions welcome.

Purpose: Seal digital information until a future time, and let anyone check the seal and the opening.

**See it running:** [mattering.ai/demo](https://mattering.ai/demo) runs a sealed-bid auction between three software agents on this code, against a public clock.

Mattering uses existing cryptography. The time lock is [drand](https://drand.love)'s tlock, called through drand's own library. What Mattering adds is a documented envelope format, a witness log with receipts and deadlines, a verifier that recomputes an outcome from published evidence, and a demo that shows all of it working.

## How it was built

Mattering was conceived and directed by Johannes Smith, and implemented in TypeScript with the support of Claude Code.

Three rules shaped it:

1. **No new cryptography.** Established libraries only. Where the project had to compose them itself, the composition is marked for review ([docs/research-questions.md](docs/research-questions.md)).
2. **Every claim has a test, or is marked as not made.** [docs/claims.md](docs/claims.md) lists each (and what it rests on).
3. **Limits are clearly stated**, including on the demo page.

## Current features

**Sealing**

- **Seal** bytes to a future drand round. This runs locally and needs no service.
- **Verify** a sealed envelope: is it well-formed, and is it locked to a time source and round the verifier accepts?
- **Open** it once the round's signature exists, with only the envelope file and that public signature. The sender does not need to be online and no Mattering service is involved.
- **Verify an opening**: does this envelope open to exactly these bytes?
- **Seal to recipients**: locked to a round and to named age X25519 keys, so once the round comes only they can read it. A recipient can disclose the file key so that others can check what the envelope held.

**Witnessed commitments and a sealed-bid auction**

- A **witness log** of signed submissions, with receipts and checkpoints, that closes on the beacon's clock.
- **Pedersen commitments** to bid amounts.
- A **verifier** that recomputes an auction's outcome from published files, and says which bids were invalid and why.
- An **example** in which three software agents bid, go away, and the result is checked by a separate program.

**A witness and registry service**

- An **HTTP service** that keeps the log, enforces deadlines, stores envelopes and publishes the evidence for anyone to check. One log runs for a long time and carries many auctions; each auction's evidence covers only its own stretch of it.
- **Cosigners**: independent parties who countersign the log, dated, before any bid can be read, so the witness cannot rewrite it or move the close afterwards. They speak the same protocol as the public transparency-log witness network (C2SP tlog-witness), though no public witness has been used yet.
- **Sealed statements**: commit to a prediction or decision before a deadline; it opens for everyone at a set time.
- **Sealed negotiation**: a buyer and a seller, such as two firms' software agents, each seal an offer to the other; the offers open together, and if they cross the deal is at the midpoint. The witness cannot read them; a party can disclose them to an auditor.
- A **registry view**: everything one key has committed to, and what each commitment opened to.

The service runs the demo at mattering.ai, where each visitor gets a room of their own and every room writes into one shared log. It is still a proof of concept. Not yet built: range proofs, durable storage. [docs/claims.md](docs/claims.md) lists every claim with its status.

## See it

**The Sealed Room** is a web page that runs a sealed-bid auction between three agents and invites you to cheat. It is the quickest way to see what Mattering does. It is live at [mattering.ai/demo](https://mattering.ai/demo), or run it yourself:

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

What it gives you, assuming drand behaves as designed:

- Nobody can read the payload before the round, including the recipient and Mattering.
- After the round, anyone holding the envelope can open it. Nobody can stop that by going offline.
- The envelope opens to one payload only, and its round, beacon and context cannot be swapped without the opening failing.

What it does not give you:

- **Secrecy from the sender.** The sender knows the payload and can disclose it whenever they like.
- **Proof of when it was sealed.** An envelope carries no trustworthy creation time. The witness log supplies a deadline, and it is only as trustworthy as the witness and its cosigners.
- **Secrecy after the round, unless you name recipients.** A plain seal opens to everyone. A seal to recipients opens only to them, but a dishonest sender can name a recipient who then cannot open it, and nothing shows that before the round.
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
| `tests` | 82 tests: sealing, sealing to recipients, sealed negotiation, tampering, replay, early opening, cheating bidders, a cheating witness, a cheating coordinator, the witness protocol and its formats, the service over HTTP, and one log shared by many auctions |
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
| [@anthropic-ai/sdk](https://github.com/anthropics/anthropic-sdk-typescript) | showcase only | MIT | Optional: a language model decides the demo agents' bids. Not used by the core |
| [esbuild](https://esbuild.github.io) | development only | MIT | Bundling the library for the showcase page |

Versions are pinned exactly. `tlock-js` was last published in July 2025; whether it is maintained actively enough to build on is an open question in [docs/research-questions.md](docs/research-questions.md).

## Licence

[MIT](LICENSE).
