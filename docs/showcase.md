# The Sealed Room

A web page for showing Mattering to people who do not read code. Three software agents bid for an advertising slot, the visitor can bid too, every bid opens at once when the clock runs out, and the visitor is invited to cheat.

![The Sealed Room after the bids have opened](showcase.png)

**Status:** runs on a laptop. It has not been deployed. It is a demonstration, and the service behind it is not hardened ([service.md](service.md)).

## Running it

Against the real drand network (needs internet):

```bash
npm run showcase
```

Against a simulated clock, for a room with no connection:

```bash
npm run showcase:offline
```

Then open http://127.0.0.1:8790. Set `PORT` to change the port. An auction takes about 45 seconds: 30 until bidding closes, then 15 until the bids open.

## What happens on the page

1. **Start the auction.** Three agents decide what to bid and seal their bids, one after another. Each also seals a sentence explaining its bid.
2. **Place your own bid.** It is sealed in the browser before it is sent, so the server never sees the amount.
3. **Bidding closes.** The auctioneer signs the list of bids and an independent cosigner countersigns it, while nobody can read it.
4. **The bids open.** The key is published and every envelope opens at the same moment. The browser works out the winner itself.

## The cheat buttons

Each makes a real attempt against the running system.

| Button | What it does | What stops it |
| --- | --- | --- |
| Peek at a bid early | Takes a sealed bid and tries to open it with the newest key that exists | The key for that envelope has not been created yet |
| Slip in a late bid | Seals the maximum bid and submits it after the close | The auctioneer refuses it; bidding closed at the agreed time |
| Rewrite the list as the auctioneer | After the bids are readable, the server adds a winning bid and signs a new list with the auctioneer's real key | The browser rejects it: the cosigner signed the original list first and will not sign another |
| Announce a different winner | Declares that the lowest bidder won | The browser recomputes the result from the evidence and shows the difference |

## What is real and what is staged

**Real:** the sealing, the time lock, the witness log, the receipts, the cosignature, the deadline, and the verification. The browser runs the same library as the tests, and takes evidence from the server but never a verdict. In online mode the browser accepts only the drand network's key, which is compiled into the page.

**Staged:**

- The agents are scripted. Each picks an amount within a range, with some randomness. A language-model agent would plug in at the same point (`apps/showcase/src/agents.ts`).
- The advertisers, the publication and the slot are invented.
- The auctioneer and the "independent" cosigner run in the same process on the same machine. The page says so.
- In offline mode the clock is simulated by the machine running the demo, which could therefore open bids early. The page shows a "Simulated clock" badge and says so.

## On the website

The same room runs on Cloudflare for mattering.ai, as a Durable Object behind the site's Worker (`apps/cloudflare`). The website is a separate repository and commits two files built from this one:

```bash
npm run build:site -- ../mattering-web
```

That writes the Worker to `src/worker.js` and the page's script to `public/assets/sealed-room.js` in the site repository. Rebuild and commit there whenever this repository changes.

How the hosted version differs from the laptop one:

- **One room per visitor.** Each browser session gets its own room: its own auctioneer key, cosigner key, log and auction. Visitors cannot see or affect each other's auctions.
- **Nothing happens until the visitor starts an auction**, so loading the page costs nothing.
- **Limits.** A room runs at most 20 auctions and takes at most 12 submissions per auction, refuses policies from outside, and deletes itself 30 minutes after it was last used.
- **The clock is always the real drand network.** A simulated clock is available for local development only (`npm run dev:offline` in the site repository).

The auctioneer and the cosigner still run in the same place, so the cosigner is not independent. The page says so.

## Not covered by automated tests

`tests/showcase.test.ts` runs an auction through the room and verifies it as the page does. The page itself was checked by driving it in a headless browser by hand; there is no browser test in the suite. On a laptop, online mode against live drand was run by hand on 2026-11-23 and behaved as described.

The Cloudflare version was run by hand in Cloudflare's local runtime with the simulated clock: a full auction in the real site page, with all four cheats refused. It has not been run against live drand, and it has not been deployed.
