# Scenario demos: a rental listing and a funding desk

Two demonstrations of Mattering's platform used as a business would use it, at [mattering.ai/demo/rental](https://mattering.ai/demo/rental) and [mattering.ai/demo/funding](https://mattering.ai/demo/funding). Each is a sealed-bid auction run through the public API ([api.md](api.md)) and the SDK, `@mattering/client`. The visitor takes part from their own browser.

**Status:** proof of concept, not security reviewed. Demonstrations only: no tenancy is offered, nothing is funded, and no money changes hands. The pages say so at the top.

## The rental listing

A two-bedroom flat in Hackney, advertised at £2,400 a month. It is laid out like a listing on a property portal, with no portal's or agent's branding. The flat, Larkspur Court and the letting agent, Demo Lettings, are invented.

- **The ceiling.** In England the Renters' Rights Act 2025 stops landlords and agents accepting offers above the advertised rent. So the auction's maximum bid is the advertised rent: offers run from £2,100 to £2,400, and the protocol refuses anything above.
- **Ties.** With a ceiling, keen applicants offer exactly the advertised rent, so the top offers often tie. The auction breaks a tie with the release round's drand signature: each tied offer gets a number, a hash of that signature and the offer's envelope id, and the lowest wins ([protocol.md](protocol.md), section 7). Nobody knows the signature before the offers are sealed, so nobody, the agent included, can steer the draw, unless a threshold of drand's operators colluded (assumption A1 in [claims.md](claims.md)). The page recomputes every tied offer's number in the visitor's browser and shows them.
- **Price is one step.** Referencing, affordability and right-to-rent checks still apply, and the demonstration doesn't cover them. It is not legal advice, and the rule's details, including where it applies, should be checked with someone who knows housing law.

## The funding desk

A £250,000 invoice due in 90 days, from an invented supplier, Harrow Supplies Ltd, to an invented debtor, Corvane Retail plc. The desk is an invented one, Northbank Receivables. Funders quote a discount in basis points of the face value; the lowest within the supplier's reserve of 900 bps wins. This is the reverse sealed auction that [api-design.md](api-design.md) is built around.

## What happens, and what is staged

| Step | What runs |
| --- | --- |
| The listing or invoice is put up | The demo, acting as the integrator, creates a client-sealed session under `organiser` confidentiality through the API, with an age key it makes and keeps for the agent or desk |
| The other bidders | Invented, and their offers are chosen by the demo: four applicants, two of them at the full rent; three funders. Each has its own key and seals with the SDK, through the API |
| The visitor | Joins with an invitation from their own browser. The SDK makes their key there, checks the round's policy (the public clock, this session, sealing to the agent's key), seals the offer and sends only the envelope and a signature |
| The release | Nobody can read an offer until the drand round in the policy. Then the demo, as the agent or desk, opens the offers with its own key and publishes the result by disclosing their file keys, which the platform checks against the evidence |
| The result | The page shows what the agent or desk sees: every offer. A real applicant or funder would see only the winning offer and their own. The visitor's browser works the result out again from the evidence and the disclosed keys, and explains a tie |

The demo runs in each visitor's own room on the Worker, as the other demos do, and acts as the integrator `mattering-demos` with an API key that exists only inside that room.

## Not covered by automated tests

`tests/scenario.test.ts` runs both scenarios on the server side with a visitor sealing through its own client, and checks the result from the evidence: a three-way tie at the full rent, with the drawn winner first, and the lowest quote winning the funding auction. The pages themselves were driven by hand in a browser on 2026-11-27, on a laptop and in Cloudflare's local runtime, both with the simulated clock: a tie drawn and checked, and a quote winning, with all 11 checks passing each time. Not yet against live drand.
