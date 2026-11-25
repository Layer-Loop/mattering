# The Negotiation Room

A web page that shows sealed negotiation between software agents to people who do not read code. Acme's treasury agent and Bolt's sales agent negotiate early payment of a £10,000 invoice: what Acme pays today for an invoice due in 60 days. Each agent acts under a mandate from its firm, with a limit the other side cannot see.

**Status:** runs on a laptop, beside the Sealed Room. It is not on the website. It is a demonstration, and the service behind it is not hardened ([service.md](service.md)).

## Running it

```bash
npm run showcase
```

Then open http://127.0.0.1:8790/negotiation. `npm run showcase:offline` runs it on a simulated clock instead of drand. A negotiation takes up to three steps of about 25 seconds each against drand: 15 seconds until a step closes, then 9 until its offers open.

## What happens on the page

1. **Start.** Each firm issues its agent a mandate: the agent's key, the side, the currency, an expiry, and a limit drawn at random, committed so the other side cannot read it. The page shows who each agent acts for, and that the limit is sealed.
2. **Each step,** each agent seals one offer to both firms and to the step's release round, and submits it to the shared log. Nobody can read either offer before the release, the agents included, so neither sees the other's before committing its own.
3. **The step closes** on the beacon's clock, the log is countersigned, and the offers open.
4. **Your browser judges the step.** The two firms disclose to it what they would to an auditor: the keys to both offers and their mandates' limits. The browser opens the offers, checks each against its mandate, and works out the outcome: a deal at the midpoint if Acme's offer is at least Bolt's, otherwise another step, up to three.

The agents concede toward their limits step by step, and the limits are drawn so that they overlap: the third step reaches a deal.

## The cheat buttons and the rogue agent

| Button | What it does | What stops it |
| --- | --- | --- |
| Peek at Acme's offer as Bolt | While a step is sealed, Bolt's agent tries to open Acme's offer with its own key and the newest beacon signature | The signature that opens the offer does not exist yet |
| Change Bolt's offer after seeing Acme's | Once a step has opened, Bolt's agent submits a better offer for it | Refused as late; the log already holds its first offer, and only the first counts |
| Drop Bolt's offer as the log's operator | The browser removes Bolt's offer from the record and judges the step again | The record no longer matches the one signed at the close and countersigned before the offers could be read |
| Read the offers as an outsider | The browser judges the step with no keys | The prices stay unreadable; an outsider sees only that both offers were in on time |

**Let Acme's agent ignore its mandate in the last step** makes Acme's agent skip its own safeguard and offer past its limit. The deal still happens, and the page shows that the offer was beyond the mandate: Acme can prove its agent exceeded its authority, because the limit was fixed in the mandate before the negotiation began. Mattering detects this afterwards; it does not prevent it.

## What is real and what is staged

**Real:** the recipient sealing, the time lock, the shared log, the deadline, the cosignature, the mandates and their commitments, and the verification. The browser runs the same library as the tests, and takes evidence and disclosures from the server but never a verdict. In online mode it accepts only drand's key, compiled into the page.

**Staged:**

- Both agents run on the same server, which holds both firms' keys and mandate openings. In practice each agent runs at its own firm.
- The firms, the invoice and the limits are invented, and the agents follow a script, not a language model.
- The disclosure to the visitor is automatic. In practice a firm decides whom to disclose to.
- Until public witnesses cosign the log, the cosigner is run by the same operator. The page says so.

## Not covered by automated tests

`tests/negotiation-room.test.ts` runs an honest and a rogue negotiation through the server on a fast simulated clock and judges them as the page does, including the peek and the late revision. The page itself was driven by hand in a browser against live drand on 2026-11-25: three steps to a deal within both mandates, all four cheats refused or rejected, every check passing, and a rogue run showing Acme's offer beyond its mandate. There is no browser test in the suite.
