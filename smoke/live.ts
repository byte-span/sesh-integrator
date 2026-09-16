import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import { createCodexLoginCommand } from "./codex-login.js";
import { liveOptions } from "./live-options.js";
import {
  conflictingSmoke,
  registerSmoke,
  smokeFixture,
} from "../test/smoke-fixture.js";

const { selected, sandboxHome } = await liveOptions();

it.each(selected)(
  "%s performs a real edit and resolves a conflict through its adapter",
  async (harness) => {
    const f = await smokeFixture(
      undefined,
      harness === "codex" ? undefined : sandboxHome,
      true,
    );
    try {
      await registerSmoke(f);
      if (harness === "codex") {
        const command = await createCodexLoginCommand(f.root);
        await f.configure((c) => {
          c.harnessCommands = { codex: command };
        });
      }
      const task = join(f.root, "task.mjs");
      await writeFile(
        task,
        `
import {runAgent} from ${JSON.stringify(pathToFileURL(join(process.cwd(), "dist/agent.js")).href)};
import {readConfig} from ${JSON.stringify(pathToFileURL(join(process.cwd(), "dist/runtime.js")).href)};
await runAgent({config:await readConfig(),harness:${JSON.stringify(harness)},purpose:'resolve',cwd:process.cwd(),prompt:'Edit features.json to enable alpha while keeping beta false. Modify only this file. Do not commit, run seshx, or access external services.'});
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
