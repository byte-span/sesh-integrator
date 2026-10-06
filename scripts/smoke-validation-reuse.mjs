// Portable smoke for matching validation across separate coordinator processes.
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
const root = await mkdtemp(join(tmpdir(), "sesh-reuse-smoke-"));
const cache = new URL("../dist/cache.js", import.meta.url).href;
const runner = new URL("../dist/process.js", import.meta.url).href;
const counter = join(root, "executions");
try {
  const commands = [
    [
      process.execPath,
      "-e",
      `require('fs').appendFileSync(${JSON.stringify(counter)},'run\\n');setTimeout(()=>{},500)`,
    ],
  ];
  const source = `import * as cache from ${JSON.stringify(cache)};import {runValidation} from ${JSON.stringify(runner)};
const repo={gitCommonDir:${JSON.stringify(root)},validationCache:'repository'};const session={repositoryId:'smoke'};const commands=${JSON.stringify(commands)};
await cache.withValidationReuse(repo,'exact-tree',commands,async()=>{const cachedFingerprints=await cache.validationCacheFor(repo,session,'exact-tree',commands);const successes=[];await runValidation(commands,${JSON.stringify(root)},{cachedFingerprints,onCommandSuccess:async(c)=>successes.push(c)});for(const c of successes)await cache.recordValidationCache(repo,session,'exact-tree',c);});`;
  const results = await Promise.all(
    Array.from(
      { length: 4 },
      () =>
        new Promise((resolve, reject) => {
          const child = spawn(
            process.execPath,
            ["--input-type=module", "-e", source],
            {
              env: {
                ...process.env,
                SESH_INTEGRATOR_HOME: join(root, "runtime"),
                SESH_BUILD_QUEUE_HOME: join(root, "queue"),
              },
              stdio: ["ignore", "pipe", "pipe"],
            },
          );
          let output = "";
          child.stdout.on("data", (c) => (output += c));
          child.stderr.on("data", (c) => (output += c));
          child.once("error", reject);
          child.once("close", (code) =>
            code === 0 ? resolve(output) : reject(new Error(output)),
          );
        }),
    ),
  );
  const count = (await readFile(counter, "utf8")).trim().split("\n").length;
  if (count !== 1) throw new Error(`Expected one execution, got ${count}`);
  if (!results.some((result) => result.includes("Using cached validation")))
    throw new Error("No reuse observed");
  console.log(
    JSON.stringify({
      platform: process.platform,
      node: process.version,
      sessions: 4,
      executions: count,
      failures: 0,
    }),
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
