import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { main as launch, selection } from "../smoke/run.mjs";

export function evalSelection(args, env = process.env) {
  const { values } = parseArgs({
    args,
    options: {
      harness: { type: "string", multiple: true },
      all: { type: "boolean" },
      scenario: { type: "string", multiple: true },
      trials: { type: "string" },
      help: { type: "boolean" },
    },
    allowPositionals: false,
  });
  if (values.help) return { help: true };
  const harnessArgs = values.all
    ? ["--all"]
    : (values.harness ?? []).flatMap((h) => ["--harness", h]);
  if (values.all && values.harness)
    throw new Error("Choose --all or --harness, not both.");
  const harnesses = selection(harnessArgs, env).harnesses;
  const scenarios = values.scenario
    ? values.scenario.flatMap((s) => s.split(",").map((n) => n.trim()))
    : Array.from({ length: 12 }, (_, i) => String(i + 1));
  if (
    scenarios.some((s) => !/^(?:[1-9]|1[0-2])$/.test(s)) ||
    new Set(scenarios).size !== scenarios.length
  )
    throw new Error("Select unique scenario numbers from 1 to 12.");
  const trials = values.trials ?? "1";
  if (!/^(?:[1-9]|10)$/.test(trials)) throw new Error("Choose 1–10 trials.");
  return { harnesses, scenarios, trials: Number(trials) };
}
export async function main(args, env = process.env, run = launch) {
  const selected = evalSelection(args, env);
  if (selected.help) {
    process.stdout
      .write(`Usage: pnpm test:eval:live --harness codex[,claude,...] | --all
  --scenario 1,2,...  Select cases 1–12 (default: all).
  --trials 1         Repeat each case 1–10 times (default: 1).
  --help             Show help without building or calling providers.
Explicitly opts into real AI calls. Uses smoke login and token-report settings.
Results: <SESH_SMOKE_USAGE_DIR>/eval-results/<run-id>.json (default usage directory if unset).
See eval/README.md for cases, grading, and limitations.
`);
    return 0;
  }
  return run(
    ["--harness", selected.harnesses.join(",")],
    env,
    undefined,
    undefined,
    {
      config: "eval/vitest.config.ts",
      env: {
        SESH_EVAL_LIVE_CONFIRMED: "1",
        SESH_EVAL_SCENARIOS: selected.scenarios.join(","),
        SESH_EVAL_TRIALS: String(selected.trials),
      },
    },
  );
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
