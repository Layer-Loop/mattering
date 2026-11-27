# The Negotiation Room

A web page that shows sealed negotiation between software agents to people who do not read code. Acme's treasury agent and Bolt's sales agent negotiate early payment of a £10,000 invoice: what Acme pays today for an invoice due in 60 days. Each agent acts under a mandate from its firm, with a limit the other side cannot see.

**Status:** runs on a laptop beside the Sealed Room, and is built for the website at mattering.ai/demo/negotiation. It is a demonstration, and the service behind it is not hardened ([service.md](service.md)).

## Running it

```bash
npm run showcase
```

Then open http://127.0.0.1:8790/demo/negotiation. `npm run showcase:offline` runs it on a simulated clock instead of drand. A negotiation takes up to three steps of about 25 seconds each against drand: 15 seconds until a step closes, then 9 until its offers open. The page calls the steps rounds; it shares its design with the Sealed Room ([showcase.md](showcase.md), "The pages").

## What happens on the page

1. **Start.** Each firm issues its agent a mandate: the agent's key, the side, the currency, an expiry, and a limit drawn at random, committed so the other side cannot read it. The page shows who each agent acts for, and that the limit is sealed.
2. **Each step,** each agent seals one offer to both firms and to the step's release round, and submits it to the shared log. Nobody can read either offer before the release, the agents included, so neither sees the other's before committing its own.
3. **The step closes** on the beacon's clock, the log is countersigned, and the offers open.
4. **Your browser judges the step.** The two firms disclose to it what they would to an auditor: the keys to both offers and their mandates' limits. The browser opens the offers, checks each against its mandate, and works out the outcome: a deal at the midpoint if Acme's offer is at least Bolt's, otherwise another step, up to three.

The limits are drawn so that they overlap, so a deal is possible at a price neither side knows.

## Who chooses the offers

With a Claude API key configured, a language model chooses each agent's offer:

```bash
ANTHROPIC_API_KEY=... npm run showcase
```

`MATTERING_MODEL` chooses the model, as for the auction; the default is `claude-haiku-5-5`. At the start of each step both agents are asked at once. Each is told the rules (offers sealed and opened together, the midpoint if they cross, up to three steps, the invoice paid in full if there is no deal), its own firm's limit, that its firm counts any deal within the mandate as better than none, and a list of every price it has seen: both sides' offers from earlier steps, step by step. It is told that the other side's offer for the current step is sealed, and never to describe, guess or imply it. At the last step it is told plainly that if the offers do not cross there is no deal at all. It answers with an offer and one sentence to its firm.

- **The mandate binds the model as it binds the script.** An answer beyond the agent's limit is thrown away like any unusable answer, and the script decides for that agent. So does an amount out of range, a malformed answer, a refusal, a failure, or no answer within ten seconds.
- **The page says which.** Before a negotiation starts, the page names the model that will choose the offers (such as "Claude Haiku 5.5"), or says a script will because no model is configured. Each offer the script chose in place of the model says so where its note would be.
- **The note is shown once the step opens,** inside the offer's bubble, as "To Acme: …": it is addressed to the agent's own firm, not to the other agent. It is the agent's explanation to its own firm, not part of the evidence, and it is never sealed.
- **A note may state only amounts the agent has seen.** Every amount of money in it is compared with the agent's list of seen prices, its own limit, the invoice's figures and the offer it is making. If any other amount appears, such as a guess at the other side's sealed offer, the note is withheld and the page says so; the offer still counts. This checks figures, not wording: a note that misdescribes seen prices without naming a new amount ("the buyer moved from £9,400", written before the buyer's new offer could be seen) is not caught by it, only discouraged by the prompt. Notes are the model's own words, and the page treats them as such.
- **Chosen offers are held in memory only** until they are sealed.
- **The rogue option overrides the model:** in the last step Acme's agent offers past its limit by script, whatever the model would have done. The page shows that offer as "chosen by a script, told to ignore its limit", with no note.

Without a key, the scripts decide: each agent concedes toward its limit, reaching it at the third step.

## The cheat buttons and the rogue agent

| Button | What it does | What stops it |
| --- | --- | --- |
| Peek at Acme's offer as Bolt | While a step is sealed, Bolt's agent tries to open Acme's offer with its own key and the newest beacon signature | The signature that opens the offer does not exist yet |
| Change Bolt's offer after seeing Acme's | Once a step has opened, Bolt's agent submits a better offer for it | Refused as late; the log already holds its first offer, and only the first counts |
| Drop Bolt's offer as the log's operator | The browser removes Bolt's offer from the record and judges the step again | The record no longer matches the one signed at the close and countersigned before the offers could be read |
| Read the offers as an outsider | The browser judges the step with no keys | The prices stay unreadable; an outsider sees only that both offers were in on time |

**Let Acme's agent ignore its limit in the last round** makes Acme's agent skip its own safeguard and offer past its limit. The deal still happens, and the page shows that the offer was beyond the mandate: Acme can prove its agent exceeded its authority, because the limit was fixed in the mandate before the negotiation began. Mattering detects this afterwards; it does not prevent it.

## What is real and what is staged

**Real:** the recipient sealing, the time lock, the shared log, the deadline, the cosignature, the mandates and their commitments, and the verification. The browser runs the same library as the tests, and takes evidence and disclosures from the server but never a verdict. In online mode it accepts only drand's key, compiled into the page.

**Staged:**

- Both agents run on the same server, which holds both firms' keys and mandate openings. In practice each agent runs at its own firm.
- The firms, the invoice and the limits are invented. The offers come from a language model if one is configured, and from a script otherwise.
- The disclosure to the visitor is automatic. In practice a firm decides whom to disclose to.
- Until public witnesses cosign the log, the cosigner is run by the same operator. The page's scenario says we run the agents' server and hold both keys; the home page and these documents give the general limits.

## On the website

The website serves the page at `/demo/negotiation`, built from this repository's pages with the Sealed Room's (see [showcase.md](showcase.md)). The old address, `/negotiate`, redirects to it.

- **One room per visitor holds both demonstrations.** The negotiation runs in the same Durable Object as the visitor's auction room, under `/room/<id>/negotiation/…`, on the shared log, and is deleted with it 30 minutes after last use. A room runs at most 10 negotiations.
- **Nothing happens until the visitor starts.** Before that the page asks only `/demo-info`, which the Worker answers without creating a room, for the name of the model that will choose the offers, if any. The website's `wrangler.jsonc` must send `/demo-info` to the Worker.
- **The model shares the daily allowance** with the auction (`MODEL_AUCTIONS_PER_DAY`). A negotiation makes about six model requests against an auction's three, so it counts as two auctions. Once the allowance is spent, the scripts choose.
- **The clock is the real drand network,** with steps of 5 rounds to the close and 3 more to the opening, about 25 seconds each.

## Not covered by automated tests

`tests/negotiation-room.test.ts` runs an honest and a rogue negotiation through the server on a fast simulated clock and judges them as the page does, including the peek and the late revision. `tests/negotiation-model.test.ts` covers the model path with a stand-in model: what each agent is told, that its offers are sealed as given, that an offer beyond the mandate or an unusable answer is replaced by the script, and the request sent to the Messages API, against a stand-in server. The model path was run by hand against the real Claude API with `claude-haiku-5-5` on 2026-11-25, and the page showed the offers chosen by Claude Haiku 5.5. Nothing checks the real API automatically. The page with a stand-in model was checked by hand in a browser on 2026-11-25. The website version was run on 2026-11-25 in Cloudflare's local runtime with the simulated clock: a rogue negotiation through three steps to a deal, Acme's last offer shown beyond its mandate, three cheats refused or rejected, every other check passing, and no room created before the visitor pressed Start. It was then deployed and has run on mattering.ai against live drand since 2026-11-25, including the run that showed an agent's note describing an offer it had not seen, which led to notes being checked against the amounts the agent has seen. The page itself was driven by hand in a browser against live drand on 2026-11-25: three steps to a deal within both mandates, all four cheats refused or rejected, every check passing, and a rogue run showing Acme's offer beyond its mandate. There is no browser test in the suite.
