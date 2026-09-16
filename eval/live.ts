import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, it } from "vitest";
import { liveOptions } from "../smoke/live-options.js";
import { usageDirectory } from "../src/usage.js";
import { scenarios } from "./scenarios.js";
import { evaluateScenario, EvalFailure } from "./fixture.js";
// @ts-expect-error Node launcher has no declarations.
import { evalSelection } from "./run.mjs";

if (process.env.SESH_EVAL_LIVE_CONFIRMED !== "1")
  throw new Error("Use pnpm test:eval:live to opt in.");
const { selected, sandboxHome } = await liveOptions();
const selection = evalSelection([
  "--harness",
  selected.join(","),
  "--scenario",
  process.env.SESH_EVAL_SCENARIOS ?? "",
  "--trials",
  process.env.SESH_EVAL_TRIALS ?? "1",
]);
const runId = process.env.SESH_SMOKE_USAGE_RUN_ID;
if (!runId || !/^[a-zA-Z0-9_-]{1,100}$/.test(runId))
  throw new Error("Missing eval usage run ID; use the live launcher.");
const directory = join(usageDirectory(), "eval-results");
await mkdir(directory, { recursive: true, mode: 0o700 });
const results: {
  scenario: number;
  name: string;
  harness: string;
  trial: number;
  status: "passed" | "failed";
  durationMs: number;
  failurePhase: string | null;
  expected: "review" | "resolved";
}[] = [];
const cases = selected.flatMap((harness) =>
  scenarios
    .filter((s) => selection.scenarios.includes(String(s.id)))
    .flatMap((scenario) =>
      Array.from({ length: selection.trials }, (_, index) => ({
        harness,
        scenario,
        trial: index + 1,
      })),
    ),
);
async function persist() {
  const temporary = join(directory, `${runId}.tmp`);
  await writeFile(
    temporary,
    JSON.stringify(
      {
        version: 1,
        runId,
        planned: cases.length,
        completed: results.length,
        results,
      },
      null,
      2,
    ) + "\n",
    { mode: 0o600 },
  );
  await rename(temporary, join(directory, `${runId}.json`));
}
await persist();
it.each(cases)(
  "$harness scenario $scenario.id ($scenario.name), trial $trial",
  async ({ harness, scenario, trial }) => {
    const start = Date.now();
    let status: "passed" | "failed" = "failed";
    let failurePhase: string | null = null;
    try {
      await evaluateScenario(scenario, {
        harness,
        live: true,
        ...(harness === "codex" || !sandboxHome
          ? {}
          : { liveHome: sandboxHome }),
      });
      status = "passed";
    } catch (error) {
      failurePhase =
        error instanceof EvalFailure ? error.phase : "evaluation setup";
      throw new Error(
        `Eval ${scenario.id} (${scenario.name}) failed for ${harness} during ${failurePhase}; provider output and repository contents suppressed.`,
      );
    } finally {
      results.push({
        scenario: scenario.id,
        name: scenario.name,
        harness,
        trial,
        status,
        durationMs: Date.now() - start,
        failurePhase,
        expected: scenario.review ? "review" : "resolved",
      });
      await persist();
    }
  },
);
afterAll(() => {
  for (const harness of selected) {
    const completed = results.filter((r) => r.harness === harness);
    process.stdout.write(
      `Eval ${harness}: ${completed.filter((r) => r.status === "passed").length}/${completed.length} passed; ${cases.filter((r) => r.harness === harness).length} planned.\n`,
    );
  }
  process.stdout.write(`Eval results: ${join(directory, `${runId}.json`)}\n`);
});
