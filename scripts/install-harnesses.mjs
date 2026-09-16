import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { harnessInfo, selectHarnesses } from "./harness-metadata.mjs";

const project = fileURLToPath(new URL("../", import.meta.url));
const home = process.env.HOME ?? homedir();
const args = process.argv.slice(2);
const custom = args.length === 1 && !args[0].startsWith("-") ? args[0] : undefined;
const selected = custom ? ["codex"] : selectHarnesses(args, home);
// Standard installation shares setup's compatibility checks, receipts, enrollment
// serialization, and customized-content preservation. Keep only the historical
// skill-only/custom-path form as a conservative bootstrap operation.
if (!custom && args.length) {
  if (selected.length) try { execFileSync(process.execPath, [join(project, "dist/cli.js"), "setup", ...selected.flatMap(name => ["--harness", name]), "--yes"], {
    env: { ...process.env, HOME: home }, stdio: "inherit",
  }); } catch (error) { if (typeof error.status === "number") process.exit(error.status); throw error; }
  else console.log("No installed harness workflows to refresh.");
  process.exit(0);
}
async function install(source, target, transform = (text) => text) {
  const contents = transform(await readFile(source, "utf8"));
  if (existsSync(target) && await readFile(target,"utf8") !== contents)
    throw new Error(`Preserving customized or unrecognized legacy skill: ${target}. Use seshx setup for receipt-aware upgrades, or back up and move the file first.`);
  await mkdir(dirname(target), { recursive: true });
  const temporary = `${target}.sesh-${process.pid}`;
  await writeFile(temporary, contents, { mode: 0o644 });
  await rename(temporary, target);
}
for (const name of selected) {
  const info = harnessInfo[name];
  const target = custom ?? join(home, info.skillDirectory, "skills", "sesh-integrator-workflow");
  const source = join(project, "skill", "sesh-integrator-workflow");
  for (const file of ["SKILL.md", ...info.metadataFiles]) await install(join(source, file), join(target, file));
  console.log(`Installed sesh-integrator-workflow at ${target}`);
  if (!custom && args.length) execFileSync(process.execPath, [join(project, "scripts/sync-managed-guidance.mjs"), "--harness", name], {
    env: { ...process.env, PARALLEL_INTEGRATOR_DOCTOR_HOME: home }, stdio: "inherit",
  });
  // CLI compatibility aliases do not require duplicate workflow skills.

}
if (!selected.length) console.log("No installed harness workflows to refresh.");
