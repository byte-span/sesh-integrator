import { spawn, type ChildProcess } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";
import {
  queueRoot,
  queueSettings,
  queueEntries,
  queueCommand,
} from "../src/build-queue.js";

const children: ChildProcess[] = [];
afterEach(() => {
  for (const child of children.splice(0))
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGKILL");
});
const cacheModule = pathToFileURL(join(process.cwd(), "dist/cache.js")).href;
const processModule = pathToFileURL(
  join(process.cwd(), "dist/process.js"),
).href;
function launch({
  tree = "tree",
  policy = "repository",
  fail = false,
  verifyFail = false,
  env = {},
  pause = false,
}: {
  tree?: string;
  policy?: string;
  fail?: boolean;
  verifyFail?: boolean;
  env?: NodeJS.ProcessEnv;
  pause?: boolean;
} = {}) {
  const root = queueRoot();
  const command = [
    process.execPath,
    "-e",
    `require('fs').appendFileSync(${JSON.stringify(join(root, "executions"))},'run\\n');setTimeout(()=>process.exit(${fail ? 1 : 0}),350)`,
  ];
  const source = `import {withValidationReuse,validationCacheFor,recordValidationCache} from ${JSON.stringify(cacheModule)};
import {runValidation} from ${JSON.stringify(processModule)};
const repo={gitCommonDir:${JSON.stringify(join(root, "repo.git"))},validationCache:${JSON.stringify(policy)}};
const session={repositoryId:'repo'}; const tree=${JSON.stringify(tree)}; const steps=[${JSON.stringify(command)}];
await withValidationReuse(repo,tree,steps,async()=>{
 console.log('OWNED');
 ${pause ? "await new Promise(r=>setTimeout(r,10000));" : ""}
 const cachedFingerprints=await validationCacheFor(repo,session,tree,steps);
 const successful=[];
 await runValidation(steps,${JSON.stringify(root)},{cachedFingerprints,onCommandSuccess:async(c)=>{successful.push(c)}});
 ${verifyFail ? "throw new Error('tree verification failed');" : ""}
 for(const c of successful) await recordValidationCache(repo,session,tree,c);
});`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", source], {
    env: {
      ...process.env,
      SESH_INTEGRATOR_HOME: join(root, "runtime"),
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  let output = "";
  child.stdout!.on("data", (c) => (output += c));
  child.stderr!.on("data", (c) => (output += c));
  const done = new Promise<{ code: number | null; output: string }>(
    (resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) => resolve({ code, output }));
    },
  );
  return { child, done, output: () => output };
}
async function until(predicate: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("fixture timeout");
}
async function count() {
  return (await readFile(join(queueRoot(), "executions"), "utf8"))
    .trim()
    .split("\n").length;
}
it("defaults to unrestricted scheduling and retains explicit limits", async () => {
  await rm(join(queueRoot(), "config.json"));
  expect((await queueSettings()).concurrency).toBe("unlimited");
  await queueCommand(["configure", "--concurrency", "auto"]);
  expect((await queueSettings()).concurrency).toBe("auto");
  await queueCommand(["configure", "--concurrency", "unlimited"]);
  expect((await queueSettings()).concurrency).toBe("unlimited");
});
it("coalesces concurrent matching plans only after verified cache publication", async () => {
  const results = await Promise.all(
    Array.from({ length: 4 }, () => launch().done),
  );
  for (const r of results) expect(r.code, r.output).toBe(0);
  expect(await count()).toBe(1);
  expect(results.some((r) => r.output.includes("Waiting for matching"))).toBe(
    true,
  );
  expect(await queueEntries()).toEqual([]);
});
it.each(["tree", "environment", "off"])(
  "does not share different %s inputs or disabled cache",
  async (kind) => {
    const a = launch();
    const b = launch(
      kind === "tree"
        ? { tree: "different" }
        : kind === "environment"
          ? { env: { SESH_TEST_INPUT: "different" } }
          : { policy: "off" },
    );
    for (const r of await Promise.all([a.done, b.done]))
      expect(r.code, r.output).toBe(0);
    expect(await count()).toBe(2);
  },
);
it("does not publish failed validation or failed tree verification", async () => {
  for (const options of [{ fail: true }, { verifyFail: true }]) {
    const r = await launch(options).done;
    expect(r.code).not.toBe(0);
  }
  expect((await launch().done).code).toBe(0);
  expect(await count()).toBe(3);
});
it("cancels a duplicate waiter without disturbing its owner", async () => {
  const owner = launch({ pause: true });
  await until(() => owner.output().includes("OWNED"));
  const waiter = launch();
  await until(() => waiter.output().includes("Waiting for matching"));
  waiter.child.kill("SIGTERM");
  expect((await waiter.done).code).not.toBe(0);
  expect(owner.child.exitCode).toBeNull();
  owner.child.kill("SIGKILL");
  await owner.done;
  expect((await launch().done).code).toBe(0);
  expect(await count()).toBe(1);
});
it("recovers the reuse mutex after owner crash without publishing success", async () => {
  const owner = launch({ pause: true });
  await until(() => owner.output().includes("OWNED"));
  owner.child.kill("SIGKILL");
  await owner.done;
  expect((await launch().done).code).toBe(0);
  expect(await count()).toBe(1);
});
it("skips preparation discovery when all checks have valid cached results", async () => {
  const { runValidation, commandFingerprint } =
    await import("../src/process.js");
  const command: [string, ...string[]] = [
    process.execPath,
    "-e",
    "process.exit(1)",
  ];
  // A missing cwd makes preparation discovery fail if it is attempted.
  expect(
    await runValidation([command], join(queueRoot(), "absent"), {
      cachedFingerprints: new Set([commandFingerprint(command)]),
    }),
  ).toEqual({ cacheHits: 1, executed: 0 });
});

it("blocks duplicate retry after owner crash until orphan recovery", async () => {
  await queueCommand(["configure", "--wait-seconds", "1"]);
  const owner = launch();
  await until(async () => {
    try {
      return (await count()) === 1;
    } catch {
      return false;
    }
  });
  owner.child.kill("SIGKILL");
  await owner.done;
  const next = await launch().done;
  expect(next.code).not.toBe(0);
  expect(next.output).toContain("orphaned owner needs recovery");
  expect(await count()).toBe(1);
  // The fixture workload exits after 350ms; the failed retry waited one second.
  const entries = await queueEntries();
  expect(entries).toHaveLength(1);
  await queueCommand(["recover", entries[0]!.id, "--confirmed-stopped"]);
  expect((await launch().done).code).toBe(0);
  expect(await count()).toBe(2);
});
