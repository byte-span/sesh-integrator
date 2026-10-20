import { afterEach, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import {
  configuredParticipants,
  findOnPath,
  settingsSuggestions,
} from "../src/dashboard-suggestions.js";
import { startWebDashboard } from "../src/dashboard-web.js";
import type { Config, RepositoryConfig } from "../src/types.js";

const roots: string[] = [];
const servers: Awaited<ReturnType<typeof startWebDashboard>>[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
  vi.unstubAllEnvs();
  await Promise.all(
    roots.splice(0).map((r) => rm(r, { recursive: true, force: true })),
  );
});

async function temp(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "dashboard-suggestions-"));
  roots.push(root);
  return root;
}

function git(cwd: string, ...args: string[]): void {
  const result = spawnSync(
    "git",
    [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    { cwd, encoding: "utf8" },
  );
  expect(result.status, result.stderr).toBe(0);
}

async function repository(root: string, name: string, branches: string[]) {
  const path = join(root, name);
  await mkdir(path);
  git(path, "init", "-b", "main");
  git(path, "commit", "--allow-empty", "-m", "Initial");
  for (const branch of branches) git(path, "branch", branch);
  return path;
}

const registration = (
  path: string,
  overrides: Partial<RepositoryConfig> = {},
): RepositoryConfig => ({
  path,
  gitCommonDir: join(path, ".git"),
  defaultBranch: "main",
  integrationBranch: "sesh-integrator/integration",
  setupCommands: [],
  sourceValidationCommands: [],
  integrationValidationCommands: [],
  postIntegrationCommands: [],
  conflictInstructions: "",
  ...overrides,
});

async function program(directory: string, name: string, mode = 0o755) {
  await mkdir(directory, { recursive: true });
  const file = join(directory, name);
  await writeFile(file, "#!/bin/sh\n");
  await chmod(file, mode);
  return file;
}

it("lists branches, remotes, configured names and programs without changing anything", async () => {
  const root = await temp();
  const alpha = await repository(root, "alpha", [
    "dev",
    "feature/x",
    "sesh-integrator/integration",
    "codex/session-mvh6psvj-3d5cbc7230",
  ]);
  git(alpha, "remote", "add", "origin", "https://example.com/alpha.git");
  git(alpha, "remote", "add", "upstream", "https://example.com/up.git");
  for (const ref of ["origin/main", "origin/release", "upstream/dev"])
    git(alpha, "update-ref", "refs/remotes/" + ref, "HEAD");
  git(
    alpha,
    "symbolic-ref",
    "refs/remotes/origin/HEAD",
    "refs/remotes/origin/main",
  );
  const beta = await repository(root, "beta", ["dev"]);
  const missing = join(root, "missing");
  const config: Config = {
    lockWaitSeconds: 900,
    defaultPromotion: { reviewers: ["platform-team"], assignees: ["bigobot"] },
    repositories: [
      registration(alpha, {
        promotion: {
          type: "pull-request",
          reviewers: ["byte-span/core", "Alice"],
          assignees: ["bigobot"],
        },
      }),
      registration(beta),
      registration(missing),
    ],
  };
  const bin = join(root, "bin"),
    other = join(root, "other");
  const gpg = await program(bin, "gpg"),
    claude = await program(bin, "claude");
  await program(bin, "gpg2", 0o644); // not executable
  await mkdir(join(bin, "gpgsm")); // a directory, not a program
  const gpgAgain = await program(other, "gpg"),
    keygen = await program(other, "ssh-keygen");
  // Like /bin -> /usr/bin: the same programs again under another name.
  const alias = join(root, "alias");
  await symlink(bin, alias);
  const before = await readdir(root, { recursive: true });

  const result = await settingsSuggestions(config, {
    PATH: [bin, "relative/bin", other, alias, bin].join(delimiter),
  });

  expect(result.repositories[0]).toEqual({
    path: alpha,
    name: "alpha",
    branches: ["dev", "feature/x", "main"],
    remoteBranches: { origin: ["main", "release"], upstream: ["dev"] },
    remotes: ["origin", "upstream"],
  });
  expect(result.repositories[1]).toMatchObject({
    name: "beta",
    branches: ["dev", "main"],
    remotes: [],
  });
  // An unreadable repository reports why and lists nothing.
  expect(result.repositories[2]).toMatchObject({
    name: "missing",
    branches: [],
    error: expect.any(String),
  });
  expect(result.participants).toEqual([
    "Alice",
    "bigobot",
    "byte-span/core",
    "platform-team",
  ]);
  expect(result.programs.signing).toEqual([
    { name: "gpg", paths: [gpg, gpgAgain] },
    { name: "ssh-keygen", paths: [keygen] },
  ]);
  expect(result.programs.harnesses.claude).toEqual([
    { name: "claude", paths: [claude] },
  ]);
  expect(result.programs.harnesses.codex).toEqual([]);
  expect(await readdir(root, { recursive: true })).toEqual(before);
});

it("finds Windows programs through PATHEXT", async () => {
  const bin = join(await temp(), "bin");
  await program(bin, "gpg");
  const cmd = await program(bin, "gpg.CMD");
  expect(
    await findOnPath("gpg", { Path: bin, PATHEXT: ".EXE;.CMD" }, "win32"),
  ).toEqual([cmd]);
  expect(await findOnPath("gpg", {})).toEqual([]);
});

it("collects reviewers and assignees only from pull-request settings", () => {
  expect(
    configuredParticipants({
      lockWaitSeconds: 1,
      repositories: [
        registration("/work/a", { promotion: { type: "none" } }),
        registration("/work/b", {
          promotion: { type: "pull-request", reviewers: ["zed", "amy"] },
        }),
      ],
    }),
  ).toEqual(["amy", "zed"]);
});

it("serves suggestions read-only from the dashboard", async () => {
  const root = await temp();
  const alpha = await repository(root, "alpha", ["dev"]);
  const runtime = join(root, "runtime");
  await mkdir(runtime);
  vi.stubEnv("SESH_INTEGRATOR_HOME", runtime);
  await writeFile(
    join(runtime, "config.json"),
    JSON.stringify({
      lockWaitSeconds: 900,
      repositories: [registration(alpha)],
    }),
  );
  const server = await startWebDashboard({ watch: () => () => {} });
  servers.push(server);
  const response = await fetch(server.url + "/api/settings/suggestions");
  expect(response.status).toBe(200);
  expect((await response.json()).repositories).toEqual([
    expect.objectContaining({ name: "alpha", branches: ["dev", "main"] }),
  ]);
  expect(
    (
      await fetch(server.url + "/api/settings/suggestions", {
        method: "POST",
        headers: { Origin: server.url, "Content-Type": "application/json" },
        body: "{}",
      })
    ).status,
  ).toBe(404);
  expect(
    (
      await fetch(server.url + "/api/settings/suggestions", {
        headers: { "Sec-Fetch-Site": "cross-site" },
      })
    ).status,
  ).toBe(403);
  expect(await readdir(runtime)).toEqual(["config.json"]);
});
