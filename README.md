# Mattering

> **Proof of concept. Not yet security reviewed. Do not protect anything valuable with this tool.**
> Feel free to run and test. Feedback and suggestions welcome.

Purpose: Seal digital information until a future time, and let anyone check the seal and the opening.

**See it running:** [mattering.ai/demo](https://mattering.ai/demo) runs a sealed-bid auction between three software agents, and a sealed negotiation between two, on this code, against a public clock.

**Try it from your AI assistant:** connect Claude, ChatGPT or any MCP client to `https://mattering.ai/mcp`, and two assistants can negotiate a price in sealed rounds, or one can run a sealed-bid auction for others to bid in ([below](#connect-an-ai-assistant)).

**Build on it:** a platform API and SDK run sealed auctions, negotiations and limit matches from your own systems, with each participant sealing on its own machine ([docs/api.md](docs/api.md)).

Mattering uses existing cryptography. The time lock is [drand](https://drand.love)'s tlock, called through drand's own library. What Mattering adds is a documented envelope format, a witness log with receipts and deadlines, a verifier that recomputes an outcome from published evidence, and a demo that shows all of it working.

## How it was built

Mattering was conceived and directed by Johannes Smith, and implemented in TypeScript with the support of Claude Code.

Three rules shaped it:

1. **No new cryptography.** Established libraries only. Where the project had to compose them itself, the composition is marked for review ([docs/research-questions.md](docs/research-questions.md)).
2. **Every claim has a test, or is marked as not made.** [docs/claims.md](docs/claims.md) lists each (and what it rests on).
3. **Limits are clearly stated**, here and in [docs/claims.md](docs/claims.md). The demo pages say what is staged in each scenario.

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
- **Auction rules**: the highest or the lowest bid wins (the lowest for funding and procurement), an optional public reserve, and bids sealed to the organiser alone, who can disclose them to anyone so they can check the result.
- An **example** in which three software agents bid, go away, and the result is checked by a separate program.

**A witness and registry service**

- An **HTTP service** that keeps the log, enforces deadlines, stores envelopes and publishes the evidence for anyone to check. One log runs for a long time and carries many auctions; each auction's evidence covers only its own stretch of it.
- **Cosigners**: independent parties who countersign the log, dated, before any bid can be read, so the witness cannot rewrite it or move the close afterwards. They speak the same protocol as the public transparency-log witness network (C2SP tlog-witness). The shared log at mattering.ai/log has been accepted onto the Witness Network's testing list, but no public witness has cosigned it yet.
- **Sealed statements**: commit to a prediction or decision before a deadline; it opens for everyone at a set time.
- **Sealed negotiation**: a buyer and a seller, such as two firms' software agents, each seal an offer to the other; the offers open together, and if they cross the deal is at the midpoint. The witness cannot read them; a party can disclose them to an auditor.
- **Agent mandates**: an organisation signs that its agent's key may negotiate up to a limit. The limit is committed, not shown, so the other side cannot learn it and the organisation cannot change it later; shown to an auditor, it proves whether a deal was within the agent's authority.
- A **registry view**: everything one key has committed to, and what each commitment opened to.
- An **MCP server**: AI assistants such as Claude and ChatGPT can open or join a negotiation table and negotiate for one side, round by round, or run a sealed-bid auction and bid in one, by themselves or with the user's approval for each offer. Anyone with a negotiation's watch link can follow and check it ([docs/mcp.md](docs/mcp.md)).

**The platform**

- A **session engine** that runs sealed-bid auctions, negotiations in rounds, and limit matches (one round in which each side seals only its limit), with invitations, a quorum, cancelling, and results checked against the evidence before they are published.
- An **HTTP API** at `/api/v1`, with API keys, idempotent requests, events by stream or signed webhook, and an OpenAPI description ([docs/api.md](docs/api.md)).
- An **SDK**, `@mattering/client`, that makes and keeps each participant's keys, seals on its machine, and checks every result against the evidence, sealing only to a public clock it accepts.
- **Server sealing** for callers that cannot run code, such as assistants in a chat: Mattering then holds the keys, and every response says so.

**For other implementations**

- **Test vectors**: known inputs and outputs for every format, including two real drand rounds and a complete cosigned auction and negotiation, checked against this library on every test run ([test-vectors](test-vectors/README.md)).
- **An npm package**, `@mattering/core`, built and tested but not yet published ([below](#the-npm-package)). The SDK, `@mattering/client`, is not packaged yet.

The service runs the demo at mattering.ai, where each visitor gets a room of their own and every room writes into one shared log. It is still a proof of concept. Not yet built: range proofs, durable storage. [docs/claims.md](docs/claims.md) lists every claim with its status.

## See it

**The Sealed Room** is a web page that runs a sealed-bid auction between three agents and invites you to cheat. It is the quickest way to see what Mattering does. It is live at [mattering.ai/demo/auction](https://mattering.ai/demo/auction), or run it yourself:

```bash
npm install
npm run showcase
```

Then open http://127.0.0.1:8790/demo. Use `npm run showcase:offline` if you have no internet connection. More in [docs/showcase.md](docs/showcase.md).

**The Negotiation Room**, at http://127.0.0.1:8790/demo/negotiation from the same command, shows two firms' agents negotiating early payment of an invoice in sealed steps, each under a mandate with a limit the other side cannot see. With a Claude API key, a language model chooses each agent's offer, held to the same mandate. Your browser checks every step from what the firms disclose to it. More in [docs/negotiation-room.md](docs/negotiation-room.md).

**Two scenarios on the platform**, at [mattering.ai/demo/rental](https://mattering.ai/demo/rental) and [mattering.ai/demo/funding](https://mattering.ai/demo/funding), and at `/demo/rental` and `/demo/funding` from the same command: a London flat to rent, where applicants make sealed offers up to the advertised rent (the legal ceiling in England) and ties at the full rent are drawn by the public clock; and an invoice-funding desk, where funders quote sealed discounts and the lowest wins. Each runs through the platform's API, and your offer is sealed in your browser with the SDK. More in [docs/scenarios.md](docs/scenarios.md).

## Connect an AI assistant

Mattering is also an MCP server. Add a connector with the address `https://mattering.ai/mcp` in Claude, ChatGPT or any assistant that supports MCP connectors; no sign-in is needed. In Claude Code:

```bash
claude mcp add --transport http mattering https://mattering.ai/mcp
```

Then ask one assistant to open a negotiation, for example to sell something, and give the invite code it returns to the other party's assistant. Each assistant asks its user for the settings that are theirs to decide (the item and price range, their own limit, the number and length of rounds, and whether to bid by itself or check each offer with them), then bids round by round. Neither can see the other's offer before making its own, and an offer beyond a user's limit is refused. A watch link shows the negotiation and checks every round in the browser.

An assistant can also run a sealed-bid auction: it invites two to ten bidders' assistants, each seals one bid, and nobody, the organiser included, can read a bid until bidding closes. The highest bid wins, or the lowest where the organiser is buying, as in a funding auction.

It is a demonstration: offers are sealed and recorded for real, but they are not legally binding, no payment is made, and Mattering's server holds every party's keys. `npm run showcase` serves the same endpoint on a laptop at http://127.0.0.1:8790/mcp. More in [docs/mcp.md](docs/mcp.md).

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
| `packages/core` | The SDK, `@mattering/core`: envelopes, recipients, witness log, commitments, auction and negotiation verifiers |
| `packages/client` | The platform SDK, `@mattering/client`: joins, seals locally, retries safely and checks results ([guide](docs/api.md#the-sdk)) |
| `apps/cli` | The `mattering` command |
| `apps/witness` | The witness and registry service, a cosigner, and a client |
| `apps/showcase` | The Sealed Room: a web page for demonstrations |
| `apps/platform` | The platform: the session engine (auctions, negotiations, limit matches), its HTTP API, webhooks and OpenAPI description |
| `apps/cloudflare` | The rooms, the MCP server and the platform API as a Cloudflare Worker, for the website |
| `examples/agent-auction` | Three agents, one auction, and a standalone verifier |
| `examples/hosted-registry` | The same through the hosted service, plus sealed predictions |
| `test-vectors` | Known inputs and outputs for every format, for a second implementation ([README](test-vectors/README.md)) |
| `tests` | 132 tests (one, against live drand, runs only with `npm run test:live`): sealing, sealing to recipients, sealed negotiation, agent mandates, the negotiation demo, tampering, replay, early opening, cheating bidders, a cheating witness, a cheating coordinator, the witness protocol and its formats, the service over HTTP, one log shared by many auctions, the test vectors, and the platform's sessions and API |
| `docs/protocol.md` | The envelope, submission, log, auction and statement formats |
| `docs/service.md` | Running the witness service, its interface, and what it lacks |
| `docs/showcase.md` | The demonstration page: what is real and what is staged |
| `docs/negotiation-room.md` | The negotiation demonstration: what it shows and what is staged |
| `docs/scenarios.md` | The rental listing and funding desk demos: what runs and what is staged |
| `docs/mcp.md` | Mattering as an MCP server: negotiation tables and auctions for AI assistants |
| `docs/api.md` | The platform API, version 1: keys, sessions, bids, results, events and webhooks |
| `docs/api-design.md` | The design of the platform: sessions, mechanisms, SDK and MCP, and the assumptions version 1 is built on |
| `docs/claims.md` | Every claim, what it rests on, and which test shows it |
| `docs/threat-model.md` | Who can attack what, and what is out of scope |
| `docs/research-questions.md` | Questions for a cryptographer |
| `docs/architecture.md` | Components and trust boundaries |

## Tests

`npm test` runs offline. It uses a local test beacon with its own key, so the time lock is exercised for real: a ciphertext made for round 42 does not open with round 41's signature, even when every Mattering check is bypassed.

`npm run test:live` runs one test against the real drand network. It needs internet access to a drand relay and takes about ten seconds.

`tests/vectors.test.ts` checks the published [test vectors](test-vectors/README.md) against the library, so the two cannot drift apart. Two of the vectors are real drand quicknet rounds, checked offline from their recorded signatures.

## The npm package

`@mattering/core` is ready to publish but not yet on npm. `npm run pack:core` compiles it to JavaScript with type declarations in `.npm/core/`, packs it, installs the packed copy into an empty project, and checks that it seals, refuses to open early, opens on time, seals to a recipient, and that its types resolve. Publishing is then `npm publish .npm/core --access public`, from an account that owns the `@mattering` scope. In this repository the workspace uses the TypeScript source directly.

## Dependencies

| Package | Version | Licence | Used for |
| --- | --- | --- | --- |
| [tlock-js](https://github.com/drand/tlock-js) | 0.9.0 | Apache-2.0 or MIT | Time-lock encryption and decryption (drand's implementation) |
| [drand-client](https://github.com/drand/drand-client) | 1.2.5 | Apache-2.0 or MIT | Beacon types; verifies signatures inside tlock-js |
| [@noble/curves](https://github.com/paulmillr/noble-curves) | 1.9.7 | MIT | Beacon signature verification (BLS12-381), Ed25519 signatures, Ristretto255 commitments |
| [@noble/hashes](https://github.com/paulmillr/noble-hashes) | 1.8.0 | MIT | SHA-256, SHA3-512 |
| [canonicalize](https://github.com/erdtman/canonicalize) | 2.1.0 | Apache-2.0 | RFC 8785 canonical JSON |
| [age-encryption](https://github.com/FiloSottile/typage) | 0.3.1 | BSD-3-Clause | Sealing to recipients (age X25519), version 2 envelopes |
| [@anthropic-ai/sdk](https://github.com/anthropics/anthropic-sdk-typescript) | showcase only | MIT | Optional: a language model chooses the demo agents' bids and offers. Not used by the core |
| [esbuild](https://esbuild.github.io) | development only | MIT | Bundling the library for the showcase page |

Versions are pinned exactly. `tlock-js` was last published in July 2025; whether it is maintained actively enough to build on is an open question in [docs/research-questions.md](docs/research-questions.md).

## Licence

[MIT](LICENSE).
