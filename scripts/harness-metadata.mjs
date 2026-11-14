import { readFileSync } from "node:fs";
import { join } from "node:path";

export const harnessInfo = JSON.parse(readFileSync(new URL("../harnesses.json", import.meta.url), "utf8"));
export const harnesses = Object.keys(harnessInfo).filter((name) => !harnessInfo[name].legacy);
// Setup enrolls a harness by writing the managed block to its global
// instructions; the shared skill alone does not enroll one (see src/harness.ts).
function installed(name, home) {
  const info = harnessInfo[name];
  try {
    return readFileSync(join(home, info.directory, info.instructions), "utf8").includes("<!-- codex-handoff:managed:start -->");
  } catch {
    return false;
  }
}
export function selectHarnesses(args, home) {
  if (args.length === 1 && args[0] === "--installed") {
    return harnesses.filter((name) => installed(name, home));
  }
  if (!args.length) return ["codex"]; // compatibility default, not an exclusive capability
  if (args.length !== 2 || args[0] !== "--harness" || !harnesses.includes(args[1]))
    throw new Error(`Expected --installed or --harness ${harnesses.join("|")}`);
  return [args[1]];
}
