import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("bundled workflow trigger policy", () => {
  it("requires scram-j review for sesh-integrator self-hosting pull requests", async () => {
    const policy = await readFile(join(process.cwd(), "AGENTS.md"), "utf8");

    expect(policy).toContain("Every pull request opened for this repository");
    expect(policy).toContain("--reviewer scram-j");
  });

  it("uses CLI-first managed source worktrees without application mode gates", async () => {
    const [guidance, skill] = await Promise.all([
      readFile(join(process.cwd(), "GLOBAL_AGENTS_SNIPPET.md"), "utf8"),
      readFile(
        join(process.cwd(), "skill", "sesh-integrator-workflow", "SKILL.md"),
        "utf8",
      ),
    ]);

    for (const policy of [guidance, skill]) {
      expect(policy).toContain("Enablement: disabled");
      expect(policy).toContain(
        "Only enable the repository when the user requests it",
      );
      expect(policy).toContain("begin --create-worktree");
      expect(policy).toContain("Continue task in:");
      expect(policy).toMatch(/dirty or staged|staged and unstaged/is);
      expect(policy).not.toMatch(/Local mode|Worktree mode/);
    }
  });

  it("keeps required completion fields even when a concise response is requested", async () => {
    const policies = await Promise.all([
      readFile(join(process.cwd(), "GLOBAL_AGENTS_SNIPPET.md"), "utf8"),
      readFile(
        join(process.cwd(), "skill", "sesh-integrator-workflow", "SKILL.md"),
        "utf8",
      ),
    ]);

    for (const policy of policies) {
      expect(policy).toContain("Requests for concision never override");
      expect(policy).toContain("pull-request URL");
      expect(policy).toContain("Completion summary");
      expect(policy).toContain("exact configuration");
      expect(policy).toContain("Never request, read, store, or print");
      expect(policy).toContain("secret values");
      expect(policy).toContain("must not replace known essential steps");
      expect(policy).toContain(
        "resolved integration prerequisites as completed",
      );
      expect(policy).toContain(
        "Recovery alone does not resolve recorded external setup actions",
      );
    }
  });

  it("lets the agent retry plausibly transient validation failures", async () => {
    const policies = await Promise.all([
      readFile(join(process.cwd(), "GLOBAL_AGENTS_SNIPPET.md"), "utf8"),
      readFile(
        join(process.cwd(), "skill", "sesh-integrator-workflow", "SKILL.md"),
        "utf8",
      ),
    ]);

    for (const policy of policies) {
      expect(policy).toMatch(/retry/i);
      expect(policy).toMatch(/safe/i);
      expect(policy).toMatch(/three\s+total\s+attempts/i);
      expect(policy).toMatch(/evidence, not (?:a )?verdict/i);
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

  it("ships managed guidance and bounded self-hosting automation", async () => {
    const [timer, service, prePush, postMerge, syncDev] = await Promise.all([
      readFile(
        join(process.cwd(), "systemd", "sesh-integrator-health.timer"),
        "utf8",
      ),
      readFile(
        join(process.cwd(), "systemd", "sesh-integrator-health.service.in"),
        "utf8",
      ),
      readFile(join(process.cwd(), "scripts", "self-hosting-pre-push"), "utf8"),
      readFile(
        join(process.cwd(), "scripts", "self-hosting-post-merge"),
        "utf8",
      ),
      readFile(join(process.cwd(), "scripts", "self-hosting-sync-dev"), "utf8"),
    ]);

    expect(timer).toContain("OnUnitActiveSec=6h");
    expect(service).toContain("TimeoutStartSec=130");
    expect(prePush).toContain("merge-base --is-ancestor origin/main dev");
    expect(postMerge).toContain("merge --ff-only");
    expect(syncDev).toContain("merge-base --is-ancestor dev origin/main");
  });
});
