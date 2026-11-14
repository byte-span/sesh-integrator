import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { selectHarnesses } from "./harness-metadata.mjs";

const project = fileURLToPath(new URL("../", import.meta.url));
const home = process.env.HOME ?? homedir();
const args = process.argv.slice(2);
const custom = args.length === 1 && !args[0].startsWith("-") ? args[0] : undefined;
// Standard installation shares setup's compatibility checks, receipts, enrollment
// serialization, and customized-content preservation. Keep only the historical
// skill-only/custom-path form as a conservative bootstrap operation.
if (!custom && args.length) {
  const selected = selectHarnesses(args, home);
  if (selected.length) try { execFileSync(process.execPath, [join(project, "dist/cli.js"), "setup", ...selected.flatMap(name => ["--harness", name]), "--yes"], {
    env: { ...process.env, HOME: home }, stdio: "inherit",
  }); } catch (error) { if (typeof error.status === "number") process.exit(error.status); throw error; }
  else console.log("No installed harness workflows to refresh.");
  process.exit(0);
}
// Both bootstrap forms install through the skill contract: stamped copies,
// and copies seshx did not install are never overwritten.
const skill = await import(new URL("../dist/skill.js", import.meta.url));
const rows = custom
  ? [skill.installWorkflowSkillAt(resolve(custom))]
  : // No arguments keeps the Codex default (~/.agents/skills) and also fills
    // every other detected harness directory, as `seshx skill install` does.
    skill.installWorkflowSkill({ ensureTargets: ["agents"] });
skill.printInstall(rows);
if (rows.some((row) => row.blocked)) process.exitCode = 1;
// CLI compatibility aliases do not require duplicate workflow skills.
