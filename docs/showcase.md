# The Sealed Room

A web page for showing Mattering to people who do not read code. Three software agents, each acting for a company, bid for an advertising package, the visitor can bid too, every bid opens at once when the clock runs out, and the visitor is invited to cheat.

**Status:** runs on a laptop, and is live at [mattering.ai/demo/auction](https://mattering.ai/demo/auction). It is a demonstration, and the service behind it is not hardened ([service.md](service.md)).

## Running it

Against the real drand network (needs internet):

```bash
npm run showcase
```

Against a simulated clock, for a room with no connection:

```bash
npm run showcase:offline
```

Then open http://127.0.0.1:8790/demo, the way into both demonstrations, or go straight to http://127.0.0.1:8790/demo/auction. Set `PORT` to change the port. An auction takes about 45 seconds: 30 until bidding closes, then 15 until the bids open.

## What happens on the page

1. **Start the auction.** Three agents decide what to bid and seal their bids, one after another. Each also seals a sentence explaining its bid.
2. **Place your own bid.** It is sealed in the browser before it is sent, so the server never sees the amount.
3. **Bidding closes.** The auctioneer signs the list of bids and a cosigner countersigns it, while nobody can read it.
4. **The bids open.** The key is published and every envelope opens at the same moment. The browser works out the winner itself.
5. **Check it yourself.** The checks run in the browser as soon as the result is in, and can download the evidence and check it again offline with the command line (`mattering check-demo evidence.json`, which accepts only drand quicknet unless told otherwise with `--allow-beacon`).

## The pages

Both demonstrations share one page design (`apps/showcase/web/rooms/`, with the HTML in `apps/showcase/src/pages.ts`), in plain TypeScript and CSS without a framework. `/demo` is the way in; `/demo/auction` and `/demo/negotiation` are the rooms. Above each room, two lines stay in view throughout: what the room shows, and how it works (bids sealed until a public clock opens them all at once). Below them, the room is one card that shows one screen at a time:

1. **The intro:** the scenario in a sentence or two, and Start.
2. **The conversation,** while it runs. Each agent's bid (or offer) appears as a sealed bubble the moment it is sealed, and all of them flip open together when the clock releases the key. A thin bar and a countdown sit above. The visitor's own bid is typed into the composer at the bottom, and "Try to peek" is offered while anything is sealed; its answer appears in the thread.
3. **The result:** the outcome in one line, a ranking or the disclosed limits, and "Checked in your browser", which runs the checks by itself and opens to show them, with the evidence to download. The conversation and the other cheats fold away underneath.

The design deliberately leaves out what a visitor does not need to follow the room: beacon round numbers, the log's entries, key fingerprints and commitments appear only inside the checks, the evidence and these documents. The pages carry no list of caveats: the general limits are on the home page and in these documents, and the header says the code has had no security review. Facts particular to the demonstration are said on the intro screen: the companies are invented, and we run the log and, until independent witnesses join, its cosigner.

## The cheat buttons

Each makes a real attempt against the running system.

| Button | What it does | What stops it |
| --- | --- | --- |
| Peek at a bid early | Takes a sealed bid and tries to open it with the newest key that exists | The key for that envelope has not been created yet |
| Slip in a late bid | Seals the maximum bid and submits it after the close | The auctioneer refuses it; bidding closed at the agreed time |
| Rewrite the list as the auctioneer | After the bids are readable, the server slips a winning bid in before the close and signs a new closing list with the auctioneer's real key | The browser rejects it: the cosigners countersigned the original list before the bids could be read, and the new list does not extend it. The rewrite is never shown to a cosigner, because the log's key must never sign two versions of the log: the public witnesses would treat that as proof the log is dishonest, and they would be right. The refusal a cosigner gives to a rewritten log is covered by the tests instead |
| Announce a different winner | Declares that the lowest bidder won | The browser recomputes the result from the evidence and shows the difference |

## What is real and what is staged

**Real:** the sealing, the time lock, the witness log, the receipts, the cosignature, the deadline, and the verification. The browser runs the same library as the tests, and takes evidence from the server but never a verdict. In online mode the browser accepts only the drand network's key, which is compiled into the page.

**Staged:**

- The companies and the lot are invented. The bidders are shown as Company A, B and C; the model is given a fuller description of each (a coffee-shop chain, a phone network, an online travel agent) to bid from.
- Each agent is given a private ceiling, drawn at random for each auction, and decides what to bid. A language model decides if one is configured (next section); otherwise a short script does. The page says which, agent by agent.
- Until public witnesses cosign the log, the cosigner is run by the same operator as the auctioneer. The page's scenario says so, and never calls it independent.
- In offline mode the clock is simulated by the machine running the demo, which could therefore open bids early. The page shows a "Simulated clock · offline" badge and names the simulated clock wherever it would otherwise name drand.

## The agents and the language model

Each agent acts for one company: a description, and a ceiling on what it will pay that is drawn afresh for every auction. With a Claude API key configured, each agent's bid and its one-line rationale come from a language model, which is told the auction's rules, the lot and that agent's private ceiling. Without a key, a script bids a fraction of the ceiling.

```bash
ANTHROPIC_API_KEY=... npm run showcase
```

`MATTERING_MODEL` chooses the model; the default is `claude-haiku-5-5`, the smallest and cheapest current Claude model, which is enough for choosing a bid. Three requests are made per auction, one per agent, at low effort.

What the model can and cannot do:

- **It supplies two things:** a whole number of pounds and a short piece of text. Both are treated as untrusted input. An amount outside the auction's range, or anything that is not a number and a sentence, is thrown away and the script decides for that agent.
- **It has no part in any check.** Sealing, the deadline, the log, the cosignature and the verification never call a model. A model that bid foolishly would lose the auction; it could not break it.
- **If it is slow, fails or declines**, the script decides for that agent, and that agent's bubble says "chosen by a script".
- **Its decisions are held in memory only** until they are sealed, and are not stored.

The request to the model is covered by a test against a stand-in for the API (`tests/showcase.test.ts`). It was run by hand against the real API on 2026-11-24, with `claude-opus-5-5` and then with the current default, and worked. Nothing checks the real API automatically.

## On the website

The same room runs on Cloudflare for mattering.ai, as a Durable Object behind the site's Worker (`apps/cloudflare`). The website is a separate repository and commits the files built from this one:

```bash
npm run build:site -- ../mattering
```

That writes the Worker to `src/worker.js`, the three pages to `public/demo.html` and `public/demo/{auction,negotiation}.html`, and their script and styles to `public/assets/rooms.<hash>.js` and `.css`, named by their content so that browsers never keep an old copy. Files from earlier builds are removed. Rebuild and commit there whenever this repository changes. The old address `/negotiate` is redirected by the site's `_redirects`.

How the hosted version differs from the laptop one:

- **One room per visitor, one log for everyone.** Each browser session gets its own room, with its own agents and auction, and visitors cannot affect each other's auctions. Every room writes into the same long-lived log, held by one Durable Object named `log`, which is never deleted. Each auction's evidence covers only its own stretch of that log ([protocol.md](protocol.md), section 6).
- **The log is public and read-only** at `/log/`: its origin and verifier key at `/log/`, entries at `/log/log?from=<n>`, any auction's evidence at `/log/policies/<hash>/evidence`. The site's `wrangler.jsonc` must send `/log` and `/log/*` to the Worker (`run_worker_first`) for this to be reachable.
- **Nothing happens until the visitor starts an auction**, so loading the page costs nothing.
- **Limits.** A room runs at most 20 auctions, takes at most 12 submissions per auction and only for its own auction, refuses policies from outside, and deletes itself 30 minutes after it was last used.
- **The model has a daily allowance.** If the Worker has an `ANTHROPIC_API_KEY` secret, at most `MODEL_AUCTIONS_PER_DAY` auctions a day (default 300), across all visitors, use the model. After that, and if the counter cannot be reached, the scripts decide. This caps spending whatever the traffic. A spend limit on the API key itself is still worth setting.
- **The clock is always the real drand network.** A simulated clock is available for local development only (`npm run dev:offline` in the site repository).

The log is configured by the Worker's settings:

| Setting | Meaning | Default |
| --- | --- | --- |
| `MATTERING_ORIGIN` | The log's origin, such as `mattering.ai/log`. Public witnesses know the log by it: set it before the first auction and never change it | one derived from the key, under `mattering.invalid` |
| `MATTERING_LOG_KEY` | A secret: the log's Ed25519 secret key, 64 hex characters. Kept as a secret so that it can be backed up and outlives the log's storage | made by the log on first use and kept in its storage |
| `MATTERING_WITNESSES` | Public witnesses: comma-separated `vkey=url` pairs, the URL being the witness's add-checkpoint prefix | none |
| `MATTERING_OWN_COSIGNER` | `1` runs a cosigner beside the log, `0` does not | on only when no public witnesses are set |

Every new auction names all of the log's cosigners and requires a majority of them. Until public witnesses are set, the only cosigner is the one beside the log, which is not independent, and the page says so.

## Not covered by automated tests

`tests/showcase.test.ts` runs an auction through the room and verifies it as the page does, then checks the evidence the page would download with `mattering check-demo`; `tests/shared-log.test.ts` covers the shared log: auctions interleaved on it, restarts, released auctions leaving memory, cosigners asked once per checkpoint, and at most once every 3 seconds each. The page itself was checked by driving it in a headless browser by hand; there is no browser test in the suite. On a laptop, online mode against live drand was run by hand on 2026-11-23 and behaved as described. It was run again on 2026-11-24 after cosigners moved to the C2SP witness protocol: a visitor's bid, all four cheats refused or exposed, and every check passing in the browser. That run found the "Simulated clock" badge showing in live mode, a styling bug, now fixed. The Cloudflare version has not been run since that change.

The Cloudflare version was run by hand in Cloudflare's local runtime with the simulated clock: a full auction in the real site page, with all four cheats refused. It was deployed to mattering.ai on 2026-11-23 and run there by hand against live drand, and worked. On 2026-11-24, after rooms moved to one shared log, it was run again in the local runtime with the simulated clock: two rooms' auctions interleaved on the log, both verified from `/log/` (the second with a prefix standing for the first's entries), a visitor's bid in the real site page, all four cheats refused or exposed, every check passing in the browser, and both auctions retired from memory after release. That version has not been deployed or run against live drand. Nothing checks the deployed version automatically.

The first redesign was driven by hand in a browser on 2026-11-26: on a laptop with the simulated clock (a visitor's bid, all four cheats, all five checks passing, the phone layout at 375 pixels wide), on a laptop against live drand (cosignature time read from the evidence, all five checks passing), and in Cloudflare's local runtime with the simulated clock (the way in, the `/negotiate` redirect, a visitor's room created only on Start, all five checks passing). They have not yet been deployed.

The conversation version of the pages was driven by hand on 2026-11-26 on a laptop with the simulated clock: both rooms through to the result, a visitor's bid, every cheat, the checks passing (and failing on the limit in a rogue negotiation), and the phone layout at 375 pixels wide.
