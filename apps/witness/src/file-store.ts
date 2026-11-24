/**
 * A `ServiceStore` on plain files, for running a witness on one machine:
 *
 *   witness-key.json         the witness's signing key (keep private)
 *   log.jsonl                one submission per line, append-only
 *   policies/<hash>.json     registered policies
 *   envelopes/<id>.json      sealed envelopes, kept so they can be opened later
 *   closings/<hash>.json     closing checkpoint and cosignatures per policy
 */
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Envelope, LogEntry } from "@mattering/core";
import type { AnyPolicy, ServiceStore, StoredClosing, StoredState } from "./service.ts";

export function fileStore(dir: string): ServiceStore {
  for (const sub of ["", "policies", "envelopes", "closings"]) mkdirSync(join(dir, sub), { recursive: true });
  const keyFile = join(dir, "witness-key.json");
  const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, "utf8")) as T;
  return {
    async load() {
      const state: StoredState = { entries: [], policies: [], closings: {} };
      if (existsSync(keyFile)) state.secretKey = readJson<{ secretKey: string }>(keyFile).secretKey;
      if (existsSync(join(dir, "log.jsonl"))) {
        state.entries = readFileSync(join(dir, "log.jsonl"), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as LogEntry);
      }
      for (const file of readdirSync(join(dir, "policies"))) state.policies.push(readJson<AnyPolicy>(join(dir, "policies", file)));
      for (const file of readdirSync(join(dir, "closings"))) state.closings[file.replace(/\.json$/, "")] = readJson<StoredClosing>(join(dir, "closings", file));
      return state;
    },
    async saveKey(secretKey) {
      writeFileSync(keyFile, JSON.stringify({ secretKey }) + "\n", { mode: 0o600 });
      chmodSync(keyFile, 0o600);
    },
    async appendEntry(_index, submission) {
      appendFileSync(join(dir, "log.jsonl"), JSON.stringify(submission) + "\n");
    },
    async savePolicy(hash, policy) {
      writeFileSync(join(dir, "policies", `${hash}.json`), JSON.stringify(policy, null, 2) + "\n");
    },
    async saveEnvelope(id, envelope) {
      writeFileSync(join(dir, "envelopes", `${id}.json`), JSON.stringify(envelope) + "\n");
    },
    async loadEnvelope(id) {
      const file = join(dir, "envelopes", `${id}.json`);
      return existsSync(file) ? readJson<Envelope>(file) : undefined;
    },
    async saveClosing(hash, value) {
      writeFileSync(join(dir, "closings", `${hash}.json`), JSON.stringify(value, null, 2) + "\n");
    },
  };
}
