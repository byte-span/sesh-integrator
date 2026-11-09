import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
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

it("checks layer files offline: load with only the given vars, tokens, and the opt-in portable and older-coordinators rules", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "seshx-check-")));
  roots.push(root);
  const runtime = join(root, "runtime");
  // A plain argv with no runtime: nothing may be read from or written there.
  const env = {
    ...process.env,
    HOME: join(root, "home"),
    SESH_INTEGRATOR_HOME: runtime,
  };
  const layers = join(root, "repo", "sesh");
  await mkdir(join(layers, "roles"), { recursive: true });
  const write = (name: string, value: object) =>
    writeFile(join(layers, name), JSON.stringify(value, null, 2));
  function check(args: string[], status: number) {
    const result = spawnSync(
      process.execPath,
      [cli, "config", "check", ...args],
      {
        cwd: join(root, "repo"),
        env,
        encoding: "utf8",
        timeout: 30000,
      },
    );
    expect(result.status, result.stdout + result.stderr).toBe(status);
    return result.stdout.trim().split("\n");
  }
  const registration = (name: string, extra: object = {}) => ({
    path: `{{codeRoot}}/${name}`,
    gitCommonDir: `{{codeRoot}}/${name}/.git`,
    defaultBranch: "main",
    integrationBranch: "sesh-integrator/integration",
    sourceValidationCommands: [["npm", "test"]],
    integrationValidationCommands: [["{{toolBin}}/npm", "test"]],
    ...extra,
  });
  await write("shared.json", {
    $comment: "settings for every machine",
    defaultTargetBranch: "dev",
    lockWaitSeconds: 600,
    repositories: [],
  });
  await write("roles/worker.json", {
    repositories: [registration("alpha"), registration("beta")],
  });
  const good = [
    "--layer",
    "sesh/shared.json",
    "--layer",
    "sesh/roles/worker.json",
  ];
  const vars = ["--var", "codeRoot=/code", "--var", "toolBin=/tools"];

  expect(
    check([...good, ...vars, "--portable", "--older-coordinators"], 0),
  ).toEqual([
    "OK: 2 layer(s) with vars codeRoot, toolBin (checked load, token, portable, older-coordinators)",
  ]);
  // Only the vars passed count, like config apply; an empty value is left out.
  expect(
    check([...good, "--var", "codeRoot=/code", "--var", "toolBin="], 1),
  ).toEqual([
    "sesh/roles/worker.json: {{codeRoot}}/alpha: load: unknown placeholder {{toolBin}}; pass --var toolBin=VALUE",
    "sesh/roles/worker.json: {{codeRoot}}/beta: load: unknown placeholder {{toolBin}}; pass --var toolBin=VALUE",
    "2 problem(s) in 2 layer(s) (checked load, token)",
  ]);

  // Layering features current coordinators accept: a settings-only file, a
  // partial registration over an earlier one, and null. Plus machine values.
  const token = ["gh", "p_", "A1b2C3d4".repeat(5)].join("");
  await write("os.json", {
    lockWaitSeconds: 300,
    conflictResolutionMode: "current-session",
  });
  await write("roles/override.json", {
    repositories: [
      {
        path: "{{codeRoot}}/alpha",
        gitCommonDir: "{{codeRoot}}/alpha/.git",
        sourceValidationCommands: [["/home/me/bin/npm", "test"]],
        validationTiers: null,
      },
      registration("gamma", {
        setupCommands: [["C:\\Users\\me\\npm.cmd", "ci"]],
        conflictInstructions: `token ${token}`,
      }),
    ],
  });
  const layered = [
    ...good,
    "--layer",
    "sesh/os.json",
    "--layer",
    "sesh/roles/override.json",
    ...vars,
  ];
  // Loads and only the always-on rules apply: the token fails, the rest is valid.
  expect(check(layered, 1)).toEqual([
    "sesh/roles/override.json: {{codeRoot}}/gamma (conflictInstructions): token: a value looks like a GitHub token; remove it and keep secrets out of configuration",
    "1 problem(s) in 4 layer(s) (checked load, token)",
  ]);
  const strict = check([...layered, "--portable", "--older-coordinators"], 1);
  expect(strict).toEqual([
    'sesh/os.json: older-coordinators: no "repositories" list; older coordinators reject an included file without one (add "repositories": [])',
    'sesh/roles/override.json: {{codeRoot}}/alpha (sourceValidationCommands[0][0]): portable: machine-specific path "/home/me/bin/npm"; use a {{name}} placeholder and pass --var',
    "sesh/roles/override.json: {{codeRoot}}/alpha (validationTiers): older-coordinators: null; older coordinators fail an include that sets null",
    'sesh/roles/override.json: {{codeRoot}}/gamma (setupCommands[0][0]): portable: machine-specific path "C:\\\\Users\\\\me\\\\npm.cmd"; use a {{name}} placeholder and pass --var',
    "sesh/roles/override.json: {{codeRoot}}/gamma (conflictInstructions): token: a value looks like a GitHub token; remove it and keep secrets out of configuration",
    "sesh/roles/override.json: {{codeRoot}}/alpha: older-coordinators: no defaultBranch, integrationBranch, integrationValidationCommands; older coordinators replace an included registration whole, so it must be complete",
    "6 problem(s) in 4 layer(s) (checked load, token, portable, older-coordinators)",
  ]);
  expect(strict.join("\n")).not.toContain(token);

  // A file that cannot load, and a setting this seshx rejects.
  await write("roles/broken.json", {
    defaultTargetBranch: "",
    repositories: [],
  });
  expect(
    check(
      [
        ...good,
        ...vars,
        "--layer",
        "sesh/missing.json",
        "--layer",
        "sesh/roles/broken.json",
      ],
      1,
    ),
  ).toEqual([
    `sesh/missing.json: load: file not found: ${join(layers, "missing.json")}`,
    'sesh/roles/broken.json: load: invalid "defaultTargetBranch": not a valid value; see the configuration reference',
    "2 problem(s) in 4 layer(s) (checked load, token)",
  ]);
  // Usage errors exit 2, like config apply.
  check(["--portable"], 2);
  check([...good, "--check"], 2);
  expect(existsSync(runtime)).toBe(false);
});
