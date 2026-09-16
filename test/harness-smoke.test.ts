import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import { harnesses } from "../src/harness.js";
import {
  conflictingSmoke,
  registerSmoke,
  smokeFixture,
} from "./smoke-fixture.js";

it.each(
  harnesses.flatMap((harness) =>
    ["failure", "timeout"].map((fault) => ({ harness, fault })),
  ),
)(
  "$harness preserves and resumes integration after $fault",
  async ({ harness, fault }) => {
    const f = await smokeFixture();
    try {
      await registerSmoke(f);
      const second = await conflictingSmoke(f, harness);
      const before = await f.git(f.repo, "rev-parse", "main");
      const ready = await f.git(second.worktreePath, "rev-parse", "HEAD");
      const executable = join(f.root, "fault.mjs");
      const evidence = join(f.root, "fault-observed.txt");
      // Exercise the real process timeout implementation with a shortened deadline,
      // then propagate its failure through each adapter and the integration lifecycle.
      await writeFile(
        executable,
        `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
import { run } from ${JSON.stringify(pathToFileURL(join(process.cwd(), "dist/process.js")).href)};
if (${JSON.stringify(fault)} === 'timeout') {
  const r = await run(process.execPath, ['-e','setInterval(()=>{},1000)'], {timeoutMs:100});
  writeFileSync(${JSON.stringify(evidence)}, r.stderr);
  process.exit(r.code);
}
writeFileSync(${JSON.stringify(evidence)}, 'exit 9');
process.exit(9);
`,
        { mode: 0o755 },
      );
      await f.configure((c) => {
        c.conflictResolutionMode = "nested-agent";
        c.harnessCommands = { [harness]: executable };
      });
      await f.run(
        second.worktreePath,
        ["integrate", "--summary", "enable beta", "--rollout", "none"],
        1,
      );
      expect(await readFile(evidence, "utf8")).toContain(
        fault === "timeout" ? "timed out" : "exit 9",
      );
      const pending = (await f.sessions()).find((s) => s.id === second.id)!;
      expect(pending.status).toBe("needs_review");
      expect(pending.readyCommit).toBe(ready);
      expect(await f.git(f.repo, "rev-parse", "main")).toBe(before);
      expect(await f.git(second.worktreePath, "status", "--porcelain")).toBe(
        "",
      );
      const integration = pending.integrationWorktreePath!;
      expect(
        await f.git(integration, "diff", "--name-only", "--diff-filter=U"),
      ).toBe("features.json");
      await writeFile(
        join(integration, "features.json"),
        '{"alpha":true,"beta":true}\n',
      );
      await f.git(integration, "add", "features.json");
      await f.run(second.worktreePath, ["resume"]);
      const done = (await f.sessions()).find((s) => s.id === second.id)!;
      expect(done.status).toBe("succeeded");
      expect(await f.git(f.repo, "rev-parse", "main")).toBe(
        done.promotedCommit,
      );
      expect(
        JSON.parse(await readFile(join(f.repo, "features.json"), "utf8")),
      ).toEqual({ alpha: true, beta: true });
      expect(await readFile(join(f.repo, "unrelated.txt"), "utf8")).toBe(
        "preserve me\n",
      );
    } finally {
      await f.dispose();
    }
  },
  60_000,
);
