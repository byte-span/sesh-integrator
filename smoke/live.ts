import { readFile, realpath, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import { harnesses } from "../src/harness.js";
import {
  conflictingSmoke,
  registerSmoke,
  smokeFixture,
} from "../test/smoke-fixture.js";

// Fail closed: running this command without explicit sandbox setup is not a pass.
const selected = process.env.SESH_SMOKE_HARNESSES?.split(",") ?? [];
const sandboxHome = process.env.SESH_SMOKE_HOME ?? "";
if (
  process.env.SESH_SMOKE_BUDGET_CONFIRMED !== "1" ||
  !isAbsolute(sandboxHome) ||
  (await realpath(sandboxHome)) === (await realpath(homedir())) ||
  selected.length === 0 ||
  new Set(selected).size !== selected.length ||
  selected.some((h) => !harnesses.includes(h as (typeof harnesses)[number]))
)
  throw new Error(
    "Set SESH_SMOKE_HARNESSES, a separate SESH_SMOKE_HOME, and SESH_SMOKE_BUDGET_CONFIRMED=1 after configuring sandbox authentication and a provider spending cap. See smoke/README.md.",
  );

it.each(selected)(
  "%s performs a real edit and resolves a conflict through its adapter",
  async (harness) => {
    const f = await smokeFixture(undefined, sandboxHome);
    try {
      await registerSmoke(f);
      const task = join(f.root, "task.mjs");
      await writeFile(
        task,
        `
import {runAgent} from ${JSON.stringify(pathToFileURL(join(process.cwd(), "dist/agent.js")).href)};
import {defaultConfig} from ${JSON.stringify(pathToFileURL(join(process.cwd(), "dist/runtime.js")).href)};
await runAgent({config:defaultConfig(),harness:${JSON.stringify(harness)},purpose:'resolve',cwd:process.cwd(),prompt:'Edit features.json to enable alpha while keeping beta false. Modify only this file. Do not commit, run seshx, or access external services.'});
`,
      );
      const base = await f.git(f.repo, "rev-parse", "HEAD");
      const result = await f.command(process.execPath, [task], f.repo);
      expect(result.code, "Live task failed; provider output suppressed").toBe(
        0,
      );
      expect(
        JSON.parse(await readFile(join(f.repo, "features.json"), "utf8")),
      ).toEqual({ alpha: true, beta: false });
      expect(await f.git(f.repo, "rev-parse", "HEAD")).toBe(base);
      expect(await f.git(f.repo, "diff", "--name-only")).toBe("features.json");
      expect(
        await f.git(f.repo, "ls-files", "--others", "--exclude-standard"),
      ).toBe("");
      // Restore only this disposable fixture's known task edit before the conflict trial.
      await writeFile(
        join(f.repo, "features.json"),
        '{"alpha":false,"beta":false}\n',
      );
      const second = await conflictingSmoke(f, harness);
      const ready = await f.git(second.worktreePath, "rev-parse", "HEAD");
      await f.configure((c) => {
        c.conflictResolutionMode = "nested-agent";
      });
      await f.run(second.worktreePath, [
        "integrate",
        "--summary",
        "enable beta",
        "--rollout",
        "none",
      ]);
      const done = (await f.sessions()).find((s) => s.id === second.id)!;
      expect(done.status).toBe("succeeded");
      expect(await f.git(f.repo, "rev-parse", "main")).toBe(
        done.promotedCommit,
      );
      await f.git(f.repo, "merge-base", "--is-ancestor", ready, "main");
      expect(
        JSON.parse(await readFile(join(f.repo, "features.json"), "utf8")),
      ).toEqual({ alpha: true, beta: true });
      expect(await readFile(join(f.repo, "unrelated.txt"), "utf8")).toBe(
        "preserve me\n",
      );
      expect(await f.git(f.repo, "status", "--porcelain")).toBe("");
      expect(await f.git(second.worktreePath, "status", "--porcelain")).toBe(
        "",
      );
    } finally {
      await f.dispose();
    }
  },
);
