import { execFileSync, spawnSync } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";

const roots: string[] = [];
const block =
  "<!-- codex-handoff:managed:start -->\n\n## codex-handoff workflow\n\nUse codex-handoff.\n<!-- codex-handoff:managed:end -->\n";
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

function git(repo: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd: repo,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function fixture(contents: Array<string | undefined>) {
  const root = await mkdtemp(join(tmpdir(), "sesh-integrator-cleanup-"));
  roots.push(root);
  const runtime = join(root, "runtime");
  await mkdir(runtime);
  const repos: string[] = [];
  for (let index = 0; index < contents.length; index++) {
    const repo = join(root, `repo-${index}`);
    repos.push(repo);
    await mkdir(repo);
    git(repo, "init", "-b", "main");
    if (contents[index] !== undefined)
      await writeFile(join(repo, "AGENTS.md"), contents[index]!);
  }
  await writeFile(
    join(runtime, "config.json"),
    JSON.stringify({ repositories: repos.map((path) => ({ path })) }),
  );
  const run = (...args: string[]) =>
    spawnSync(
      process.execPath,
      [join(process.cwd(), "dist", "cli.js"), "cleanup-guidance", ...args],
      {
        env: { ...process.env, PARALLEL_INTEGRATOR_HOME: runtime },
        encoding: "utf8",
      },
    );
  return { root, runtime, repos, run };
}

it("previews without writing, then cleans all registered repos with backups and an unchanged Git index", async () => {
  const prefix = "# Project rules\r\nPreserve café exactly.\r\n\r\n";
  const suffix = "\r\n## More rules\r\nPreserve this too.\r\n";
  const mixed = prefix + block.replaceAll("\n", "\r\n") + suffix;
  const custom = "# Custom project\nNo integrator instructions.\n";
  const f = await fixture([undefined, custom, mixed, block]);
  const mixedRepo = f.repos[2]!;
  git(mixedRepo, "add", "AGENTS.md");
  git(
    mixedRepo,
    "-c",
    "commit.gpgsign=false",
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@local.invalid",
    "commit",
    "-m",
    "Project instructions",
  );
  await chmod(join(mixedRepo, "AGENTS.md"), 0o640);
  const index = git(mixedRepo, "ls-files", "--stage");
  const head = git(mixedRepo, "rev-parse", "HEAD");
  const preview = f.run();
  expect(preview.status, preview.stderr).toBe(0);
  expect(preview.stdout).toContain("2 eligible; 0 skipped");
  expect(await readdir(f.runtime)).toEqual(["config.json"]);
  expect(await readFile(join(mixedRepo, "AGENTS.md"), "utf8")).toBe(mixed);
  const result = f.run("--apply");
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain("2 cleaned; 0 skipped");
  expect(await readFile(join(mixedRepo, "AGENTS.md"), "utf8")).toBe(
    prefix + suffix,
  );
  expect((await stat(join(mixedRepo, "AGENTS.md"))).mode & 0o777).toBe(0o640);
  expect(await readFile(join(f.repos[1]!, "AGENTS.md"), "utf8")).toBe(custom);
  expect(await readdir(f.repos[0]!)).toEqual([".git"]);
  await expect(stat(join(f.repos[3]!, "AGENTS.md"))).rejects.toMatchObject({
    code: "ENOENT",
  });
  expect(git(mixedRepo, "ls-files", "--stage")).toBe(index);
  expect(git(mixedRepo, "rev-parse", "HEAD")).toBe(head);
  const backups = await readdir(join(f.runtime, "guidance-backups"));
  expect(backups).toHaveLength(2);
  for (const backup of backups) {
    const dir = join(f.runtime, "guidance-backups", backup);
    const metadata = JSON.parse(
      await readFile(join(dir, "metadata.json"), "utf8"),
    );
    expect(await readFile(join(dir, "AGENTS.md"), "utf8")).toBe(
      metadata.path === join(mixedRepo, "AGENTS.md") ? mixed : block,
    );
  }
  expect(f.run("--apply").stdout).toContain("0 cleaned; 0 skipped");
});

it.each([
  block.replace("<!-- codex-handoff:managed:end -->", ""),
  block + block,
  "```markdown\n" + block + "```\n",
  block.replace("## codex-handoff workflow", "## Unrecognized instructions"),
])("preserves malformed, ambiguous, or example blocks", async (contents) => {
  const f = await fixture([contents, block]);
  const result = f.run("--apply");
  expect(result.status).toBe(1);
  expect(result.stdout).toContain("1 cleaned; 1 skipped");
  expect(await readFile(join(f.repos[0]!, "AGENTS.md"), "utf8")).toBe(contents);
});

it("skips symlinks and staged instructions", async () => {
  const f = await fixture([undefined, block]);
  const outside = join(f.root, "outside.md");
  await writeFile(outside, block);
  await symlink(outside, join(f.repos[0]!, "AGENTS.md"));
  git(f.repos[1]!, "add", "AGENTS.md");
  const result = f.run("--apply");
  expect(result.status).toBe(1);
  expect(result.stdout).toContain("0 cleaned; 2 skipped");
  expect(await readFile(outside, "utf8")).toBe(block);
  expect(await readFile(join(f.repos[1]!, "AGENTS.md"), "utf8")).toBe(block);
  expect(await readdir(f.runtime)).toEqual(["config.json"]);
});

it("rejects unknown options before touching files", async () => {
  const f = await fixture([block]);
  const result = f.run("--force");
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("Usage: seshx cleanup-guidance");
  expect(await readFile(join(f.repos[0]!, "AGENTS.md"), "utf8")).toBe(block);
});

it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
  "continues after a checkout refuses temporary-file creation",
  async () => {
    const contents = "# Project rules\n\n" + block;
    const f = await fixture([contents, block]);
    await chmod(f.repos[0]!, 0o500);
    try {
      const result = f.run("--apply");
      expect(result.status).toBe(1);
      expect(result.stdout).toContain("1 cleaned; 1 skipped");
      expect(await readFile(join(f.repos[0]!, "AGENTS.md"), "utf8")).toBe(
        contents,
      );
      await expect(stat(join(f.repos[1]!, "AGENTS.md"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await chmod(f.repos[0]!, 0o700);
    }
  },
);
