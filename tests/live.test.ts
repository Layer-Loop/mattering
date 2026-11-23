/**
 * Optional: the same flow against the real drand quicknet. Needs network
 * access to a drand relay and about ten seconds. Run with `npm run test:live`.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { MatteringError, QUICKNET, firstRoundAtOrAfter, open, seal, timeOfRound } from "@mattering/core";
import { fetchRelease } from "@mattering/core/drand-http";

test("live quicknet: sealed now, unopenable now, openable a few seconds later", { skip: process.env.MATTERING_LIVE !== "1" }, async () => {
  const payload = new TextEncoder().encode("live");
  const round = firstRoundAtOrAfter(QUICKNET, Date.now() / 1000 + 9);
  const envelope = await seal({ payload, round });

  await assert.rejects(fetchRelease(QUICKNET, round), (e: unknown) => e instanceof MatteringError && e.code === "UNAVAILABLE");
  const previous = await fetchRelease(QUICKNET, round - 3);
  await assert.rejects(open(envelope, { round, signature: previous.signature }), MatteringError);

  await new Promise((resolve) => setTimeout(resolve, timeOfRound(QUICKNET, round) * 1000 - Date.now() + 2500));
  assert.deepEqual(await open(envelope, await fetchRelease(QUICKNET, round)), payload);
});
