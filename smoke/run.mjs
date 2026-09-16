import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { harnessInfo } from "../scripts/harness-metadata.mjs";

const harnesses = Object.keys(harnessInfo);
const root = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(import.meta.url);
const help = `Usage: pnpm test:smoke:live --harness codex[,claude,...] | --all

  --harness <names>  Select comma-separated harnesses (${harnesses.join(", ")}).
  --all              Select every supported harness.
  --help             Show help without building or making AI calls.

Explicit flags override SESH_SMOKE_HARNESSES; without flags it remains supported.
Running this live command explicitly opts in to real AI calls.
Codex uses your existing login; no separate home or budget flag is required.
Other harnesses require SESH_SMOKE_HOME and SESH_SMOKE_BUDGET_CONFIRMED=1.
See smoke/README.md.
`;

export function selection(args, env = process.env) {
  const { values } = parseArgs({
    args,
    options: {
      harness: { type: "string", multiple: true },
      all: { type: "boolean" },
      help: { type: "boolean" },
    },
    allowPositionals: false,
  });
  if (values.help) return { help: true };
  if (values.all && values.harness)
    throw new Error("Choose --harness or --all, not both.");
  const selected = values.all
    ? harnesses
    : (values.harness ?? [env.SESH_SMOKE_HARNESSES ?? ""]).flatMap((value) =>
        value.split(",").map((name) => name.trim()),
      );
  if (
    selected.some((name) => !harnesses.includes(name)) ||
    new Set(selected).size !== selected.length
  )
    throw new Error(
      `Select unique harness names with --harness ${harnesses.join(",")} or --all.`,
    );
  return { harnesses: selected };
}

export async function main(
  args,
  env = process.env,
  execute = spawnSync,
  prepare = async (environment) => {
    const { prepareUsageRun } = await import("../dist/usage.js");
    return prepareUsageRun(environment);
  },
  suite = { config: "smoke/vitest.config.ts", env: {} },
) {
  const selected = selection(args, env);
  if (selected.help) {
    process.stdout.write(help);
    return 0;
  }
  const options = {
    cwd: root,
    env: {
      ...env,
      SESH_SMOKE_HARNESSES: selected.harnesses.join(","),
      SESH_SMOKE_LIVE_CONFIRMED: "1",
      ...suite.env,
    },
    stdio: "inherit",
  };
  const build = execute(
    process.execPath,
    [require.resolve("typescript/bin/tsc"), "-p", "tsconfig.build.json"],
    options,
  );
  if (build.error) throw new Error("Could not start the smoke test build.");
  if (build.status !== 0) return build.status ?? 1;
  const usage = await prepare(env);
  Object.assign(options.env, usage.env);
  try {
    const result = execute(
      process.execPath,
      [require.resolve("vitest/vitest.mjs"), "run", "--config", suite.config],
      options,
    );
    if (result.error) throw new Error("Could not start the live smoke tests.");
    return result.status ?? 1;
  } finally {
    try {
      await usage.report();
    } catch {
      process.stderr.write(
        "WARNING: Could not read token usage history; usage is unknown.\n",
      );
    }
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
