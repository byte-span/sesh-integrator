// Compare real installed revisions with the candidate; Linux RSS sampling only.
import { spawn, execFileSync } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  readdir,
  rm,
} from "node:fs/promises";
import { tmpdir, availableParallelism, totalmem } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
const [output, baselineDist, currentDist] = process.argv.slice(2);
if (!output || !baselineDist || !currentDist || process.platform !== "linux")
  throw new Error(
    "Usage (Linux): node scripts/benchmark-validation-reuse.mjs report.json pre-queue-dist current-queue-dist",
  );
const root = await mkdtemp(join(tmpdir(), "sesh-reuse-benchmark-"));
const cases = [];
const tsc = resolve("node_modules/typescript/bin/tsc");
const versions = {
  baseline: resolve(baselineDist),
  current: resolve(currentDist),
  candidate: resolve("dist"),
};
try {
  const worktrees = [];
  for (let repoIndex = 0; repoIndex < 2; repoIndex++) {
    const repo = join(root, `repo-${repoIndex}`);
    await mkdir(repo);
    execFileSync("git", ["init", "--quiet", repo]);
    await writeFile(
      join(repo, "input.ts"),
      Array.from(
        { length: 1800 },
        (_, n) =>
          `export interface Row${n} {id:number;name:string;tags:string[]};export const row${n}:Row${n}={id:${n},name:'row',tags:[]};`,
      ).join("\n"),
    );
    execFileSync("git", ["add", "input.ts"], { cwd: repo });
    execFileSync(
      "git",
      [
        "-c",
        "commit.gpgsign=false",
        "-c",
        "user.name=Benchmark",
        "-c",
        "user.email=benchmark@example.invalid",
        "commit",
        "--quiet",
        "-m",
        "fixture",
      ],
      { cwd: repo },
    );
    const tree = execFileSync("git", ["rev-parse", "HEAD^{tree}"], {
      cwd: repo,
      encoding: "utf8",
    }).trim();
    for (let i = 0; i < 2; i++) {
      const cwd = join(root, `worktree-${repoIndex}-${i}`);
      execFileSync(
        "git",
        ["worktree", "add", "--quiet", "--detach", cwd, "HEAD"],
        { cwd: repo },
      );
      worktrees.push({ cwd, tree, gitCommonDir: join(repo, ".git") });
    }
  }
  const workload = join(root, "memory-test.cjs");
  await writeFile(
    workload,
    `const b=Buffer.alloc(96*1024*1024,7);const start=performance.now();let n=0;while(performance.now()-start<500){for(let i=0;i<b.length;i+=4096)n+=b[i];}if(!n)process.exit(1);`,
  );
  for (const scenario of ["independent", "matching"])
    for (let repeat = 0; repeat < 5; repeat++) {
      const modes = ["baseline", "current", "candidate"];
      const offset = repeat % 3;
      for (const mode of [...modes.slice(offset), ...modes.slice(0, offset)]) {
        const queue = join(root, `${scenario}-${repeat}-${mode}`);
        await mkdir(queue);
        // No config: exercise each revision's genuine default.
        const runtime = join(queue, "runtime");
        const started = performance.now();
        let peakBytes = 0;
        let sampling = true;
        const sample = (async () => {
          while (sampling) {
            peakBytes = Math.max(peakBytes, await treeRss(process.pid));
            await new Promise((r) => setTimeout(r, 20));
          }
        })();
        const results = await Promise.all(
          worktrees.map(({ cwd, tree, gitCommonDir }, index) => {
            const commands = [
              [
                process.execPath,
                tsc,
                "--noEmit",
                "--strict",
                "--skipLibCheck",
                "--target",
                "ES2022",
                "input.ts",
              ],
              [process.execPath, workload],
            ];
            const repository = {
              gitCommonDir,
              validationCache: scenario === "matching" ? "repository" : "off",
            };
            const module = (name) =>
              JSON.stringify(pathToFileURL(join(versions[mode], name)).href);
            const source = `import {runValidation} from ${module("process.js")};import * as cache from ${module("cache.js")};
const repo=${JSON.stringify(repository)},tree=${JSON.stringify(tree)},commands=${JSON.stringify(commands)},session={repositoryId:${JSON.stringify(gitCommonDir)}};
const action=async()=>{const cachedFingerprints=await cache.validationCacheFor(repo,session,tree,commands);const successful=[];const result=await runValidation(commands,${JSON.stringify(cwd)},{sessionId:'benchmark-${index}',cachedFingerprints,onCommandSuccess:async(c)=>successful.push(c)});for(const c of successful)await cache.recordValidationCache(repo,session,tree,c);console.log('METRIC '+JSON.stringify(result));};
if(cache.withValidationReuse)await cache.withValidationReuse(repo,tree,commands,action);else await action();`;
            return new Promise((resolve) => {
              const child = spawn(
                process.execPath,
                ["--input-type=module", "-e", source],
                {
                  env: {
                    ...process.env,
                    SESH_BUILD_QUEUE_HOME: queue,
                    SESH_INTEGRATOR_HOME: runtime,
                  },
                  stdio: ["ignore", "pipe", "pipe"],
                },
              );
              let evidence = "";
              child.stdout.on("data", (c) => (evidence += c));
              child.stderr.on("data", (c) => (evidence += c));
              child.once("error", (e) =>
                resolve({ code: 1, evidence: e.message }),
              );
              child.once("close", (code) =>
                resolve({
                  code: code ?? 1,
                  evidence: code ? evidence : undefined,
                  metrics: JSON.parse(
                    /^METRIC (.*)$/m.exec(evidence)?.[1] ?? "null",
                  ),
                }),
              );
            });
          }),
        );
        const durationMs = Math.round(performance.now() - started);
        sampling = false;
        await sample;
        const row = {
          scenario,
          repeat: repeat + 1,
          mode,
          durationMs,
          peakRssMiB: Math.round(peakBytes / 1024 ** 2),
          executed: results.reduce((n, r) => n + (r.metrics?.executed ?? 0), 0),
          cacheHits: results.reduce(
            (n, r) => n + (r.metrics?.cacheHits ?? 0),
            0,
          ),
          failures: results.filter((r) => r.code !== 0),
        };
        cases.push(row);
        console.log(JSON.stringify(row));
      }
    }
  await writeFile(
    resolve(output),
    JSON.stringify(
      {
        recordedAt: new Date().toISOString(),
        node: process.version,
        cpus: availableParallelism(),
        memoryGiB: totalmem() / 1024 ** 3,
        versions,
        method:
          "Four concurrent validation sessions in four worktrees of two disposable Git repositories. Actual pre-queue/current/candidate modules, unchanged required commands: TypeScript on 1800 declarations and 96 MiB/500ms scan. Independent disables caching; matching explicitly enables repository cache. Fresh caches every case. Five rotated repetitions. 20ms aggregate descendant RSS includes sampler and double-counts shared pages. No imposed memory pressure. Measures validation orchestration, not complete edit/merge/PR lifecycles.",
        cases,
      },
      null,
      2,
    ) + "\n",
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
async function treeRss(rootPid) {
  const rows = await Promise.all(
    (await readdir("/proc"))
      .filter((name) => /^\d+$/.test(name))
      .map(async (name) => {
        try {
          const text = await readFile(`/proc/${name}/status`, "utf8");
          return {
            pid: Number(name),
            parent: Number(/^PPid:\s+(\d+)/m.exec(text)?.[1]),
            rss: Number(/^VmRSS:\s+(\d+)/m.exec(text)?.[1] ?? 0) * 1024,
          };
        } catch {
          return undefined;
        }
      }),
  );
  const selected = new Set([rootPid]);
  for (let previous = -1; previous !== selected.size;) {
    previous = selected.size;
    for (const row of rows)
      if (row && selected.has(row.parent)) selected.add(row.pid);
  }
  return rows.reduce(
    (sum, row) => sum + (row && selected.has(row.pid) ? row.rss : 0),
    0,
  );
}
