import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";

const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
if (existsSync(cli)) {
  const result = spawnSync(process.execPath, [cli, "installation-readiness"], {
    stdio: "inherit",
    timeout: 30_000,
  });
  if (result.error || result.status !== 0)
    console.warn("Automatic integration readiness could not be established. Run seshx installation-readiness in the intended agent environment; CLI installation can continue.");
}
console.log("\nRun seshx setup to select and install harness integrations.\n");
