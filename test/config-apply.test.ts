import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";

const cli = join(process.cwd(), "dist/cli.js");
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

it("sets ordered layer includes and registrations idempotently, with --check exit codes", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "seshx-apply-")));
  roots.push(root);
  const code = join(root, "code");
  const runtime = join(root, "runtime");
  const configPath = join(runtime, "config.json");
  const env = {
    ...process.env,
    HOME: root,
    SESH_INTEGRATOR_HOME: runtime,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    PARALLEL_INTEGRATOR_TEST_INCIDENT_FALLBACK: "1",
  };
  const git = (cwd: string, args: string[]) =>
    execFileSync("git", args, { cwd, env, encoding: "utf8" }).trim();
  async function repo(name: string) {
    const path = join(code, name);
    await mkdir(path, { recursive: true });
    git(path, ["init", "-b", "main"]);
    git(path, ["config", "user.name", "Test"]);
    git(path, ["config", "user.email", "test@example.com"]);
    git(path, ["commit", "--allow-empty", "-m", "base"]);
    return path;
  }
  function run(args: string[], status: number) {
    const result = spawnSync(process.execPath, [cli, ...args], {
      cwd: root,
      env,
      encoding: "utf8",
      timeout: 30000,
    });
    expect(result.status, result.stdout + result.stderr).toBe(status);
    return { stdout: result.stdout, stderr: result.stderr };
  }
  const registration = (name: string, extra: object = {}) => ({
    path: `{{codeRoot}}/${name}`,
    gitCommonDir: `{{codeRoot}}/${name}/.git`,
    defaultBranch: "main",
    integrationBranch: "sesh-integrator/integration",
    sourceValidationCommands: [],
    integrationValidationCommands: [],
    ...extra,
  });
  const alpha = await repo("alpha");
  const beta = await repo("beta");
  const gamma = await repo("gamma");
  const layers = join(root, "cfg", "sesh");
  const layer = async (name: string, value: object) => {
    const file = join(layers, name);
    await mkdir(join(file, ".."), { recursive: true });
    await writeFile(file, JSON.stringify(value));
    return file;
  };
  const shared = await layer("shared.json", {
    lockWaitSeconds: 120,
    deliveryPolicyFile: "{{codeRoot}}/policy.json",
    repositories: [registration("alpha")],
  });
  // The OS layer changes one field of a shared registration and removes a
  // shared setting.
  const os = await layer("os/linux.json", {
    deliveryPolicyFile: null,
    repositories: [
      {
        path: "{{codeRoot}}/alpha",
        gitCommonDir: "{{codeRoot}}/alpha/.git",
        targetBranch: "release",
      },
    ],
  });
  const worker = await layer("roles/worker.json", {
    repositories: [registration("beta"), registration("not-cloned")],
  });
  const apply = (roleLayer: string, extra: string[] = []) => [
    "config",
    "apply",
    "--layer",
    shared,
    "--layer",
    os,
    "--layer",
    roleLayer,
    "--var",
    `codeRoot=${code}`,
    "--var",
    "unused=",
    "--drop-include",
    "~/old",
    "--drop-include",
    layers,
    "--register",
    gamma,
    "--register",
    join(code, "missing"),
    ...extra,
  ];

  // --check on a fresh machine reports what is pending and creates nothing.
  const pending = run(apply(worker, ["--check"]), 1);
  expect(pending.stdout.split("\n")[0]).toMatch(
    /^Pending: .*does not include the 3 layer\(s\).*; .*gamma is not registered$/,
  );
  expect(existsSync(runtime)).toBe(false);

  const applied = run(apply(worker), 0).stdout;
  expect(applied).toContain(`Included 3 layer(s) with vars codeRoot`);
  expect(applied).toContain(`Registering ${gamma}`);
  expect(applied).toContain(`${join(code, "not-cloned")} (from layer`);
  expect(applied).toContain(`${join(code, "missing")} is not a Git checkout`);
  const vars = { codeRoot: code };
  const saved = JSON.parse(await readFile(configPath, "utf8"));
  // A new config.json gets no defaults that would shadow the layers' values.
  expect(saved.lockWaitSeconds).toBeUndefined();
  expect(saved.codexCommand).toBeUndefined();
  expect(saved.include).toEqual([
    { path: shared, vars },
    { path: os, vars },
    { path: worker, vars },
  ]);
  expect(saved.repositories.map((r: { path: string }) => r.path)).toEqual([
    gamma,
  ]);

  const status = run(["status"], 0).stdout;
  expect(status).toMatch(
    new RegExp(
      `${alpha} \\[registered, enabled\\].*target release.*; source: include 2\\n`,
    ),
  );
  expect(status).toMatch(
    new RegExp(`${beta} \\[registered, enabled\\].*; source: include 3\\n`),
  );
  expect(status).toContain("setting deliveryPolicyFile: removed (null)");

  // Rerunning changes nothing.
  expect(run(apply(worker, ["--check"]), 0).stdout).toMatch(/^Up to date: /);
  const before = await readFile(configPath, "utf8");
  expect(run(apply(worker), 0).stdout).toContain(`Up to date: ${configPath}`);
  expect(await readFile(configPath, "utf8")).toBe(before);

  // A role change: the old role layer and an older include are dropped, the
  // new layers take their place and unrelated includes stay.
  await mkdir(join(root, "old"));
  await writeFile(join(root, "old", "sesh.json"), '{ "repositories": [] }');
  await writeFile(join(root, "other.json"), '{ "repositories": [] }');
  saved.include = [
    { path: "~/old/sesh.json" },
    ...saved.include,
    { path: "~/other.json" },
  ];
  await writeFile(configPath, JSON.stringify(saved, null, 2));
  const reviewer = await layer("roles/reviewer.json", {
    repositories: [registration("beta", { targetBranch: "review" })],
  });
  expect(run(apply(reviewer, ["--check"]), 1).stdout).toMatch(
    /^Pending: .*still includes ~\/old\/sesh\.json, .*worker\.json/,
  );
  const changed = run(apply(reviewer), 0).stdout;
  expect(changed).toContain("Stopped including ~/old/sesh.json");
  expect(changed).toContain(`Stopped including ${worker}`);
  expect(JSON.parse(await readFile(configPath, "utf8")).include).toEqual([
    { path: shared, vars },
    { path: os, vars },
    { path: reviewer, vars },
    { path: "~/other.json" },
  ]);

  // A layer that cannot load is an error (exit 2): nothing is written.
  const broken = await layer("roles/broken.json", {
    repositories: [registration("beta", { conflictInstructions: "{{nope}}" })],
  });
  const current = await readFile(configPath, "utf8");
  for (const extra of [["--check"], []])
    expect(run(apply(broken, extra), 2).stderr).toMatch(
      /layer .*broken\.json: .*unknown placeholder \{\{nope\}\}.*Nothing was changed/,
    );
  expect(await readFile(configPath, "utf8")).toBe(current);
  expect(run(["config", "apply", "--var", "a=b"], 2).stderr).toContain(
    "--var needs at least one --layer",
  );
});
