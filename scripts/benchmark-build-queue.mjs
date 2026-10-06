// Reproducible local comparison; no network, repository settings or live queue.
// Linux /proc measures summed descendant RSS (shared pages counted per process).
import { spawn, execFileSync } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { availableParallelism, tmpdir, totalmem } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

if (process.platform !== "linux")
  throw new Error(
    "RSS sampling currently requires Linux /proc; queue operation is cross-platform.",
  );
const output = process.argv[2];
if (!output)
  throw new Error(
    "Usage: node scripts/benchmark-build-queue.mjs <report.json>",
  );
const root = await mkdtemp(join(tmpdir(), "sesh-queue-benchmark-"));
const cli = pathToFileURL(resolve("dist/process.js")).href;
const direct = pathToFileURL(resolve("dist/process.js")).href;
const tsc = resolve("node_modules/typescript/bin/tsc");
const cases = [];
try {
  for (let i = 0; i < 2; i++) {
    const repo = join(root, `repo-${i}`);
    await mkdir(repo);
    execFileSync("git", ["init", "--quiet", repo]);
    await writeFile(
      join(repo, "input.ts"),
      Array.from(
        { length: 1800 },
        (_, n) =>
          `export interface Row${n} { id: number; name: string; tags: string[] }; export const row${n}: Row${n} = { id: ${n}, name: 'row', tags: [] };`,
      ).join("\n"),
    );
  }
  const workload = join(root, "memory-test.cjs");
  await writeFile(
    workload,
    `const b=Buffer.alloc(96*1024*1024,7);const start=performance.now();let n=0;while(performance.now()-start<500){for(let i=0;i<b.length;i+=4096)n+=b[i];}if(!n)process.exit(1);`,
  );
  // Rotate order to reduce warm-cache/order bias across three repetitions.
  for (let repeat = 0; repeat < 3; repeat++) {
    const modes = ["direct", "queue-1", "queue-2"];
    for (const mode of [...modes.slice(repeat), ...modes.slice(0, repeat)]) {
      const queue = join(root, `${mode}-${repeat}`);
      await mkdir(queue);
      await writeFile(
        join(queue, "config.json"),
        JSON.stringify({
          concurrency: mode === "queue-1" ? 1 : 2,
          waitSeconds: 120,
        }),
      );
      const started = performance.now();
      let peakBytes = 0;
      let sampling = true;
      const sample = (async () => {
        while (sampling) {
          peakBytes = Math.max(peakBytes, await treeRss(process.pid));
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      })();
      const runs = Array.from({ length: 4 }, (_, index) => {
        const cwd = join(root, `repo-${index % 2}`);
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
        const source =
          mode === "direct"
            ? `import {run} from ${JSON.stringify(direct)};for(const c of ${JSON.stringify(commands)}){const r=await run(c[0],c.slice(1),{cwd:${JSON.stringify(cwd)}});if(r.code)process.exit(r.code);}`
            : `import {runValidation} from ${JSON.stringify(cli)};await runValidation(${JSON.stringify(commands)},${JSON.stringify(cwd)},{sessionId:'benchmark-${index}'});`;
        return new Promise((resolve) => {
          const child = spawn(
            process.execPath,
            ["--input-type=module", "-e", source],
            {
              env: {
                ...process.env,
                SESH_BUILD_QUEUE_HOME: queue,
                SESH_INTEGRATOR_HOME: join(root, `runtime-${index}`),
              },
              stdio: ["ignore", "pipe", "pipe"],
            },
          );
          let evidence = "";
          child.stdout.on("data", (chunk) => {
            evidence += String(chunk);
          });
          child.stderr.on("data", (chunk) => {
            evidence += String(chunk);
          });
          child.once("error", (error) =>
            resolve({ code: 1, evidence: error.message }),
          );
          child.once("close", (code) =>
            resolve({ code: code ?? 1, evidence: code ? evidence : undefined }),
          );
        });
      });
      const results = await Promise.all(runs);
      const durationMs = performance.now() - started;
      sampling = false;
      await sample;
      const result = {
        repeat: repeat + 1,
        mode,
        durationMs: Math.round(durationMs),
        peakRssMiB: Math.round(peakBytes / 1024 ** 2),
        failures: results.filter((result) => result.code !== 0),
      };
      cases.push(result);
      console.log(JSON.stringify(result));
    }
  }
  const report = {
    version: 1,
    recordedAt: new Date().toISOString(),
    platform: process.platform,
    node: process.version,
    availableCpus: availableParallelism(),
    memoryGiB: +(totalmem() / 1024 ** 3).toFixed(1),
    method:
      "4 concurrent sessions, 2 disposable Git repositories, 4 runtime homes; each session runs TypeScript on 1800 typed declarations then a 96 MiB/500ms memory scan. 20ms summed process-tree RSS samples include coordinator overhead and double-count shared pages. Three rotated repetitions, warm filesystem cache. No imposed memory pressure; not an OOM stress test.",
    cases,
  };
  await writeFile(resolve(output), JSON.stringify(report, null, 2) + "\n");
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
