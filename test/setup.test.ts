import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
  symlink,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, delimiter } from "node:path";
import { afterEach, expect, it } from "vitest";
import { executableOnPath, managedRange } from "../src/setup.js";

const roots: string[] = [];
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "sesh-setup-"));
  roots.push(home);
  const bin = join(home, "bin");
  await mkdir(bin);
  await writeFile(join(bin, "claude"), "#!/bin/sh\nexit 99\n", { mode: 0o755 });
  // Setup now exercises Git operations, so provide real Git while keeping
  // harness discovery isolated to this fixture.
  const gitPath = (process.env.PATH ?? "")
    .split(delimiter)
    .map((directory) => join(directory, "git"))
    .find((path) => existsSync(path));
  if (!gitPath) throw new Error("Git is required for setup capability tests");
  await symlink(gitPath, join(bin, "git"));
  const env = {
    ...process.env,
    HOME: home,
    PATH: bin,
    SESH_INTEGRATOR_HOME: join(home, "runtime"),
  };
  const cli = (args: string[]) =>
    spawnSync(process.execPath, [join(process.cwd(), "dist/cli.js"), ...args], {
      env,
      cwd: home,
      encoding: "utf8",
    });
  return { home, bin, cli };
}
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

it("detects executable CLIs without running them or relying on workflow directories", async () => {
  const { bin } = await fixture();
  await writeFile(join(bin, "codex"), "not executable", { mode: 0o644 });
  await mkdir(join(bin, "gemini"));
  expect(await executableOnPath("claude", bin)).toBe(true);
  expect(await executableOnPath("codex", bin)).toBe(false);
  expect(await executableOnPath("gemini", bin)).toBe(false);
});

it("sets up detected harnesses idempotently and safely uninstalls them", async () => {
  const { home, cli } = await fixture();
  const guidance = join(home, ".claude/CLAUDE.md");
  await mkdir(join(home, ".claude"));
  const personal = "Personal instructions\n\n\nKeep this spacing.\n";
  await writeFile(guidance, personal);
  const first = cli(["setup", "--detected", "--yes"]);
  expect(first.status, first.stderr).toBe(0);
  expect(first.stdout).toContain("Detected harnesses: claude");
  const installed = await readFile(guidance, "utf8");
  expect(installed.startsWith(personal)).toBe(true);
  expect(cli(["setup", "--detected", "--yes"]).status).toBe(0);
  expect(await readFile(guidance, "utf8")).toBe(installed);
  await expect(
    readFile(join(home, ".agents/skills/sesh-integrator-workflow/SKILL.md")),
  ).rejects.toThrow();
  const configPath = join(home, "runtime/config.json");
  const config = await readFile(configPath, "utf8");
  const removal = cli(["uninstall", "--yes"]);
  expect(removal.status, removal.stderr).toBe(0);
  expect(await readFile(guidance, "utf8")).toBe(personal + "\n");
  expect(await readFile(configPath, "utf8")).toBe(config);
  await expect(
    readFile(join(home, ".claude/skills/sesh-integrator-workflow/SKILL.md")),
  ).rejects.toThrow();
});

it("preserves edited skills and guidance on uninstall", async () => {
  const { home, cli } = await fixture();
  expect(cli(["setup", "--harness", "claude", "--yes"]).status).toBe(0);
  const skill = join(home, ".claude/skills/sesh-integrator-workflow/SKILL.md");
  const guidance = join(home, ".claude/CLAUDE.md");
  await writeFile(skill, "custom skill");
  const edited = (await readFile(guidance, "utf8")).replace(
    "# sesh-integrator",
    "# My sesh-integrator",
  );
  await writeFile(guidance, edited);
  expect(cli(["setup", "--harness", "claude", "--yes"]).status).not.toBe(0);
  expect(cli(["uninstall", "--yes"]).status).toBe(0);
  expect(await readFile(skill, "utf8")).toBe("custom skill");
  expect(await readFile(guidance, "utf8")).toBe(edited);
});

it("requires explicit unattended selection and rejects malformed guidance before writing skills", async () => {
  const { home, cli } = await fixture();
  expect(cli(["setup"]).status).not.toBe(0);
  expect(cli(["setup", "--yes"]).status).not.toBe(0);
  expect(
    cli(["setup", "--detected", "--harness", "claude", "--yes"]).status,
  ).not.toBe(0);
  await mkdir(join(home, ".claude"));
  await writeFile(
    join(home, ".claude/CLAUDE.md"),
    "<!-- codex-handoff:managed:start -->",
  );
  expect(cli(["setup", "--detected", "--yes"]).status).not.toBe(0);
  await expect(
    readFile(join(home, ".claude/skills/sesh-integrator-workflow/SKILL.md")),
  ).rejects.toThrow();
  expect(() => managedRange("<!-- codex-handoff:managed:end -->")).toThrow();
});

it("source CLI installer does not invoke machine maintenance", async () => {
  const { home } = await fixture();
  const scripts = join(home, "scripts");
  await mkdir(scripts);
  await mkdir(join(home, "dist"));
  await writeFile(join(home, "dist/cli.js"), "#!/usr/bin/env node\n");
  await writeFile(
    join(scripts, "install-cli.sh"),
    await readFile("scripts/install-cli.sh"),
  );
  await writeFile(
    join(scripts, "install-machine-safeguards.sh"),
    "#!/bin/sh\nexit 42\n",
    { mode: 0o755 },
  );
  expect(
    execFileSync("sh", [join(scripts, "install-cli.sh")], {
      env: { ...process.env, SESH_INTEGRATOR_BIN_DIR: join(home, "local-bin") },
      encoding: "utf8",
    }),
  ).toContain("Run seshx setup");
});

it("detects agy and preserves legacy Gemini skills while installing Antigravity", async () => {
  const { home, bin, cli } = await fixture();
  await writeFile(join(bin, "agy"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const legacy = join(home, ".gemini/skills/sesh-integrator-workflow");
  await mkdir(legacy, { recursive: true });
  await writeFile(join(legacy, "SKILL.md"), "custom legacy workflow");
  const result = cli(["setup", "--detected", "--yes"]);
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain("antigravity");
  expect(
    await readFile(
      join(
        home,
        ".gemini/antigravity-cli/skills/sesh-integrator-workflow/SKILL.md",
      ),
      "utf8",
    ),
  ).toContain("--harness");
  expect(await readFile(join(legacy, "SKILL.md"), "utf8")).toBe(
    "custom legacy workflow",
  );
  expect(cli(["begin", "--harness", "gemini"]).status).not.toBe(0);
});
