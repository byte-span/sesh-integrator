import { execFileSync, spawnSync } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

it("upgrades a clean Mac checkout and preserves dirty or divergent work", async () => {
  const root = await mkdtemp(join(tmpdir(), "sesh-macos-"));
  const env = {
    ...process.env,
    HOME: join(root, "home"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
  };
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", ["-C", cwd, ...args], {
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  try {
    const source = join(root, "source");
    await mkdir(source);
    await mkdir(env.HOME);
    git(source, "init", "-b", "dev");
    git(source, "config", "user.name", "Upgrade Test");
    git(source, "config", "user.email", "upgrade@local.invalid");
    await writeFile(
      join(source, "package.json"),
      '{"name":"parallel-integrator"}\n',
    );
    git(source, "add", ".");
    git(source, "commit", "-m", "baseline");
    const baseline = git(source, "rev-parse", "HEAD");
    const repo = join(root, "parallel-integrator");
    execFileSync("git", ["clone", source, repo], { env, stdio: "pipe" });
    git(
      repo,
      "remote",
      "set-url",
      "origin",
      "https://github.com/byte-span/parallel-integrator.git",
    );
    git(repo, "branch", "main");
    await mkdir(join(source, "scripts"));
    await mkdir(join(source, "dist"));
    await writeFile(
      join(source, "package.json"),
      '{"name":"sesh-integrator"}\n',
    );
    await writeFile(
      join(source, "scripts/install-cli.sh"),
      '#!/bin/sh\nset -eu\nprintf installed > "$HOME/installed"\n',
      { mode: 0o755 },
    );
    await writeFile(join(source, "dist/cli.js"), 'console.log("READY");\n');
    git(source, "add", ".");
    git(source, "commit", "-m", "rename");
    const upgraded = git(source, "rev-parse", "HEAD");
    const bundle = join(root, "source.bundle");
    git(source, "bundle", "create", bundle, "dev");
    const updater = join(root, "upgrade.sh");
    await writeFile(
      updater,
      (await readFile("scripts/update-macos.sh", "utf8")) +
        "\n__SESH_BUNDLE_BELOW__\n" +
        (await readFile(bundle)).toString("base64") +
        "\n",
    );
    const bin = join(root, "bin");
    await mkdir(bin);
    // Exercise macOS dispatch and BSD base64 decoding on a Linux test host.
    for (const [name, body] of Object.entries({
      uname: "echo Darwin",
      pnpm: "exit 0",
      base64:
        'exec node -e \'process.stdout.write(Buffer.from(require("fs").readFileSync(0,"utf8"),"base64"))\'',
    })) {
      await writeFile(join(bin, name), `#!/bin/sh\n${body}\n`);
      await chmod(join(bin, name), 0o755);
    }
    const run = (path: string) =>
      spawnSync("bash", [updater, path], {
        env: { ...env, PATH: `${bin}:${process.env.PATH}` },
        encoding: "utf8",
        timeout: 30000,
      });
    await writeFile(join(repo, "local.txt"), "keep me");
    expect(run(repo).stderr).toContain("Checkout has local changes");
    expect(git(repo, "rev-parse", "HEAD")).toBe(baseline);
    await rm(join(repo, "local.txt"));
    const result = run(repo);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    const renamed = join(root, "sesh-integrator");
    expect(await realpath(repo)).toBe(await realpath(renamed));
    expect(git(renamed, "rev-parse", "HEAD")).toBe(upgraded);
    expect(git(renamed, "rev-parse", "main")).toBe(baseline);
    expect(git(renamed, "remote", "get-url", "origin")).toBe(
      "https://github.com/byte-span/sesh-integrator.git",
    );
    expect(await readFile(join(env.HOME, "installed"), "utf8")).toBe(
      "installed",
    );
    expect(run(renamed).status).toBe(0);
    git(
      renamed,
      "-c",
      "user.name=Upgrade Test",
      "-c",
      "user.email=upgrade@local.invalid",
      "commit",
      "--allow-empty",
      "-m",
      "local work",
    );
    const local = git(renamed, "rev-parse", "HEAD");
    expect(run(renamed).stderr).toContain(
      "Local dev has commits outside this upgrade",
    );
    expect(git(renamed, "rev-parse", "HEAD")).toBe(local);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
