/**
 * A `ServiceStore` on plain files, for running a witness on one machine:
 *
 *   witness-key.json         the witness's signing key (keep private)
 *   log.jsonl                one log entry per line, append-only
 *   policies/<hash>.json     registered policies
 *   retired/<hash>           marks a released policy, which loads only when asked for
 *   envelopes/<id>.json      sealed envelopes, kept so they can be opened later
 *   closings/<hash>.json     closing checkpoint and cosignatures per policy
 *
 * On start it reads the log once to find each line and its leaf hash; after
 * that, reading a stretch of the log reads only those lines.
 */
import { appendFileSync, chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { entryLeafHash, type Envelope, type LogEntry } from "@mattering/core";
import type { AnyPolicy, ServiceStore, StoredClosing, StoredState } from "./service.ts";

export function fileStore(dir: string): ServiceStore {
  for (const sub of ["", "policies", "retired", "envelopes", "closings"]) mkdirSync(join(dir, sub), { recursive: true });
  const keyFile = join(dir, "witness-key.json");
  const logFile = join(dir, "log.jsonl");
  const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, "utf8")) as T;
  /** Byte offset of each entry's line, plus one past the last. */
  const offsets: number[] = [0];
  return {
    async load() {
      const state: StoredState = { leafHashes: [], policies: [], closings: {} };
      if (existsSync(keyFile)) state.secretKey = readJson<{ secretKey: string }>(keyFile).secretKey;
      offsets.length = 1;
      if (existsSync(logFile)) {
        const bytes = readFileSync(logFile);
        let start = 0;
        for (let end = bytes.indexOf(0x0a); end >= 0; start = end + 1, end = bytes.indexOf(0x0a, start)) {
          state.leafHashes.push(entryLeafHash(JSON.parse(bytes.subarray(start, end).toString("utf8")) as LogEntry));
          offsets.push(end + 1);
        }
      }
      const retired = new Set(readdirSync(join(dir, "retired")));
      for (const file of readdirSync(join(dir, "policies"))) {
        const hash = file.replace(/\.json$/, "");
        if (retired.has(hash)) continue;
        state.policies.push(readJson<AnyPolicy>(join(dir, "policies", file)));
        if (existsSync(join(dir, "closings", file))) state.closings[hash] = readJson<StoredClosing>(join(dir, "closings", file));
      }
      return state;
    },
    async saveKey(secretKey) {
      writeFileSync(keyFile, JSON.stringify({ secretKey }) + "\n", { mode: 0o600 });
      chmodSync(keyFile, 0o600);
    },
    async appendEntry(index, entry) {
      if (index !== offsets.length - 1) throw new Error(`log.jsonl: expected entry ${offsets.length - 1}, got ${index}`);
      const line = JSON.stringify(entry) + "\n";
      appendFileSync(logFile, line);
      offsets.push(offsets.at(-1)! + Buffer.byteLength(line));
    },
    async readEntries(from, to) {
      const end = Math.min(to, offsets.length - 1);
      if (from >= end) return [];
      const buffer = Buffer.alloc(offsets[end]! - offsets[from]!);
      const fd = openSync(logFile, "r");
      try {
        readSync(fd, buffer, 0, buffer.length, offsets[from]!);
      } finally {
        closeSync(fd);
      }
      return buffer.toString("utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as LogEntry);
    },
    async savePolicy(hash, policy) {
      writeFileSync(join(dir, "policies", `${hash}.json`), JSON.stringify(policy, null, 2) + "\n");
    },
    async loadPolicy(hash) {
      const file = join(dir, "policies", `${hash}.json`);
      if (!existsSync(file)) return undefined;
      const closing = join(dir, "closings", `${hash}.json`);
      return { policy: readJson<AnyPolicy>(file), closing: existsSync(closing) ? readJson<StoredClosing>(closing) : undefined };
    },
    async retirePolicy(hash) {
      writeFileSync(join(dir, "retired", hash), "");
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
