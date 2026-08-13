import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("bundled workflow trigger policy", () => {
  it("uses CLI-first managed source worktrees without application mode gates", async () => {
    const [guidance, skill] = await Promise.all([
      readFile(join(process.cwd(), "GLOBAL_AGENTS_SNIPPET.md"), "utf8"),
      readFile(
        join(process.cwd(), "skill", "codex-handoff-workflow", "SKILL.md"),
        "utf8",
      ),
    ]);

    for (const policy of [guidance, skill]) {
      expect(policy).toContain("begin --create-worktree");
      expect(policy).toContain("Continue task in:");
      expect(policy).toMatch(/dirty or staged|staged and unstaged/is);
      expect(policy).not.toMatch(/Local mode|Worktree mode/);
    }
  });
});
