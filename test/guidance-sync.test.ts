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
      await writeFile(
        globalPath,
        "# Personal instructions\nPreserve this section.\n",
      );
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
      expect(first).toContain(
        "# Personal instructions\nPreserve this section.",
      );
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
  ["gemini", ".gemini", "GEMINI.md"],
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
          join(home, directory!, "skills/sesh-integrator-workflow/SKILL.md"),
          "utf8",
        ),
      ).toBe(await readFile("skill/sesh-integrator-workflow/SKILL.md", "utf8"));
      expect(await readdir(home)).toEqual([directory]);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  },
);
