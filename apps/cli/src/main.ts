#!/usr/bin/env -S npx tsx
/**
 * mattering — seal, inspect, verify and open envelopes from the command line.
 * A thin shell over @mattering/core's public interface.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import {
  DEFAULT_POLICY,
  MatteringError,
  QUICKNET,
  assertBeaconInfo,
  envelopeId,
  firstRoundAtOrAfter,
  open,
  parseEnvelope,
  seal,
  serializeEnvelope,
  timeOfRound,
  verifyEnvelope,
  verifyOpen,
  type BeaconInfo,
  type Context,
  type Envelope,
  type Release,
  type VerificationResult,
  type VerifierPolicy,
} from "@mattering/core";
import { DEFAULT_RELAYS, fetchRelease } from "@mattering/core/drand-http";
import { fileKeyOf, generateRecipientKeys, openAs, openWithFileKey, recipientOf, sealTo, verifyDisclosure } from "@mattering/core/recipients";
import { TestBeacon } from "@mattering/core/testing";

const USAGE = `mattering <command> [options]

  seal         --payload <file> --out <envelope.json>
               (--round <n> | --at <ISO time> | --after <seconds>)
               [--to <age1…> ...] [--context key=value ...] [--beacon <info.json>]
  inspect      <envelope.json>
  verify       <envelope.json> [--round <n>] [--allow-beacon <info.json> ...]
  open         <envelope.json> --out <file|->
               [--identity <key.txt> | --file-key <hex>]
               [--signature <hex> | --relay <url> ...] [--allow-beacon <info.json> ...]
  verify-open  <envelope.json> --payload <file> [--file-key <hex>]
               [--signature <hex> | --relay <url> ...] [--allow-beacon <info.json> ...]

  Recipients (seal --to): only they can read the envelope once its round comes.
  keygen       --out <key.txt>       writes an age X25519 identity, prints its recipient
  file-key     <envelope.json> --identity <key.txt> [--signature <hex> | --relay <url> ...]
               prints the file key, which lets anyone read this one envelope

  Test beacons (offline testing only; the key holder can open everything):
  test-beacon new      --out <secret.json>
  test-beacon info     --beacon <secret.json>            prints info.json
  test-beacon release  --beacon <secret.json> --round <n> prints the signature

By default seals use drand quicknet and verifiers accept only drand quicknet.
Experimental proof of concept. Not security reviewed.`;

function fail(message: string): never {
  process.stderr.write(`error: ${message}\n`);
  process.exit(1);
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    return fail(`cannot read ${path}: ${(error as Error).message}`);
  }
}

function readBeacon(path: string): BeaconInfo {
  const info = readJson(path);
  assertBeaconInfo(info, path);
  return info;
}

function readEnvelope(path: string | undefined): Envelope {
  if (!path) fail("missing envelope file");
  try {
    return parseEnvelope(readFileSync(path, "utf8"));
  } catch (error) {
    return fail(`${path}: ${(error as Error).message}`);
  }
}

/** The identity in a key file: the AGE-SECRET-KEY-1 line, as age-keygen writes it. */
function readIdentity(path: string): string {
  let text = "";
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    fail(`cannot read ${path}: ${(error as Error).message}`);
  }
  const line = text.split("\n").map((l) => l.trim()).find((l) => l.startsWith("AGE-SECRET-KEY-1"));
  return line ?? fail(`${path}: no AGE-SECRET-KEY-1 line`);
}

function policyFrom(allow: string[] | undefined, round?: string): VerifierPolicy {
  const acceptedBeacons = [...DEFAULT_POLICY.acceptedBeacons, ...(allow ?? []).map(readBeacon)];
  return round === undefined ? { acceptedBeacons } : { acceptedBeacons, expectedRound: Number(round) };
}

async function releaseFor(envelope: Envelope, signature?: string, relays?: string[]): Promise<Release> {
  if (signature) return { round: envelope.round, signature: signature.toLowerCase() };
  return fetchRelease(envelope.beacon, envelope.round, relays?.length ? relays : DEFAULT_RELAYS);
}

function printResult(result: VerificationResult): void {
  for (const check of result.checks) {
    process.stdout.write(`${check.ok ? "PASS" : "FAIL"}  ${check.name}${check.detail ? `  (${check.detail})` : ""}\n`);
  }
  if (result.envelopeId) process.stdout.write(`envelope id: ${result.envelopeId}\n`);
  process.stdout.write(result.ok ? "OK\n" : "NOT OK\n");
  if (!result.ok) process.exitCode = 1;
}

const common = {
  out: { type: "string" },
  payload: { type: "string" },
  round: { type: "string" },
  at: { type: "string" },
  after: { type: "string" },
  context: { type: "string", multiple: true },
  beacon: { type: "string" },
  "allow-beacon": { type: "string", multiple: true },
  signature: { type: "string" },
  relay: { type: "string", multiple: true },
  to: { type: "string", multiple: true },
  identity: { type: "string" },
  "file-key": { type: "string" },
  help: { type: "boolean", short: "h" },
} as const;

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({ args: process.argv.slice(2), options: common, allowPositionals: true });
  const [command, ...rest] = positionals;
  if (values.help || !command) {
    process.stdout.write(USAGE + "\n");
    return;
  }

  switch (command) {
    case "seal": {
      if (!values.payload || !values.out) fail("seal needs --payload and --out");
      const beacon = values.beacon ? readBeacon(values.beacon) : QUICKNET;
      const given = [values.round, values.at, values.after].filter((v) => v !== undefined).length;
      if (given !== 1) fail("seal needs exactly one of --round, --at, --after");
      let round: number;
      if (values.round !== undefined) round = Number(values.round);
      else {
        const seconds = values.at !== undefined ? Date.parse(values.at) / 1000 : Date.now() / 1000 + Number(values.after);
        if (!Number.isFinite(seconds)) fail("could not understand the release time");
        round = firstRoundAtOrAfter(beacon, seconds);
      }
      const context: Context = {};
      for (const pair of values.context ?? []) {
        const eq = pair.indexOf("=");
        if (eq < 1) fail(`--context wants key=value, got ${pair}`);
        context[pair.slice(0, eq)] = pair.slice(eq + 1);
      }
      const options = { payload: readFileSync(values.payload), round, beacon, context };
      const envelope = values.to?.length ? await sealTo({ ...options, recipients: values.to }) : await seal(options);
      writeFileSync(values.out, serializeEnvelope(envelope));
      process.stdout.write(`sealed until round ${round}`);
      if (!values.beacon) process.stdout.write(` (${new Date(timeOfRound(beacon, round) * 1000).toISOString()})`);
      process.stdout.write(`\nenvelope id: ${envelopeId(envelope)}\n`);
      return;
    }
    case "inspect": {
      const envelope = readEnvelope(rest[0]);
      const known = envelope.beacon.chainHash === QUICKNET.chainHash;
      process.stdout.write(
        [
          `format:       ${envelope.format}`,
          `envelope id:  ${envelopeId(envelope)}`,
          `beacon chain: ${envelope.beacon.chainHash}${known ? " (drand quicknet)" : " (NOT a default beacon)"}`,
          `opens at:     round ${envelope.round}${known ? ` (${new Date(timeOfRound(envelope.beacon, envelope.round) * 1000).toISOString()})` : ""}`,
          `context:      ${JSON.stringify(envelope.context)}`,
          ...(envelope.recipients ? [`opens to:     ${envelope.recipients.join(", ")}`] : [`opens to:     everyone`]),
          `ciphertext:   ${envelope.ciphertext.length} characters of armored age`,
          "",
        ].join("\n"),
      );
      return;
    }
    case "verify": {
      printResult(verifyEnvelope(readEnvelope(rest[0]), policyFrom(values["allow-beacon"], values.round)));
      return;
    }
    case "open": {
      if (!values.out) fail("open needs --out (use - for stdout)");
      const envelope = readEnvelope(rest[0]);
      const release = await releaseFor(envelope, values.signature, values.relay);
      const policy = policyFrom(values["allow-beacon"]);
      const payload = values.identity
        ? await openAs(envelope, release, readIdentity(values.identity), policy)
        : values["file-key"]
          ? await openWithFileKey(envelope, release, values["file-key"], policy)
          : await open(envelope, release, policy);
      if (values.out === "-") process.stdout.write(payload);
      else {
        writeFileSync(values.out, payload);
        process.stderr.write(`opened ${payload.length} bytes to ${values.out}\n`);
      }
      return;
    }
    case "verify-open": {
      if (!values.payload) fail("verify-open needs --payload");
      const envelope = readEnvelope(rest[0]);
      const release = await releaseFor(envelope, values.signature, values.relay);
      const policy = policyFrom(values["allow-beacon"]);
      const payload = readFileSync(values.payload);
      printResult(values["file-key"] ? await verifyDisclosure(envelope, payload, release, values["file-key"], policy) : await verifyOpen(envelope, payload, release, policy));
      return;
    }
    case "keygen": {
      if (!values.out) fail("keygen needs --out");
      const keys = await generateRecipientKeys();
      writeFileSync(values.out, `# created: ${new Date().toISOString()}\n# public key: ${keys.recipient}\n${keys.identity}\n`, { mode: 0o600 });
      process.stderr.write(`wrote a secret identity to ${values.out}; keep it private\n`);
      process.stdout.write(`${keys.recipient}\n`);
      return;
    }
    case "file-key": {
      if (!values.identity) fail("file-key needs --identity");
      const envelope = readEnvelope(rest[0]);
      const release = await releaseFor(envelope, values.signature, values.relay);
      const identity = readIdentity(values.identity);
      await recipientOf(identity);
      process.stdout.write(`${await fileKeyOf(envelope, release, identity, policyFrom(values["allow-beacon"]))}\n`);
      return;
    }
    case "test-beacon": {
      const sub = rest[0];
      if (sub === "new") {
        if (!values.out) fail("test-beacon new needs --out");
        const beacon = new TestBeacon();
        writeFileSync(values.out, JSON.stringify({ testOnly: true, secretHex: beacon.secretHex }, null, 2) + "\n");
        process.stderr.write("wrote a TEST beacon secret; whoever holds it can open every seal made to it\n");
        return;
      }
      if (!values.beacon) fail("test-beacon needs --beacon <secret.json>");
      const beacon = new TestBeacon((readJson(values.beacon) as { secretHex: string }).secretHex);
      if (sub === "info") process.stdout.write(JSON.stringify(beacon.info, null, 2) + "\n");
      else if (sub === "release") {
        if (!values.round) fail("test-beacon release needs --round");
        process.stdout.write(beacon.release(Number(values.round)).signature + "\n");
      } else fail("test-beacon wants new, info or release");
      return;
    }
    default:
      fail(`unknown command ${command}\n\n${USAGE}`);
  }
}

main().catch((error: unknown) => {
  if (error instanceof MatteringError) fail(`${error.code}: ${error.message}`);
  fail((error as Error).stack ?? String(error));
});
