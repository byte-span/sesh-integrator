import { execFileSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

it.each([false, true])(
  "syncs only global guidance (runtime configured: %s)",
  async (configured) => {
    const root = await mkdtemp(join(tmpdir(), "sesh-integrator-guidance-"));
    try {
      const home = join(root, "home");
      const runtime = join(root, "runtime");
      const repositories = ["missing", "custom", "old-managed"].map((name) =>
        join(root, name),
      );
      await mkdir(join(home, ".codex"), { recursive: true });
      for (const path of repositories) await mkdir(path);
      const custom = "# Project instructions\r\nKeep these exact bytes.\r\n";
      const managed =
        "<!-- codex-handoff:managed:start -->\nOld instructions\n<!-- codex-handoff:managed:end -->\n";
      await writeFile(join(repositories[1]!, "AGENTS.md"), custom);
      await writeFile(join(repositories[2]!, "AGENTS.md"), managed);
      if (configured) {
        await mkdir(runtime);
        await writeFile(
          join(runtime, "config.json"),
          JSON.stringify({
            repositories: repositories.map((path) => ({ path })),
          }),
        );
      }
      const globalPath = join(home, ".codex", "AGENTS.md");
      const sharedPolicies =
        "## External services and production isolation\nShared protection.\n\n## Central secret requirements\nShared registry policy.\n";
      const oldPolicyBlock =
        "<!-- codex-handoff:managed:start -->\n## External services and production isolation\nOld duplicate protection.\n## Central secret requirements\nOld duplicate registry policy.\n<!-- codex-handoff:managed:end -->\n";
      await writeFile(globalPath, sharedPolicies + oldPolicyBlock);
      const sync = () =>
        execFileSync(
          process.execPath,
          [join(process.cwd(), "scripts", "sync-managed-guidance.mjs")],
          {
            env: {
              ...process.env,
              PARALLEL_INTEGRATOR_DOCTOR_HOME: home,
              PARALLEL_INTEGRATOR_HOME: runtime,
            },
            encoding: "utf8",
          },
        );
      expect(sync()).toContain("Synchronized global guidance");
      const first = await readFile(globalPath, "utf8");
      expect(first.startsWith(sharedPolicies)).toBe(true);
      expect(first).not.toContain("Old duplicate protection.");
      expect(first).not.toContain("Old duplicate registry policy.");
      expect(first.match(/## Central secret requirements/g)).toHaveLength(1);
      expect(
        first.match(/## External services and production isolation/g),
      ).toHaveLength(1);
      expect(first).toContain(
        (
          await readFile(
            join(process.cwd(), "GLOBAL_AGENTS_SNIPPET.md"),
            "utf8",
          )
        ).trim(),
      );
      expect(sync()).toContain("already synchronized");
      expect(await readFile(globalPath, "utf8")).toBe(first);
      expect(await readdir(repositories[0]!)).toEqual([]);
      expect(await readFile(join(repositories[1]!, "AGENTS.md"), "utf8")).toBe(
        custom,
      );
      expect(await readFile(join(repositories[2]!, "AGENTS.md"), "utf8")).toBe(
        managed,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

it.each([
  ["claude", ".claude", "CLAUDE.md"],
  ["antigravity", ".gemini", "GEMINI.md"],
  ["grok", ".grok", "AGENTS.md"],
])(
  "installs %s idempotently while preserving personal instructions",
  async (harness, directory, filename) => {
    const home = await mkdtemp(join(tmpdir(), "sesh-harness-install-"));
    try {
      await mkdir(join(home, directory!), { recursive: true });
      const instructions = join(home, directory!, filename!);
      await writeFile(instructions, "# My preferences\nKeep my settings.\n");
      const install = () =>
        execFileSync(
          "sh",
          [
            join(process.cwd(), "scripts/install-skill.sh"),
            "--harness",
            harness!,
          ],
          { env: { ...process.env, HOME: home }, encoding: "utf8" },
        );
      install();
      const first = await readFile(instructions, "utf8");
      expect(first).toContain("# My preferences\nKeep my settings.");
      expect(first).toContain("seshx");
      install();
      expect(await readFile(instructions, "utf8")).toBe(first);
      expect(
        await readFile(
          join(
            home,
            harness === "antigravity" ? ".gemini/antigravity-cli" : directory!,
            "skills/sesh-integrator-workflow/SKILL.md",
          ),
          "utf8",
        ),
      ).toBe(await readFile("skill/sesh-integrator-workflow/SKILL.md", "utf8"));
      expect(await readdir(home)).toEqual(
        expect.arrayContaining([directory, ".sesh-integrator"]),
      );
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  },
);

it("refreshes installed harnesses and refuses customized content without changing other integrations", async () => {
  const home = await mkdtemp(join(tmpdir(), "sesh-refresh-"));
  try {
    const manifest = JSON.parse(await readFile("harnesses.json", "utf8"));
    delete manifest.gemini;
    const install = (...args: string[]) =>
      execFileSync(
        "sh",
        [join(process.cwd(), "scripts/install-skill.sh"), ...args],
        { env: { ...process.env, HOME: home }, encoding: "utf8" },
      );
    expect(install("--installed")).toContain("No installed harness");
    expect(await readdir(home)).toEqual([]);
    for (const harness of Object.keys(manifest)) install("--harness", harness);
    install("--installed");
    for (const info of Object.values(manifest) as any[]) {
      await writeFile(
        join(
          home,
          info.skillDirectory,
          "skills/sesh-integrator-workflow/SKILL.md",
        ),
        "stale",
      );
      await writeFile(
        join(home, info.directory, info.instructions),
        "Personal text\n<!-- codex-handoff:managed:start -->\nStale\n<!-- codex-handoff:managed:end -->\n",
      );
    }
    expect(() => install("--installed")).toThrow();
    for (const info of Object.values(manifest) as any[]) {
      expect(
        await readFile(
          join(
            home,
            info.skillDirectory,
            "skills/sesh-integrator-workflow/SKILL.md",
          ),
          "utf8",
        ),
      ).toBe("stale");
      const guidance = await readFile(
        join(home, info.directory, info.instructions),
        "utf8",
      );
      expect(guidance).toContain("Personal text");
      expect(guidance).toContain("Stale");
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

it("installs the canonical skill without refreshing a customized legacy duplicate", async () => {
  const home = await mkdtemp(join(tmpdir(), "sesh-single-skill-"));
  try {
    const legacy = join(
      home,
      ".agents",
      "skills",
      "parallel-integrator-workflow",
    );
    await mkdir(legacy, { recursive: true });
    await writeFile(join(legacy, "SKILL.md"), "Personal legacy content\n");
    execFileSync(
      process.execPath,
      [join(process.cwd(), "scripts/install-harnesses.mjs")],
      { env: { ...process.env, HOME: home }, stdio: "pipe" },
    );
    expect(
      await readFile(
        join(home, ".agents", "skills", "sesh-integrator-workflow", "SKILL.md"),
        "utf8",
      ),
    ).toBe(
      await readFile(
        join(process.cwd(), "skill/sesh-integrator-workflow/SKILL.md"),
        "utf8",
      ),
    );
    expect(await readFile(join(legacy, "SKILL.md"), "utf8")).toBe(
      "Personal legacy content\n",
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
