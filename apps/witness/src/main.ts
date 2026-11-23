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
 *   MATTERING_COSIGNERS  witness only: comma-separated key=url pairs
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Cosigner, QUICKNET, generateKeyPair, type Cosignature } from "@mattering/core";
import { DEFAULT_RELAYS, drandSource } from "@mattering/core/drand-http";
import { httpCosign } from "./client.ts";
import { cosignerServer, witnessServer } from "./http.ts";
import { WitnessService } from "./service.ts";

const mode = process.argv[2] ?? "witness";
const relays = process.env.MATTERING_RELAYS?.split(",").filter(Boolean) ?? DEFAULT_RELAYS;
const source = drandSource(QUICKNET, relays);

if (mode === "witness") {
  const dataDir = process.env.MATTERING_DATA ?? "./witness-data";
  const urls = Object.fromEntries((process.env.MATTERING_COSIGNERS ?? "").split(",").filter(Boolean).map((pair) => pair.split("=") as [string, string]));
  const service = new WitnessService({ dataDir, source, cosign: httpCosign(urls) });
  const port = Number(process.env.PORT ?? 8787);
  witnessServer(service).listen(port, () => {
    console.log(`mattering witness ${service.publicKey}`);
    console.log(`listening on :${port}, state in ${dataDir}, beacon drand quicknet`);
    console.log("experimental; not security reviewed");
  });
  setInterval(() => void service.tick().catch((error: Error) => console.error(`tick: ${error.message}`)), QUICKNET.period * 1000);
} else if (mode === "cosigner") {
  const dataDir = process.env.MATTERING_DATA ?? "./cosigner-data";
  mkdirSync(dataDir, { recursive: true });
  const keyFile = join(dataDir, "cosigner-key.json");
  const signedFile = join(dataDir, "cosigned.jsonl");
  const keys = existsSync(keyFile) ? generateKeyPair((JSON.parse(readFileSync(keyFile, "utf8")) as { secretKey: string }).secretKey) : generateKeyPair();
  if (!existsSync(keyFile)) writeFileSync(keyFile, JSON.stringify({ secretKey: keys.secretKey }) + "\n", { mode: 0o600 });
  const signed: [string, Cosignature][] = existsSync(signedFile) ? readFileSync(signedFile, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as [string, Cosignature]) : [];
  const cosigner = new Cosigner(source, keys.secretKey, signed);
  let saved = signed.length;
  const port = Number(process.env.PORT ?? 8788);
  cosignerServer(cosigner, () => {
    // Persist what was signed, so a restart cannot be used to obtain a second, different cosignature.
    const all = [...cosigner.signed.entries()];
    for (const entry of all.slice(saved)) appendFileSync(signedFile, JSON.stringify(entry) + "\n");
    saved = all.length;
  }).listen(port, () => {
    console.log(`mattering cosigner ${cosigner.publicKey}`);
    console.log(`listening on :${port}, state in ${dataDir}, beacon drand quicknet`);
    console.log("experimental; not security reviewed");
  });
} else {
  console.error("usage: main.ts witness|cosigner");
  process.exit(1);
}
