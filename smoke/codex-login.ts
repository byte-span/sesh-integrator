import { writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** Paths only: never inspect, copy, or embed authentication file contents. */
export function codexLoginPaths(env = process.env, userHome = homedir()) {
  const home = env.SESH_SMOKE_HOME || userHome;
  return {
    HOME: home,
    CODEX_HOME: env.SESH_SMOKE_HOME
      ? join(home, ".codex")
      : resolve(env.CODEX_HOME || join(home, ".codex")),
    XDG_CONFIG_HOME: env.SESH_SMOKE_HOME
      ? join(home, ".config")
      : env.XDG_CONFIG_HOME || join(home, ".config"),
  };
}

/** Use the real login for Codex itself, while the integrator keeps a test home. */
export async function createCodexLoginCommand(
  root: string,
  paths = codexLoginPaths(),
) {
  const executable = join(root, "codex-login.mjs");
  await writeFile(
    executable,
    `#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
const result = spawnSync('codex', process.argv.slice(2), {
  env: { ...process.env, ...${JSON.stringify(paths)} },
  stdio: 'inherit',
});
if (result.error) process.stderr.write('Could not start Codex for the live smoke test.\\n');
process.exitCode = result.status ?? 1;
`,
    { mode: 0o700 },
  );
  return executable;
}
