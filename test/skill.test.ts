import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import {
  appendFile,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { hashSkill, readStamp } from "../src/skill-contract.mjs";
import { LEGACY_SKILL_HASHES } from "../src/skill.js";
import { harnessHomeEnv } from "./harness-env.js";

const project = process.cwd();
const cli = join(project, "dist/cli.js");
const source = join(project, "skill/sesh-integrator-workflow");
// The skill as pre-contract installers copied it, frozen at the last
// pre-contract release, so adoption stays covered after the skill changes.
const preContract = join(project, "test/fixtures/pre-contract-skill");
const version = (
  JSON.parse(readFileSync(join(project, "package.json"), "utf8")) as {
    version: string;
  }
).version;
const name = "sesh-integrator-workflow";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

async function machine(...harnessDirs: string[]) {
  const home = await mkdtemp(join(tmpdir(), "sesh-skill-"));
  roots.push(home);
  for (const dir of harnessDirs)
    await mkdir(join(home, dir), { recursive: true });
  const env = harnessHomeEnv(home, {
    SESH_INTEGRATOR_HOME: join(home, "runtime"),
    AGENT_SKILL_HEAL: "1",
  });
  const run = (args: string[], executable = cli, extra = {}) => {
    const result = spawnSync(process.execPath, [executable, ...args], {
      cwd: home,
      env: { ...env, ...extra },
      encoding: "utf8",
    });
    return {
      code: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  };
  return { home, run, copy: (target: string) => join(home, target, name) };
}

const healLines = (stderr: string) =>
  stderr.split("\n").filter((line) => line.includes("updated the"));

it("installs, reports and removes the skill in every detected harness directory", async () => {
  const m = await machine(".codex", ".claude", ".grok");
  const agents = m.copy(".agents/skills");
  const claude = m.copy(".claude/skills");
  const grok = m.copy(".grok/skills");

  const path = m.run(["skill", "path"]);
  expect(path).toEqual({ code: 0, stdout: `${source}\n`, stderr: "" });
  const missing = JSON.parse(m.run(["skill", "status", "--json"]).stdout);
  expect(missing.map((row: { target: string }) => row.target)).toEqual([
    "agents",
    "claude",
    "grok",
  ]);
  expect(
    missing.every((row: { state: string }) => row.state === "missing"),
  ).toBe(true);
  // Normal runs never add a missing copy.
  expect(healLines(m.run(["version"]).stderr)).toEqual([]);
  expect(existsSync(claude)).toBe(false);

  const install = m.run(["skill", "install"]);
  expect(install.code, install.stdout + install.stderr).toBe(0);
  for (const copy of [agents, claude, grok]) {
    expect(readStamp(copy)).toEqual({
      by: "sesh-integrator",
      version,
      command: "seshx",
      hash: hashSkill(source),
    });
    expect(hashSkill(copy)).toBe(hashSkill(source));
  }
  // Every target gets the same folder, including Codex's agents/ metadata.
  expect(existsSync(join(claude, "agents/openai.yaml"))).toBe(true);
  expect(m.run(["skill", "status"]).stdout).toMatch(
    /^claude .*Claude Code.* current +\S+ /m,
  );

  // A locally edited copy is kept until --replace-edited backs it up.
  await appendFile(join(claude, "SKILL.md"), "My note\n");
  const kept = m.run(["skill", "install"]);
  expect(kept.code).toBe(1);
  expect(kept.stdout).toContain("--replace-edited");
  expect(await readFile(join(claude, "SKILL.md"), "utf8")).toContain("My note");
  expect(m.run(["skill", "install", "--replace-edited"]).code).toBe(0);
  expect(hashSkill(claude)).toBe(hashSkill(source));
  // The locked replace leaves no lock or temp folder a harness could load.
  expect(await readdir(join(m.home, ".claude/skills"))).toEqual([name]);
  const backups = join(m.home, "runtime/skill-backups");
  const [backup] = await readdir(backups);
  expect(backup).toMatch(/^sesh-integrator-workflow-\d{8}T\d{6}Z$/);
  expect(await readFile(join(backups, backup!, "SKILL.md"), "utf8")).toContain(
    "My note",
  );

  // Removal takes owned copies only.
  await rm(grok, { recursive: true });
  await mkdir(grok);
  await writeFile(join(grok, "SKILL.md"), "---\nname: mine\n---\nMine\n");
  const removed = m.run(["skill", "remove"]);
  expect(removed.code).toBe(0);
  expect(removed.stdout).toContain("left the unmanaged copy");
  expect(existsSync(agents) || existsSync(claude)).toBe(false);
  expect(await readFile(join(grok, "SKILL.md"), "utf8")).toContain("Mine");
});

it("adopts pre-contract copies on a normal run and leaves other copies alone", async () => {
  // The fixture's hash must stay listed in both variants installers wrote.
  const m = await machine(".claude", ".grok", ".agents/skills");
  const variants = await mkdtemp(join(tmpdir(), "sesh-skill-variant-"));
  roots.push(variants);
  await cp(join(preContract, "SKILL.md"), join(variants, "SKILL.md"));
  expect(LEGACY_SKILL_HASHES).toContain(hashSkill(variants));
  expect(LEGACY_SKILL_HASHES).toContain(hashSkill(preContract));

  const agents = m.copy(".agents/skills");
  const claude = m.copy(".claude/skills");
  const grok = m.copy(".grok/skills");
  await cp(preContract, agents, { recursive: true });
  await mkdir(claude, { recursive: true });
  await cp(join(preContract, "SKILL.md"), join(claude, "SKILL.md"));
  await mkdir(grok, { recursive: true });
  await writeFile(join(grok, "SKILL.md"), "---\nname: mine\n---\nMine\n");

  // AGENT_SKILL_HEAL=0 disables healing.
  expect(
    m.run(["version"], cli, { AGENT_SKILL_HEAL: "0" }).stderr,
  ).not.toContain("updated the");
  expect(readStamp(claude)).toEqual({});
  // The skill commands and read-only doctor never heal.
  m.run(["skill", "status"]);
  m.run(["doctor"]);
  expect(readStamp(agents)).toEqual({});

  const first = m.run(["version"]);
  expect(first.code).toBe(0);
  expect(healLines(first.stderr)).toEqual([
    expect.stringMatching(/agents, claude/),
  ]);
  for (const copy of [agents, claude]) {
    expect(readStamp(copy)?.version).toBe(version);
    expect(hashSkill(copy)).toBe(hashSkill(source));
  }
  expect(await readFile(join(grok, "SKILL.md"), "utf8")).toContain("Mine");
  expect(healLines(m.run(["version"]).stderr)).toEqual([]);
});

it("skips a skill another process is updating and reports failed directories", async () => {
  const m = await machine(".claude", ".grok");
  const claude = m.copy(".claude/skills");
  await cp(preContract, claude, { recursive: true });
  // A live process (this test worker) holds the per-skill lock.
  const lock = join(m.home, ".claude/skills", `.${name}.lock`);
  await mkdir(lock);
  await writeFile(join(lock, "pid"), String(process.pid));

  // Heal never waits and says nothing; the copy waits for a later run.
  const healed = m.run(["version"]);
  expect(healed.code).toBe(0);
  expect(healed.stderr).not.toMatch(/skill|lock/i);
  expect(readStamp(claude)).toEqual({});
  expect(existsSync(lock)).toBe(true);

  // Install reports a directory it cannot write and still installs the rest.
  await rm(lock, { recursive: true });
  await writeFile(join(m.home, ".grok/skills"), "not a directory\n");
  const install = m.run(["skill", "install"]);
  expect(install.code).toBe(1);
  expect(install.stdout).toMatch(/^grok .* failed: /m);
  expect(readStamp(claude)?.version).toBe(version);
  expect(healLines(m.run(["version"]).stderr)).toEqual([]);
});

it("never lets an older pinned coordinator downgrade a newer copy", async () => {
  const m = await machine(".claude", ".grok");
  // An older coordinator snapshot: lower package version, different skill.
  const older = join(m.home, "older");
  for (const entry of [
    "dist",
    "skill",
    "harnesses.json",
    "GLOBAL_AGENTS_SNIPPET.md",
  ])
    await cp(join(project, entry), join(older, entry), { recursive: true });
  await writeFile(
    join(older, "package.json"),
    JSON.stringify({ name: "sesh-integrator", version: "0.0.1" }),
  );
  await appendFile(join(older, "skill", name, "SKILL.md"), "\nOlder text.\n");
  const olderCli = join(older, "dist/cli.js");
  const claude = m.copy(".claude/skills");

  expect(m.run(["skill", "install"], olderCli).code).toBe(0);
  expect(readStamp(claude)?.version).toBe("0.0.1");

  // The newer CLI heals the older copy once.
  expect(healLines(m.run(["version"]).stderr)).toHaveLength(1);
  expect(readStamp(claude)?.version).toBe(version);
  // The older CLI's normal runs leave it; neither side flips it back.
  for (let round = 0; round < 2; round += 1) {
    expect(healLines(m.run(["version"], olderCli).stderr)).toEqual([]);
    expect(healLines(m.run(["version"]).stderr)).toEqual([]);
  }
  expect(hashSkill(claude)).toBe(hashSkill(source));
  // An older install refuses too, unless the user asks for the downgrade.
  const refused = m.run(["skill", "install"], olderCli);
  expect(refused.code).toBe(0);
  expect(refused.stdout).toContain("--allow-downgrade");
  expect(readStamp(claude)?.version).toBe(version);
  expect(m.run(["skill", "install", "--allow-downgrade"], olderCli).code).toBe(
    0,
  );
  expect(readStamp(claude)?.version).toBe("0.0.1");
});
