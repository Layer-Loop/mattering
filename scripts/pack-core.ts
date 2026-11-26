/**
 * Builds @mattering/core as it would be published to npm, packs it, and
 * checks the packed tarball works in an empty project:
 *
 *   npm run pack:core
 *
 * Writes `.npm/core/` (the package) and `.npm/mattering-core-<version>.tgz`.
 * In this repository the workspace uses the TypeScript source directly; only
 * the published copy is compiled. Publishing is a separate, deliberate step:
 *
 *   npm publish .npm/core --access public
 */
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(root, "packages", "core");
const out = join(root, ".npm", "core");
const run = (cmd: string, args: string[], cwd = root): string => execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });

const manifest = JSON.parse(readFileSync(join(source, "package.json"), "utf8")) as { version: string; exports: Record<string, string>; dependencies: Record<string, string> };

rmSync(out, { recursive: true, force: true });
run("npx", ["tsc", "-p", join(source, "tsconfig.build.json")]);

// Each entry point, from its TypeScript source to the compiled file and its types.
const exports: Record<string, { types: string; default: string }> = {};
for (const [entry, file] of Object.entries(manifest.exports)) {
  const base = file.replace(/^\.\/src\//, "./dist/").replace(/\.ts$/, "");
  exports[entry] = { types: `${base}.d.ts`, default: `${base}.js` };
}
const published = {
  name: "@mattering/core",
  version: manifest.version,
  description: "Seal data until a future time, locked to drand's public beacon, and let anyone check the seal and the opening. Proof of concept, not security reviewed.",
  keywords: ["time-lock", "tlock", "drand", "sealed-bid", "commitment", "transparency-log", "verifiable"],
  license: "MIT",
  author: "Layer & Loop Ltd",
  homepage: "https://mattering.ai",
  repository: { type: "git", url: "git+https://github.com/Layer-Loop/mattering.git", directory: "packages/core" },
  bugs: "https://github.com/Layer-Loop/mattering/issues",
  type: "module",
  engines: { node: ">=22" },
  sideEffects: false,
  exports,
  files: ["dist", "README.md", "LICENSE"],
  dependencies: manifest.dependencies,
};
writeFileSync(join(out, "package.json"), JSON.stringify(published, null, 2) + "\n");
cpSync(join(source, "README.md"), join(out, "README.md"));
cpSync(join(root, "LICENSE"), join(out, "LICENSE"));

mkdirSync(join(root, ".npm"), { recursive: true });
const tarball = run("npm", ["pack", "--pack-destination", join(root, ".npm"), "--silent"], out).trim().split("\n").at(-1)!;
const tarballPath = join(root, ".npm", tarball);
console.log(`packed ${tarballPath}`);
console.log(run("npm", ["pack", "--dry-run"], out).trim() || "(dry run listed above)");

// Install the tarball into an empty project and use it, as a stranger would.
const trial = mkdtempSync(join(tmpdir(), "mattering-core-trial-"));
try {
  writeFileSync(join(trial, "package.json"), JSON.stringify({ name: "trial", private: true, type: "module" }));
  run("npm", ["install", "--silent", "--no-audit", "--no-fund", tarballPath], trial);
  writeFileSync(
    join(trial, "trial.mjs"),
    `import { seal, open, verifyEnvelope, MatteringError } from "@mattering/core";
import { TestBeacon } from "@mattering/core/testing";
import { generateRecipientKeys, sealTo, openAs } from "@mattering/core/recipients";
import { verifyNegotiationStep } from "@mattering/core/negotiation";
import { fetchRelease } from "@mattering/core/drand-http";
const beacon = new TestBeacon();
const policy = { acceptedBeacons: [beacon.info] };
const payload = new TextEncoder().encode("from the packed package");
const sealed = await seal({ payload, round: 7, beacon: beacon.info });
if (!verifyEnvelope(sealed, policy).ok) throw new Error("does not verify");
try { await open(sealed, beacon.release(6), policy); throw new Error("opened early"); } catch (e) { if (!(e instanceof MatteringError)) throw e; }
if (new TextDecoder().decode(await open(sealed, beacon.release(7), policy)) !== "from the packed package") throw new Error("wrong payload");
const me = await generateRecipientKeys();
const toMe = await sealTo({ payload, round: 7, beacon: beacon.info, recipients: [me.recipient] });
if (new TextDecoder().decode(await openAs(toMe, beacon.release(7), me.identity, policy)) !== "from the packed package") throw new Error("recipients");
if (typeof verifyNegotiationStep !== "function" || typeof fetchRelease !== "function") throw new Error("entry points");
console.log("trial: sealed, refused early, opened on time, sealed to a recipient and opened as it");
`,
  );
  console.log(run("node", ["trial.mjs"], trial).trim());
  // The types resolve for a TypeScript user too.
  writeFileSync(join(trial, "types.ts"), `import { seal, type Envelope } from "@mattering/core";\nimport type { StepInputs } from "@mattering/core/negotiation";\nconst e: Promise<Envelope> = seal({ payload: new Uint8Array(1), round: 1 });\nexport type T = StepInputs;\nvoid e;\n`);
  writeFileSync(join(trial, "tsconfig.json"), JSON.stringify({ compilerOptions: { noEmit: true, strict: true, module: "nodenext", moduleResolution: "nodenext", target: "es2022", lib: ["es2024", "dom"], types: [] }, include: ["types.ts"] }));
  run(join(root, "node_modules", ".bin", "tsc"), ["-p", trial], trial);
  console.log("trial: the types resolve");
} finally {
  rmSync(trial, { recursive: true, force: true });
}
