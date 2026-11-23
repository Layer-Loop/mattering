/**
 * The only file that touches drand's tlock-js. Mattering does not implement
 * time-lock encryption; it calls `timelockEncrypt` / `timelockDecrypt`.
 */
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils";
import type { ChainClient, ChainInfo } from "drand-client";
import { Buffer as TlockBuffer, timelockDecrypt, timelockEncrypt } from "tlock-js";
import type { BeaconInfo, Release } from "./beacon.ts";

function chainInfo(info: BeaconInfo, genesisTime: number, period: number): ChainInfo {
  return {
    public_key: info.publicKey,
    period,
    genesis_time: genesisTime,
    hash: info.chainHash,
    groupHash: "",
    schemeID: info.scheme,
    metadata: { beaconID: "mattering-static" },
  };
}

/** A client that never touches the network: it knows the chain and at most one round. */
function staticClient(info: ChainInfo, release?: Release): ChainClient {
  return {
    options: {
      disableBeaconVerification: false,
      noCache: true,
      chainVerificationParams: { chainHash: info.hash, publicKey: info.public_key },
    },
    chain: () => ({ baseUrl: "static:", info: async () => info }),
    latest: async () => {
      throw new Error("static client has no latest round");
    },
    get: async (round: number) => {
      if (!release || round !== release.round) throw new Error(`static client has no round ${round}`);
      return {
        round: release.round,
        signature: release.signature,
        randomness: bytesToHex(sha256(hexToBytes(release.signature))),
      };
    },
  };
}

export async function tlockEncrypt(info: BeaconInfo, round: number, plaintext: Uint8Array): Promise<string> {
  const client = staticClient(chainInfo(info, info.genesisTime, info.period));
  return timelockEncrypt(round, TlockBuffer.from(plaintext), client);
}

// tlock-js 0.9.0 prints the beacon to stdout on every decrypt. Silence it for
// the duration of the call, one call at a time, so CLI output stays clean.
let queue: Promise<unknown> = Promise.resolve();
function quietly<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(async () => {
    const original = console.log;
    console.log = () => {};
    try {
      return await fn();
    } finally {
      console.log = original;
    }
  });
  queue = run.catch(() => {});
  return run;
}

/**
 * Decrypt with one round's signature. tlock-js also refuses by wall clock when
 * the round's scheduled time is in the future; that check is not a security
 * property, so the chain's schedule is replaced with one that is always past.
 * Whether the ciphertext opens is decided by the signature alone. drand-client
 * verifies that signature against `info.publicKey` again inside this call.
 */
export async function tlockDecrypt(info: BeaconInfo, release: Release, ciphertext: string): Promise<Uint8Array> {
  const client = staticClient(chainInfo(info, 0, 1), release);
  const out = await quietly(() => timelockDecrypt(ciphertext, client));
  return new Uint8Array(out);
}
