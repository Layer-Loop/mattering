/**
 * A witness in the sense of the public witness network: it keeps the latest
 * checkpoint it has cosigned for each log it knows, and cosigns a new one only
 * if a consistency proof shows the log has grown without being rewritten. It
 * speaks the C2SP tlog-witness add-checkpoint protocol
 * (https://c2sp.org/tlog-witness), so a Mattering witness talks to this and to
 * public witnesses in the same way.
 *
 * Mattering includes it for tests, demonstrations and anyone who wants to run
 * a cosigner without other software. It is worth something only if someone
 * other than the log's operator runs it.
 */
import { bytesToHex, hexToBytes } from "@noble/hashes/utils";
import { sha256 } from "@noble/hashes/sha256";
import { COSIGNATURE_ED25519, cosign, formatVkey, fromBase64, isKeyName, parseCheckpointText, parseNote, parseVkey, verifyNoteSignature, type NoteKey } from "./note.ts";
import { verifyConsistency } from "./merkle.ts";
import { generateKeyPair, type KeyPair } from "./signing.ts";
import { MatteringError } from "./errors.ts";

/** The latest checkpoint cosigned for one log. Persist it: forgetting it lets a fork through. */
export interface CosignedState {
  size: number;
  /** RFC 6962 root, lowercase hex. */
  root: string;
}

export interface CosignerOptions {
  /** This cosigner's name, as it appears in signature lines. A schema-less URL is conventional. */
  name: string;
  /** The logs it will cosign for, as C2SP verifier keys (Ed25519, type 0x01). */
  logs: string[];
  /** UNIX seconds by this cosigner's own clock. What it stamps on every cosignature. */
  clock: () => number;
  secretKey?: string;
  /** Previously persisted state, by origin. */
  state?: Record<string, CosignedState>;
  /** Called before a cosignature is returned. Must be durable when it resolves. */
  persist?: (origin: string, state: CosignedState) => void | Promise<void>;
}

/** An HTTP response in the protocol's terms. */
export interface AddCheckpointReply {
  status: 200 | 400 | 403 | 404 | 409 | 422;
  body: string;
  contentType: string;
  /** Why it refused, in words. Not part of the protocol. */
  reason?: string;
}

const EMPTY_ROOT = bytesToHex(sha256(new Uint8Array()));
const MAX_PROOF_LINES = 63;

export class Cosigner {
  readonly keys: KeyPair;
  readonly name: string;
  private readonly logs = new Map<string, NoteKey>();
  readonly state: Map<string, CosignedState>;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: CosignerOptions) {
    if (!isKeyName(options.name)) throw new MatteringError("MALFORMED", "cosigner name");
    this.name = options.name;
    this.keys = generateKeyPair(options.secretKey);
    for (const vkey of options.logs) {
      const key = parseVkey(vkey);
      if (key.type !== 0x01) throw new MatteringError("MALFORMED", "log keys must be Ed25519 signature keys (type 0x01)");
      this.logs.set(key.name, key);
    }
    this.state = new Map(Object.entries(options.state ?? {}));
  }

  get publicKey(): string {
    return this.keys.publicKey;
  }

  /** This cosigner's verifier key, for policies to name. */
  get vkey(): string {
    return formatVkey({ name: this.name, type: COSIGNATURE_ED25519, publicKey: this.publicKey });
  }

  /** Start cosigning for another log. */
  addLog(vkey: string): void {
    const key = parseVkey(vkey);
    if (key.type !== 0x01) throw new MatteringError("MALFORMED", "log keys must be Ed25519 signature keys (type 0x01)");
    this.logs.set(key.name, key);
  }

  /** POST <prefix>/add-checkpoint. One request at a time, so the size check and the update are atomic. */
  addCheckpoint(body: string): Promise<AddCheckpointReply> {
    const run = this.queue.then(() => this.handle(body));
    this.queue = run.catch(() => {});
    return run;
  }

  private async handle(body: string): Promise<AddCheckpointReply> {
    const refuse = (status: AddCheckpointReply["status"], reason: string, text = reason + "\n"): AddCheckpointReply => ({ status, body: text, contentType: "text/plain; charset=utf-8", reason });
    const split = typeof body === "string" ? body.indexOf("\n\n") : -1;
    if (split < 0) return refuse(400, "malformed request");
    const [oldLine, ...proofLines] = body.slice(0, split).split("\n");
    const oldMatch = /^old (0|[1-9][0-9]*)$/.exec(oldLine ?? "");
    const proof = proofLines.map(fromBase64);
    if (!oldMatch || !Number.isSafeInteger(Number(oldMatch[1])) || proof.length > MAX_PROOF_LINES || proof.some((p) => p?.length !== 32)) return refuse(400, "malformed request");
    const oldSize = Number(oldMatch[1]);
    let note;
    let checkpoint;
    try {
      note = parseNote(body.slice(split + 2));
      checkpoint = parseCheckpointText(note.text);
    } catch {
      return refuse(400, "malformed checkpoint");
    }
    const log = this.logs.get(checkpoint.origin);
    if (!log) return refuse(404, "unknown log");
    if (!verifyNoteSignature(note, log)) return refuse(403, "not signed by the log's key");
    if (oldSize > checkpoint.size) return refuse(400, "old size is larger than the checkpoint");
    const latest = this.state.get(checkpoint.origin);
    if (oldSize !== (latest?.size ?? 0)) {
      return { status: 409, body: `${latest?.size ?? 0}\n`, contentType: "text/x.tlog.size", reason: "old size is not the latest cosigned size" };
    }
    if (checkpoint.size === 0 && checkpoint.root !== EMPTY_ROOT) return refuse(422, "an empty tree has the wrong root");
    const consistent = latest === undefined || oldSize === 0
      ? proof.length === 0
      : verifyConsistency(oldSize, checkpoint.size, hexToBytes(latest.root), hexToBytes(checkpoint.root), proof as Uint8Array[]);
    if (!consistent) return refuse(422, "not consistent with the checkpoint already cosigned");
    const state = { size: checkpoint.size, root: checkpoint.root };
    await this.options.persist?.(checkpoint.origin, state);
    this.state.set(checkpoint.origin, state);
    return { status: 200, body: cosign(note.text, this.name, this.keys.secretKey, Math.floor(this.options.clock())), contentType: "text/plain; charset=utf-8" };
  }
}
