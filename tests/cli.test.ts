/**
 * Phase 1 exit criterion: separate processes produce, store, later open and
 * verify a sealed object, sharing nothing but files.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const CLI = join(import.meta.dirname, "..", "apps", "cli", "src", "main.ts");

function run(...args: string[]): { status: number; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, ["--import", "tsx", CLI, ...args], { encoding: "utf8" });
  return { status: r.status ?? -1, stdout: r.stdout, stderr: r.stderr };
}

test("seal in one process, verify and open in others", () => {
  const dir = mkdtempSync(join(tmpdir(), "mattering-"));
  const p = (name: string) => join(dir, name);
  writeFileSync(p("secret.txt"), "launch code: tangerine\n");

  // The "drand network" for this test: one party holding a beacon key.
  assert.equal(run("test-beacon", "new", "--out", p("beacon-secret.json")).status, 0);
  const info = run("test-beacon", "info", "--beacon", p("beacon-secret.json"));
  writeFileSync(p("beacon.json"), info.stdout);

  // Process A seals, knowing only the beacon's public parameters.
  const sealed = run("seal", "--payload", p("secret.txt"), "--out", p("envelope.json"), "--round", "42", "--beacon", p("beacon.json"), "--context", "purpose=test");
  assert.equal(sealed.status, 0, sealed.stderr);
  assert.equal(readFileSync(p("envelope.json"), "utf8").includes("tangerine"), false);

  // Process B inspects and verifies while it is still sealed.
  assert.match(run("inspect", p("envelope.json")).stdout, /round 42/);
  assert.equal(run("verify", p("envelope.json")).status, 1, "default policy must reject a test beacon");
  assert.equal(run("verify", p("envelope.json"), "--allow-beacon", p("beacon.json"), "--round", "42").status, 0);
  assert.equal(run("verify", p("envelope.json"), "--allow-beacon", p("beacon.json"), "--round", "43").status, 1);

  // Before round 42 is emitted, the only signatures in existence do not open it.
  const early = run("test-beacon", "release", "--beacon", p("beacon-secret.json"), "--round", "41").stdout.trim();
  const tooSoon = run("open", p("envelope.json"), "--out", p("out.txt"), "--signature", early, "--allow-beacon", p("beacon.json"));
  assert.equal(tooSoon.status, 1);
  assert.match(tooSoon.stderr, /RELEASE_INVALID/);

  // The beacon emits round 42. Process C opens with the envelope and that signature alone.
  const signature = run("test-beacon", "release", "--beacon", p("beacon-secret.json"), "--round", "42").stdout.trim();
  const opened = run("open", p("envelope.json"), "--out", p("out.txt"), "--signature", signature, "--allow-beacon", p("beacon.json"));
  assert.equal(opened.status, 0, opened.stderr);
  assert.equal(readFileSync(p("out.txt"), "utf8"), "launch code: tangerine\n");

  // stdout carries the payload and nothing else.
  const piped = run("open", p("envelope.json"), "--out", "-", "--signature", signature, "--allow-beacon", p("beacon.json"));
  assert.equal(piped.stdout, "launch code: tangerine\n");

  // Process D checks a claimed opening, true and false.
  assert.equal(run("verify-open", p("envelope.json"), "--payload", p("out.txt"), "--signature", signature, "--allow-beacon", p("beacon.json")).status, 0);
  writeFileSync(p("forged.txt"), "launch code: lemon\n");
  assert.equal(run("verify-open", p("envelope.json"), "--payload", p("forged.txt"), "--signature", signature, "--allow-beacon", p("beacon.json")).status, 1);
});

test("beacon outage: without release material the envelope stays sealed, with a clear error", () => {
  const dir = mkdtempSync(join(tmpdir(), "mattering-"));
  const p = (name: string) => join(dir, name);
  writeFileSync(p("secret.txt"), "x");
  assert.equal(run("seal", "--payload", p("secret.txt"), "--out", p("envelope.json"), "--after", "3600").status, 0);
  const result = run("open", p("envelope.json"), "--out", p("out.txt"), "--relay", "http://127.0.0.1:9");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /UNAVAILABLE/);
});

test("sealed to a recipient: only their key opens it, and a disclosed file key lets others check it", () => {
  const dir = mkdtempSync(join(tmpdir(), "mattering-"));
  const p = (name: string) => join(dir, name);
  writeFileSync(p("offer.txt"), "offer: 98.40 per unit\n");
  run("test-beacon", "new", "--out", p("beacon-secret.json"));
  writeFileSync(p("beacon.json"), run("test-beacon", "info", "--beacon", p("beacon-secret.json")).stdout);
  const buyer = run("keygen", "--out", p("buyer.txt"));
  assert.equal(buyer.status, 0, buyer.stderr);
  const recipient = buyer.stdout.trim();
  assert.match(recipient, /^age1[02-9ac-hj-np-z]{58}$/);
  run("keygen", "--out", p("outsider.txt"));

  const sealed = run("seal", "--payload", p("offer.txt"), "--out", p("envelope.json"), "--round", "7", "--beacon", p("beacon.json"), "--to", recipient);
  assert.equal(sealed.status, 0, sealed.stderr);
  assert.match(run("inspect", p("envelope.json")).stdout, new RegExp(`opens to: +${recipient}`));
  const sig = run("test-beacon", "release", "--beacon", p("beacon-secret.json"), "--round", "7").stdout.trim();
  const allow = ["--allow-beacon", p("beacon.json"), "--signature", sig];

  assert.notEqual(run("open", p("envelope.json"), "--out", "-", ...allow).status, 0, "no key, no opening");
  assert.notEqual(run("open", p("envelope.json"), "--out", "-", "--identity", p("outsider.txt"), ...allow).status, 0);
  const opened = run("open", p("envelope.json"), "--out", "-", "--identity", p("buyer.txt"), ...allow);
  assert.equal(opened.status, 0, opened.stderr);
  assert.equal(opened.stdout, "offer: 98.40 per unit\n");

  const key = run("file-key", p("envelope.json"), "--identity", p("buyer.txt"), ...allow);
  assert.equal(key.status, 0, key.stderr);
  const checked = run("verify-open", p("envelope.json"), "--payload", p("offer.txt"), "--file-key", key.stdout.trim(), ...allow);
  assert.equal(checked.status, 0, checked.stdout);
  assert.match(checked.stdout, /PASS +opens-with-file-key/);
});
