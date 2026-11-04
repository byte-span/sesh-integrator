import { execFileSync, spawnSync } from "node:child_process";
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

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "seshx-include-")));
  roots.push(root);
  const code = join(root, "code");
  const runtime = join(root, "runtime");
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
  function run(args: string[], cwd: string, status = 0) {
    const result = spawnSync(process.execPath, [cli, ...args], {
      cwd,
      env,
      encoding: "utf8",
      timeout: 30000,
    });
    if (status >= 0)
      expect(result.status, result.stdout + result.stderr).toBe(status);
    return result.stdout + result.stderr;
  }
  const configPath = join(runtime, "config.json");
  const readConfig = async () =>
    JSON.parse(await readFile(configPath, "utf8")) as {
      include?: unknown;
      repositories: { path: string }[];
    };
  async function writeConfig(
    update: (config: Record<string, unknown>) => void,
  ) {
    const config = (await readConfig()) as unknown as Record<string, unknown>;
    update(config);
    await writeFile(configPath, JSON.stringify(config, null, 2));
  }
  // A registration in the shape fig-sync generates.
  const registration = (name: string, extra: object = {}) => ({
    path: `{{codeRoot}}/${name}`,
    gitCommonDir: `{{codeRoot}}/${name}/.git`,
    defaultBranch: "main",
    integrationBranch: "sesh-integrator/integration",
    sourceValidationCommands: [],
    integrationValidationCommands: [],
    ...extra,
  });
  return {
    root,
    code,
    runtime,
    git,
    repo,
    run,
    readConfig,
    writeConfig,
    registration,
  };
}

it("loads included registrations with filled placeholders, keeps local ones first and writes only local entries", async () => {
  const f = await fixture();
  const alpha = await f.repo("alpha");
  const beta = await f.repo("beta");
  f.run(["register"], beta);
  // Validation proves the filled command runs: it records the filled path.
  const record = (label: string) => [
    "{{node}}",
    "-e",
    `require("fs").appendFileSync("{{codeRoot}}/validated.log", "${label}\\n")`,
  ];
  await mkdir(join(f.root, "fig"));
  await writeFile(
    join(f.root, "fig", "sesh.json"),
    JSON.stringify({
      repositories: [
        f.registration("alpha", {
          sourceValidationCommands: [record("first")],
        }),
        f.registration("beta", { sourceValidationCommands: [["false"]] }),
        f.registration("gamma"),
      ],
    }),
  );
  await writeFile(
    join(f.root, "later.json"),
    JSON.stringify({
      repositories: [
        f.registration("alpha", {
          sourceValidationCommands: [record("later")],
        }),
      ],
    }),
  );
  await f.writeConfig((config) => {
    config.include = [
      {
        path: "../fig/sesh.json",
        vars: { codeRoot: f.code, node: process.execPath },
      },
      {
        path: "~/later.json",
        vars: { codeRoot: f.code, node: process.execPath },
      },
    ];
  });

  const status = f.run(["status"], alpha);
  expect(status).toContain("Registration: registered");
  expect(status).toContain(`${alpha} [registered, enabled]: staging`);
  expect(status).toMatch(
    new RegExp(`${beta} \\[registered, enabled\\].*; source: local\\n`),
  );
  expect(status).toMatch(
    new RegExp(`${alpha} \\[registered, enabled\\].*; source: include 2\\n`),
  );
  expect(status).toContain("Includes: 2");
  expect(status).toContain(
    `include 1 (${join(f.root, "fig", "sesh.json")}): 0 registration(s) loaded`,
  );
  expect(status).toContain(`${alpha}: replaced by include 2`);
  expect(status).toContain(`${beta}: replaced by a local registration`);
  expect(status).toContain(
    `${join(f.code, "gamma")}: checkout does not exist yet; skipped`,
  );
  expect(status).toContain(
    `include 2 (${join(f.root, "later.json")}): 1 registration(s) loaded`,
  );
  const doctor = f.run(["doctor"], alpha, -1);
  expect(doctor).toContain("PASS  Registered repository");
  expect(doctor).toMatch(
    /WARN {2}Configuration includes: .*gamma: checkout does not exist yet/,
  );

  // Registration never copies an included entry into config.json.
  const before = await readFile(join(f.runtime, "config.json"), "utf8");
  expect(f.run(["register", "--auto-config"], alpha)).toContain(
    "Repository already registered by include 2",
  );
  expect(
    f.run(["register", "--setup-command", '["true"]'], alpha, 1),
  ).toContain("registration comes from include 2");
  expect(await readFile(join(f.runtime, "config.json"), "utf8")).toBe(before);
  f.run(["register", "--auto-config"], beta);
  const saved = await f.readConfig();
  expect(saved.repositories.map((repository) => repository.path)).toEqual([
    beta,
  ]);
  expect(saved.include).toHaveLength(2);

  // The whole lifecycle runs on the included registration.
  const linked = join(f.root, "alpha-task");
  f.git(alpha, ["worktree", "add", "-b", "task", linked]);
  f.run(["begin", "--summary", "included task"], linked);
  await writeFile(join(linked, "task.txt"), "task\n");
  f.git(linked, ["add", "task.txt"]);
  f.run(["commit", "--message", "task"], linked);
  f.run(["validate"], linked);
  f.run(["integrate", "--summary", "task", "--rollout", "none"], linked);
  expect(f.git(alpha, ["show", "main:task.txt"])).toBe("task");
  expect(await readFile(join(f.code, "validated.log"), "utf8")).toMatch(
    /^later\n/,
  );
});

it("reports broken includes without breaking local registrations or letting register shadow them", async () => {
  const f = await fixture();
  const local = await f.repo("local");
  const shared = await f.repo("shared");
  f.run(["register"], local);
  await writeFile(
    join(f.root, "unknown.json"),
    JSON.stringify({
      repositories: [
        f.registration("shared", {
          setupCommands: [["{{fnmBin}}", "install"]],
        }),
      ],
    }),
  );
  await writeFile(
    join(f.root, "spaced.json"),
    JSON.stringify({
      repositories: [
        f.registration("shared", { path: "{{ codeRoot }}/shared" }),
      ],
    }),
  );
  await f.writeConfig((config) => {
    config.include = [
      { path: join(f.root, "unknown.json"), vars: { codeRoot: f.code } },
      { path: join(f.root, "missing.json"), vars: { codeRoot: f.code } },
      { path: join(f.root, "spaced.json"), vars: { codeRoot: f.code } },
      { path: join(f.root, "unknown.json"), var: {} },
    ];
  });

  const status = f.run(["status"], local);
  expect(status).toContain("Includes: 4");
  expect(status).toContain(
    'not loaded: repositories[0].setupCommands[0][0]: unknown placeholder {{fnmBin}}; add "fnmBin" to this include\'s vars',
  );
  expect(status).toContain(
    `not loaded: file not found: ${join(f.root, "missing.json")}`,
  );
  expect(status).toContain("malformed placeholder {{ codeRoot }}");
  expect(status).toContain('not loaded: unknown key "var"');

  // Local registrations keep their whole lifecycle.
  const linked = join(f.root, "local-task");
  f.git(local, ["worktree", "add", "-b", "task", linked]);
  f.run(["begin", "--summary", "local task"], linked);
  await writeFile(join(linked, "task.txt"), "task\n");
  f.git(linked, ["add", "task.txt"]);
  f.run(["commit", "--message", "task"], linked);
  f.run(["validate"], linked);
  f.run(["integrate", "--summary", "task", "--rollout", "none"], linked);
  expect(f.git(local, ["show", "main:task.txt"])).toBe("task");

  // A repository the broken include should register is neither started nor
  // registered locally, which would hide the include once it is fixed.
  expect(f.run(["begin", "--summary", "shared task"], shared, 1)).toContain(
    "Repository is not registered, and include 1",
  );
  expect(f.run(["register"], shared, 1)).toContain(`Not registering ${shared}`);
  expect((await f.readConfig()).repositories.map((r) => r.path)).toEqual([
    local,
  ]);
});
