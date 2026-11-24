/**
 * The C2SP formats public witnesses use: signed notes, checkpoints,
 * cosignatures, and RFC 6962 consistency proofs. Known-answer vectors are from
 * the Go reference implementations (golang.org/x/mod/sumdb/note and
 * github.com/transparency-dev/formats).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { bytesToHex } from "@noble/hashes/utils";
import {
  checkpointText,
  consistencyProof,
  cosign,
  cosignatureTime,
  formatVkey,
  fromBase64,
  generateKeyPair,
  leafHash,
  merkleRoot,
  parseCheckpointText,
  parseNote,
  parseVkey,
  signNote,
  toBase64,
  verifyConsistency,
  verifyNoteSignature,
} from "@mattering/core";

const PETER_SKEY_SEED = "AYEKFALVFGyNhPJEMzD1QIDr+Y7hfZx09iUvxdXHKDFz";
const PETER_VKEY = "PeterNeumann+c74f20a3+ARpc2QcUPDhMQegwxbzhKqiBfsVkmqq/LDE4izWy10TW";
const ENOCH_VKEY = "EnochRoot+af0cfe78+ATtqJ7zOtqQtYqOo0CpvDXNlMhV3HeJDpjrASKGLWdop";
const TEXT = "If you think cryptography is the answer to your problem,\nthen you don't know what your problem is.\n";
const PETER_SIG = "— PeterNeumann x08go/ZJkuBS9UG/SffcvIAQxVBtiFupLLr8pAcElZInNIuGUgYN1FFYC2pZSNXgKvqfqdngotpRZb6KE6RyyBwJnAM=\n";
const ENOCH_SIG = "— EnochRoot rwz+eBzmZa0SO3NbfRGzPCpDckykFXSdeX+MNtCOXm2/5n2tiOHp+vAF1aGrQ5ovTG01oOTGwnWLox33WWd1RvMc+QQ=\n";

test("signed notes match Go's known-answer vectors byte for byte", () => {
  const seed = bytesToHex(fromBase64(PETER_SKEY_SEED)!.slice(1));
  assert.equal(signNote(TEXT, "PeterNeumann", seed), PETER_SIG);
  assert.equal(formatVkey(parseVkey(PETER_VKEY)), PETER_VKEY);
  const note = parseNote(TEXT + "\n" + PETER_SIG + ENOCH_SIG);
  assert.equal(note.text, TEXT);
  assert.ok(verifyNoteSignature(note, parseVkey(PETER_VKEY)));
  assert.ok(verifyNoteSignature(note, parseVkey(ENOCH_VKEY)));
  // A changed text, or a key whose id was tampered with, fails.
  assert.equal(verifyNoteSignature({ ...note, text: TEXT.replace("answer", "question") }, parseVkey(PETER_VKEY)), false);
  assert.throws(() => parseVkey(PETER_VKEY.replace("c74f20a3", "c74f20a4")));
  // A key whose base64 contains "+" still parses: only the first two "+" separate fields.
  for (let i = 0; i < 64; i++) {
    const vkey = formatVkey({ name: "log.example", type: 0x01, publicKey: generateKeyPair().publicKey });
    assert.equal(formatVkey(parseVkey(vkey)), vkey);
  }
  // Cosigner keys published by real witnesses parse.
  assert.equal(parseVkey("remora.n621.de+da77ade7+BOvN63jn/bLvkieywe8R6UYAtVtNbZpXh34x7onlmtw2").type, 0x04);
});

test("only canonical base64 is accepted", () => {
  for (const n of [0, 1, 2, 3, 31, 32, 33]) {
    const bytes = Uint8Array.from({ length: n }, (_, i) => (i * 37 + 11) & 0xff);
    assert.deepEqual(fromBase64(toBase64(bytes)), bytes);
  }
  assert.deepEqual(fromBase64("QQ=="), Uint8Array.of(0x41));
  assert.equal(fromBase64("QR=="), undefined, "non-zero padding bits are a second spelling");
  assert.equal(fromBase64("QQ"), undefined, "padding is required");
  assert.equal(fromBase64("Q Q=="), undefined);
});

test("notes with anything malformed are refused", () => {
  assert.throws(() => parseNote(TEXT));
  assert.throws(() => parseNote(TEXT + "\n" + PETER_SIG.trimEnd()));
  assert.throws(() => parseNote(TEXT + "\n" + "- PeterNeumann abc=\n"));
  assert.throws(() => parseNote(TEXT.replace("\n", "\r\n") + "\n" + PETER_SIG));
});

test("checkpoints round-trip and refuse malformed bodies", () => {
  const root = bytesToHex(merkleRoot([leafHash(Uint8Array.of(1))]));
  const text = checkpointText("example.com/log", 1, root);
  assert.deepEqual(parseCheckpointText(text), { origin: "example.com/log", size: 1, root, extensions: [] });
  assert.equal(parseCheckpointText("example.com/behind-the-sofa\n20852163\nCsUYapGGPo4dkMgIAUqom/Xajj7h2fB2MPA3j2jxq2I=\n").size, 20852163);
  assert.throws(() => parseCheckpointText(text.replace("\n1\n", "\n01\n")));
  assert.throws(() => parseCheckpointText(text.trimEnd()));
  assert.throws(() => parseCheckpointText(text + "\n"));
});

test("cosignatures carry a signed timestamp and verify only for their key and checkpoint", () => {
  const keys = generateKeyPair();
  const key = { name: "witness.example/w1", type: 0x04 as const, publicKey: keys.publicKey };
  const text = checkpointText("example.com/log", 5, "ab".repeat(32));
  const line = cosign(text, key.name, keys.secretKey, 1_700_000_000);
  const note = parseNote(text + "\n" + line);
  assert.equal(cosignatureTime(note, key), 1_700_000_000);
  assert.equal(note.signatures[0]!.signature.length, 72);
  // The same key published as a 0x01 vkey is recognised: the line carries the 0x04 key id.
  assert.equal(cosignatureTime(note, { ...key, type: 0x01 }), 1_700_000_000);
  assert.equal(cosignatureTime(note, { ...key, name: "witness.example/w2" }), undefined);
  assert.equal(cosignatureTime({ ...note, text: checkpointText("example.com/log", 6, "ab".repeat(32)) }, key), undefined);
  // Editing the timestamp breaks the signature, since the time is inside the signed message.
  const forged = note.signatures[0]!.signature.slice();
  forged[7] = forged[7]! ^ 1;
  assert.equal(cosignatureTime({ ...note, signatures: [{ ...note.signatures[0]!, signature: forged }] }, key), undefined);
});

test("consistency proofs: every prefix of every tree up to 40 leaves, and nothing else", () => {
  for (let n = 1; n <= 40; n++) {
    const leaves = Array.from({ length: n }, (_, i) => leafHash(Uint8Array.of(i)));
    const root = merkleRoot(leaves);
    for (let m = 0; m <= n; m++) {
      const proof = consistencyProof(leaves, m);
      assert.ok(verifyConsistency(m, n, merkleRoot(leaves.slice(0, m)), root, proof), `${m} -> ${n}`);
      if (m > 0 && m < n) {
        const other = merkleRoot([leafHash(Uint8Array.of(99)), ...leaves.slice(1, m)]);
        assert.equal(verifyConsistency(m, n, other, root, proof), false, `forked prefix ${m} -> ${n}`);
        assert.equal(verifyConsistency(m, n, merkleRoot(leaves.slice(0, m)), other, proof), false, `forked tree ${m} -> ${n}`);
      }
    }
  }
});
