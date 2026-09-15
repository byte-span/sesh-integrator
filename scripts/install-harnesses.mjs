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
async function install(source, target, transform = (text) => text) {
  await mkdir(dirname(target), { recursive: true });
  const temporary = `${target}.sesh-${process.pid}`;
  await writeFile(temporary, transform(await readFile(source, "utf8")), { mode: 0o644 });
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
  // Refresh historical aliases wherever they were installed, without creating
  // aliases for new installations or removing customized supporting resources.
  const legacy = join(home, info.skillDirectory, "skills", "parallel-integrator-workflow");
  if (!custom && existsSync(legacy)) {
    for (const file of ["SKILL.md", ...info.metadataFiles]) await install(join(source, file), join(legacy, file), (text) => text.replaceAll("sesh-integrator-workflow", "parallel-integrator-workflow"));
  }
}
if (!selected.length) console.log("No installed harness workflows to refresh.");
