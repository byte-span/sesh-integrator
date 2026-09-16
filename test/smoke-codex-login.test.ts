import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, it } from "vitest";
import {
  codexLoginPaths,
  createCodexLoginCommand,
} from "../smoke/codex-login.js";

it("uses the existing Codex home without a separate login or budget setting", () => {
  expect(codexLoginPaths({}, "/normal-home")).toEqual({
    HOME: "/normal-home",
    CODEX_HOME: "/normal-home/.codex",
    XDG_CONFIG_HOME: "/normal-home/.config",
  });
  expect(
    codexLoginPaths(
      { CODEX_HOME: "/custom-codex", XDG_CONFIG_HOME: "/custom-config" },
      "/normal-home",
    ),
  ).toEqual({
    HOME: "/normal-home",
    CODEX_HOME: "/custom-codex",
    XDG_CONFIG_HOME: "/custom-config",
  });
  expect(
    codexLoginPaths(
      { SESH_SMOKE_HOME: "/optional-test-home", CODEX_HOME: "/custom-codex" },
      "/normal-home",
    ).CODEX_HOME,
  ).toBe("/optional-test-home/.codex");
});

it("preserves sandbox arguments, stdin and failure status while selecting login paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "sesh-login-routing-"));
  try {
    const bin = join(root, "bin");
    await mkdir(bin);
    await writeFile(
      join(bin, "codex"),
      `#!/usr/bin/env node
const fs = require('fs');
console.log(JSON.stringify({ args: process.argv.slice(2), input: fs.readFileSync(0, 'utf8'), home: process.env.HOME, codexHome: process.env.CODEX_HOME, runtime: process.env.SESH_INTEGRATOR_HOME }));
process.exit(7);
`,
      { mode: 0o700 },
    );
    // These nonexistent homes prove the launcher never reads or copies auth files.
    const paths = codexLoginPaths(
      { CODEX_HOME: join(root, "login") },
      join(root, "user"),
    );
    const executable = await createCodexLoginCommand(root, paths);
    const args = ["exec", "--sandbox", "workspace-write", "-"];
    const result = spawnSync(process.execPath, [executable, ...args], {
      env: {
        PATH: `${bin}:${dirname(process.execPath)}`,
        HOME: root,
        CODEX_HOME: join(root, "isolated"),
        SESH_INTEGRATOR_HOME: join(root, "runtime"),
      },
      input: "fixture prompt",
      encoding: "utf8",
      timeout: 5000,
    });
    expect(result.status).toBe(7);
    expect(JSON.parse(result.stdout)).toEqual({
      args,
      input: "fixture prompt",
      home: paths.HOME,
      codexHome: paths.CODEX_HOME,
      runtime: join(root, "runtime"),
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
