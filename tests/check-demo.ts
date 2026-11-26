/** The command line's offline check of a demo's downloaded evidence, as the room tests run it. */
import { spawnSync } from "node:child_process";
import { join } from "node:path";

export function checkDemo(...args: string[]): { status: number; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, ["--import", "tsx", join(import.meta.dirname, "..", "apps", "cli", "src", "main.ts"), "check-demo", ...args], { encoding: "utf8" });
  return { status: r.status ?? -1, stdout: r.stdout, stderr: r.stderr };
}
