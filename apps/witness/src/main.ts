/**
 * Run a witness, or a cosigner, against drand quicknet.
 *
 *   npm run witness             a witness and registry on PORT (default 8787)
 *   npm run cosigner            a cosigner on PORT (default 8788)
 *
 * Environment:
 *   MATTERING_DATA       directory for state and the signing key (default ./witness-data or ./cosigner-data)
 *   PORT                 port to listen on
 *   MATTERING_RELAYS     comma-separated drand relay URLs (default: public relays)
 *   MATTERING_ORIGIN     witness only: the log's origin, such as example.com/log (default: derived from its key)
 *   MATTERING_COSIGNERS  witness only: comma-separated vkey=url pairs, url being the add-checkpoint prefix
 *   MATTERING_NAME       cosigner only: its name in signature lines (default localhost/mattering-cosigner)
 *   MATTERING_LOGS       cosigner only: comma-separated verifier keys of the logs it cosigns for
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Cosigner, QUICKNET, generateKeyPair, systemClock, type CosignedState } from "@mattering/core";
import { DEFAULT_RELAYS, drandSource } from "@mattering/core/drand-http";
import { httpCosign } from "./client.ts";
import { cosignerServer, witnessServer } from "./http.ts";
import { fileStore } from "./file-store.ts";
import { WitnessService } from "./service.ts";

const mode = process.argv[2] ?? "witness";
const relays = process.env.MATTERING_RELAYS?.split(",").filter(Boolean) ?? DEFAULT_RELAYS;
const source = drandSource(QUICKNET, relays);
const list = (name: string): string[] => (process.env[name] ?? "").split(",").map((s) => s.trim()).filter(Boolean);

if (mode === "witness") {
  const dataDir = process.env.MATTERING_DATA ?? "./witness-data";
  // A vkey never contains "=" (its key is 33 bytes, so no base64 padding); the first "=" separates the URL.
  const urls = Object.fromEntries(list("MATTERING_COSIGNERS").map((pair) => [pair.slice(0, pair.indexOf("=")), pair.slice(pair.indexOf("=") + 1)]));
  const service = await WitnessService.open({ store: fileStore(dataDir), source, origin: process.env.MATTERING_ORIGIN, cosign: httpCosign(urls) });
  const port = Number(process.env.PORT ?? 8787);
  witnessServer(service).listen(port, () => {
    console.log(`mattering witness ${service.publicKey}`);
    console.log(`log ${service.vkey}`);
    console.log(`listening on :${port}, state in ${dataDir}, beacon drand quicknet`);
    console.log("experimental; not security reviewed");
  });
  setInterval(() => void service.tick().catch((error: Error) => console.error(`tick: ${error.message}`)), QUICKNET.period * 1000);
} else if (mode === "cosigner") {
  const dataDir = process.env.MATTERING_DATA ?? "./cosigner-data";
  mkdirSync(dataDir, { recursive: true });
  const keyFile = join(dataDir, "cosigner-key.json");
  const stateFile = join(dataDir, "cosigned.json");
  const keys = existsSync(keyFile) ? generateKeyPair((JSON.parse(readFileSync(keyFile, "utf8")) as { secretKey: string }).secretKey) : generateKeyPair();
  if (!existsSync(keyFile)) writeFileSync(keyFile, JSON.stringify({ secretKey: keys.secretKey }) + "\n", { mode: 0o600 });
  const state: Record<string, CosignedState> = existsSync(stateFile) ? (JSON.parse(readFileSync(stateFile, "utf8")) as Record<string, CosignedState>) : {};
  const cosigner = new Cosigner({
    name: process.env.MATTERING_NAME ?? "localhost/mattering-cosigner",
    logs: list("MATTERING_LOGS"),
    clock: systemClock,
    secretKey: keys.secretKey,
    state,
    // Written before the cosignature is returned, so a restart cannot be used to get a fork cosigned.
    persist: (origin, latest) => {
      state[origin] = latest;
      writeFileSync(stateFile + ".tmp", JSON.stringify(state, null, 2) + "\n");
      renameSync(stateFile + ".tmp", stateFile);
    },
  });
  const port = Number(process.env.PORT ?? 8788);
  cosignerServer(cosigner).listen(port, () => {
    console.log(`mattering cosigner ${cosigner.vkey}`);
    console.log(`listening on :${port}, state in ${dataDir}, cosigning for ${list("MATTERING_LOGS").length} log(s)`);
    console.log("experimental; not security reviewed");
  });
} else {
  console.error("usage: main.ts witness|cosigner");
  process.exit(1);
}
