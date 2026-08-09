import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("bundled workflow trigger policy", () => {
  it("treats Codex Local mode as an opt-out", async () => {
    const [guidance, skill] = await Promise.all([
      readFile(join(process.cwd(), "GLOBAL_AGENTS_SNIPPET.md"), "utf8"),
      readFile(
        join(process.cwd(), "skill", "codex-handoff-workflow", "SKILL.md"),
        "utf8",
      ),
    ]);

    for (const policy of [guidance, skill]) {
      expect(policy).toMatch(
        /Local mode is an explicit opt-out|Local mode.*authoritative/s,
      );
      expect(policy).toMatch(/git\s+rev-parse --git-dir/);
      expect(policy).toMatch(/git\s+rev-parse --git-common-dir/);
    }
  });
});
