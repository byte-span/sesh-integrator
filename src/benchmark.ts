import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { observeGitState } from "./git.js";
import { run, runChecked } from "./process.js";

interface BenchmarkSummary {
  scenario: string;
  medianMs: number;
  p95Ms: number;
  maxMs: number;
  budgetMs: number;
}

const BASE_BUDGETS: Record<string, number> = {
  "small-clean": 500,
  "large-clean": 2000,
  "large-dirty": 2500,
  conflict: 500,
  concurrent: 3000,
};

export async function benchmarkCommand(options: {
  runs: number;
  json: boolean;
  check: boolean;
}): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "parallel-integrator-benchmark-"));
  try {
    const repository = join(root, "repo");
    await initializeRepository(repository);
    const results: BenchmarkSummary[] = [];
    results.push(
      await benchmarkScenario("small-clean", options.runs, async () => {
        await observeGitState(repository);
      }),
    );

    await addLargeFixture(repository);
    results.push(
      await benchmarkScenario("large-clean", options.runs, async () => {
        await observeGitState(repository);
      }),
    );
    await dirtyLargeFixture(repository);
    results.push(
      await benchmarkScenario("large-dirty", options.runs, async () => {
        await observeGitState(repository);
      }),
    );
    results.push(
      await benchmarkScenario("conflict", options.runs, async () => {
        const result = await run(
          "git",
          ["merge-tree", "--write-tree", "main", "benchmark-conflict"],
          { cwd: repository },
        );
        if (result.code > 1) {
          throw new Error(`git merge-tree failed: ${result.stderr.trim()}`);
        }
      }),
    );
    results.push(
      await benchmarkScenario("concurrent", options.runs, async () => {
        await Promise.all([
          observeGitState(repository),
          observeGitState(repository),
        ]);
      }),
    );

    if (options.json) {
      process.stdout.write(
        `${JSON.stringify({ version: 1, results }, null, 2)}\n`,
      );
    } else {
      process.stdout.write(
        "Scenario           median       p95       max    budget\n",
      );
      for (const result of results) {
        process.stdout.write(
          `${result.scenario.padEnd(18)} ${formatMs(result.medianMs).padStart(8)} ${formatMs(result.p95Ms).padStart(9)} ${formatMs(result.maxMs).padStart(9)} ${formatMs(result.budgetMs).padStart(9)}\n`,
        );
      }
      process.stdout.write(
        "Times measure parallel-integrator/Git overhead only; configured setup and validation commands are excluded.\n",
      );
    }
    if (options.check) {
      const failures = results.filter(
        (result) => result.p95Ms > result.budgetMs,
      );
      if (failures.length > 0) {
        throw new Error(
          `Benchmark regression budget exceeded: ${failures.map((result) => `${result.scenario} p95 ${formatMs(result.p95Ms)} > ${formatMs(result.budgetMs)}`).join(", ")}`,
        );
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function benchmarkScenario(
  scenario: string,
  runs: number,
  action: () => Promise<void>,
): Promise<BenchmarkSummary> {
  const samples: number[] = [];
  for (let index = 0; index < runs; index += 1) {
    const started = process.hrtime.bigint();
    await action();
    samples.push(Number(process.hrtime.bigint() - started) / 1_000_000);
  }
  samples.sort((left, right) => left - right);
  const scale = Number(
    process.env.PARALLEL_INTEGRATOR_BENCHMARK_BUDGET_SCALE ?? "1",
  );
  return {
    scenario,
    medianMs: percentile(samples, 0.5),
    p95Ms: percentile(samples, 0.95),
    maxMs: samples.at(-1) ?? 0,
    budgetMs: BASE_BUDGETS[scenario]! * (Number.isFinite(scale) ? scale : 1),
  };
}

async function initializeRepository(repository: string): Promise<void> {
  await mkdir(repository, { recursive: true });
  await runChecked("git", ["init", "-b", "main"], repository);
  await runChecked("git", ["config", "user.name", "Benchmark"], repository);
  await runChecked(
    "git",
    ["config", "user.email", "benchmark@example.com"],
    repository,
  );
  await runChecked("git", ["config", "commit.gpgSign", "false"], repository);
  await writeFile(join(repository, "conflict.txt"), "main\n");
  await runChecked("git", ["add", "conflict.txt"], repository);
  await runChecked("git", ["commit", "-m", "base"], repository);
  await runChecked("git", ["switch", "-c", "benchmark-conflict"], repository);
  await writeFile(join(repository, "conflict.txt"), "branch\n");
  await runChecked("git", ["commit", "-am", "conflict branch"], repository);
  await runChecked("git", ["switch", "main"], repository);
  await writeFile(join(repository, "conflict.txt"), "changed main\n");
  await runChecked("git", ["commit", "-am", "conflict main"], repository);
}

async function addLargeFixture(repository: string): Promise<void> {
  const directory = join(repository, "fixture");
  await mkdir(directory);
  await Promise.all(
    Array.from({ length: 1000 }, (_, index) =>
      writeFile(
        join(directory, `${index.toString().padStart(4, "0")}.txt`),
        `${index}\n`,
      ),
    ),
  );
  await runChecked("git", ["add", "fixture"], repository);
  await runChecked("git", ["commit", "-m", "large fixture"], repository);
}

async function dirtyLargeFixture(repository: string): Promise<void> {
  await Promise.all(
    Array.from({ length: 100 }, (_, index) =>
      writeFile(
        join(repository, "fixture", `${index.toString().padStart(4, "0")}.txt`),
        `changed ${index}\n`,
      ),
    ),
  );
}

function percentile(samples: number[], percentileValue: number): number {
  const index = Math.min(
    samples.length - 1,
    Math.max(0, Math.ceil(samples.length * percentileValue) - 1),
  );
  return samples[index] ?? 0;
}

function formatMs(value: number): string {
  return value >= 1000
    ? `${(value / 1000).toFixed(2)}s`
    : `${value.toFixed(1)}ms`;
}
