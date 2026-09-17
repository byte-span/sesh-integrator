import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const harnessInfo = JSON.parse(readFileSync(new URL("../harnesses.json", import.meta.url), "utf8"));
export const harnesses = Object.keys(harnessInfo).filter((name) => !harnessInfo[name].legacy);
export function selectHarnesses(args, home) {
  if (args.length === 1 && args[0] === "--installed") {
    return harnesses.filter((name) => existsSync(join(home, harnessInfo[name].skillDirectory, "skills", "sesh-integrator-workflow", "SKILL.md")));
  }
  if (!args.length) return ["codex"]; // compatibility default, not an exclusive capability
  if (args.length !== 2 || args[0] !== "--harness" || !harnesses.includes(args[1]))
    throw new Error(`Expected --installed or --harness ${harnesses.join("|")}`);
  return [args[1]];
}
