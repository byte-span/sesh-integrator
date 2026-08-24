import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("bundled workflow trigger policy", () => {
  it("requires scram-j review for codex-handoff self-hosting pull requests", async () => {
    const policy = await readFile(join(process.cwd(), "AGENTS.md"), "utf8");

    expect(policy).toContain("Every pull request opened for this repository");
    expect(policy).toContain("--reviewer scram-j");
  });

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

  it("keeps the optional central secret registry metadata-only", async () => {
    const guidance = await readFile(
      join(process.cwd(), "GLOBAL_AGENTS_SNIPPET.md"),
      "utf8",
    );

    expect(guidance).toContain("secret-sync/secret-configs/apps/");
    expect(guidance).toMatch(/Never (?:store|place) values, tokens,/);
    expect(guidance).toContain("Vercel project/organization IDs");
    expect(guidance).toContain("Druidia");
    expect(guidance).toContain("npm run validate:configs");
    expect(guidance).toContain("do not guess");
  });
});
