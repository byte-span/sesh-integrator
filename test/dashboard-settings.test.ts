import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applySettings,
  loadSettings,
  loadSettingsJson,
  parseConfigText,
  parseSettingsJsonRequest,
  parseSettingsRequest,
  saveSettings,
  saveSettingsJson,
  settingsRevision,
  settingsView,
  type GlobalSettings,
  type RepositorySettings,
} from "../src/dashboard-settings.js";
import { startWebDashboard } from "../src/dashboard-web.js";
import { acquireRepoLock, releaseRepoLock } from "../src/lock.js";
import { repoId } from "../src/runtime.js";
import type { Config } from "../src/types.js";

const roots: string[] = [];
const servers: Awaited<ReturnType<typeof startWebDashboard>>[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
  vi.unstubAllEnvs();
  await Promise.all(
    roots.splice(0).map((r) => rm(r, { recursive: true, force: true })),
  );
});

function config(): Config {
  return {
    lockWaitSeconds: 900,
    codexCommand: "codex",
    defaultTargetBranch: "dev",
    defaultPromotion: { reviewers: ["platform-team"] },
    repositories: [
      {
        path: "/work/alpha",
        gitCommonDir: "/work/alpha/.git",
        defaultBranch: "main",
        integrationBranch: "sesh-integrator/integration",
        promotion: { type: "pull-request", remote: "origin" },
        setupCommands: [["pnpm", "install"]],
        setupCommandPolicy: "advisory",
        sourceValidationCommands: [
          {
            parallel: [
              ["pnpm", "test"],
              ["pnpm", "run", "a b"],
            ],
          },
        ],
        integrationValidationCommands: [["pnpm", "build"]],
        postIntegrationCommands: [],
        conflictInstructions: "Keep both.",
      },
    ],
  };
}

const global = (overrides: Partial<GlobalSettings> = {}): GlobalSettings => ({
  defaultTargetBranch: "dev",
  lockWaitSeconds: 900,
  conflictResolutionMode: "current-session",
  reviewers: ["platform-team"],
  assignees: [],
  deliveryPolicyFile: "",
  harnessCommands: { codex: "codex", claude: "", antigravity: "", grok: "" },
  ...overrides,
});

const repository = (
  overrides: Partial<RepositorySettings> = {},
): RepositorySettings => ({
  enabled: true,
  targetBranch: "",
  promotion: {
    type: "pull-request",
    mode: "shared-target",
    productionBranch: "",
    remote: "origin",
    reviewers: null,
    assignees: null,
  },
  validationCache: "session",
  setupCommandPolicy: "advisory",
  conflictInstructions: "Keep both.",
  gpgProgram: "",
  ...overrides,
});

const revision = "a".repeat(64);

async function runtime(stored?: Config): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "dashboard-settings-"));
  roots.push(root);
  vi.stubEnv("SESH_INTEGRATOR_HOME", root);
  if (stored)
    await writeFile(join(root, "config.json"), JSON.stringify(stored, null, 2));
  return root;
}

it("projects effective settings, inheritance and read-only commands", () => {
  const view = settingsView("{}", config());
  expect(view.revision).toBe(settingsRevision("{}"));
  expect(view.global).toMatchObject({
    defaultTargetBranch: "dev",
    reviewers: ["platform-team"],
    assignees: [],
    conflictResolutionMode: "current-session",
  });
  expect(view.global.harnessCommands).toEqual(global().harnessCommands);
  expect(view.harnesses).toContainEqual({
    id: "antigravity",
    name: "Antigravity CLI",
    defaultCommand: "agy",
    effectiveCommand: "agy",
  });
  const [repo] = view.repositories;
  expect(repo).toMatchObject({
    name: "alpha",
    enabled: true,
    targetBranch: "",
    effectiveTargetBranch: "dev",
    targetSource: "global default",
    validationCache: "session",
    promotion: { type: "pull-request", reviewers: null, remote: "origin" },
  });
  expect(repo!.commands).toEqual([
    { label: "Setup", lines: ["pnpm install"] },
    {
      label: "Source validation",
      lines: ["In parallel:", "  pnpm test", '  pnpm run "a b"'],
    },
    { label: "Integration validation", lines: ["pnpm build"] },
    { label: "Post-integration", lines: [] },
  ]);
});

it("accepts only the editable fields with safe values", () => {
  const base = { scope: "global", revision, values: global() };
  expect(parseSettingsRequest(base)).toEqual(base);
  for (const bad of [
    { ...base, revision: "stale" },
    { ...base, scope: "commands" },
    { ...base, extra: true },
    { ...base, values: { ...global(), codexCommand: "sh" } },
    { ...base, values: global({ defaultTargetBranch: "bad..name" }) },
    { ...base, values: global({ lockWaitSeconds: 1.5 }) },
    { ...base, values: global({ lockWaitSeconds: -1 }) },
    { ...base, values: global({ reviewers: ["--add-label=x"] }) },
    { ...base, values: global({ conflictResolutionMode: "shell" }) },
    {
      scope: "repository",
      revision,
      repository: "/work/alpha",
      values: { ...repository(), setupCommands: [["rm", "-rf", "/"]] },
    },
    {
      scope: "repository",
      revision,
      repository: "/work/alpha",
      values: repository({ enabled: "yes" as unknown as boolean }),
    },
  ])
    expect(() => parseSettingsRequest(bad)).toThrow();
});

it("changes only edited global fields and drops emptied optional values", () => {
  const stored = {
    ...config(),
    deliveryPolicyFile: "policy.json",
    customKey: "kept",
  } as Config;
  const request = (values: GlobalSettings) =>
    parseSettingsRequest({ scope: "global", revision, values });
  expect(
    applySettings(
      stored,
      request(global({ deliveryPolicyFile: "policy.json" })),
    ),
  ).toEqual(stored);
  const next = applySettings(
    stored,
    request(
      global({
        defaultTargetBranch: "next",
        lockWaitSeconds: 60,
        reviewers: [],
        deliveryPolicyFile: "",
        conflictResolutionMode: "nested-agent",
      }),
    ),
  );
  expect(next).not.toHaveProperty("deliveryPolicyFile");
  expect(next).not.toHaveProperty("defaultPromotion");
  expect(next).toMatchObject({
    defaultTargetBranch: "next",
    lockWaitSeconds: 60,
    conflictResolutionMode: "nested-agent",
    customKey: "kept",
  });
  expect(next.repositories).toEqual(stored.repositories);
  // Without a global target, alpha would promote to its production branch.
  expect(() =>
    applySettings(stored, request(global({ defaultTargetBranch: "" }))),
  ).toThrow("target and production branches must differ");
});

it("edits a repository and refuses settings the CLI would reject", () => {
  const stored = config();
  const request = (values: RepositorySettings) =>
    ({
      scope: "repository",
      revision,
      repository: "/work/alpha",
      values,
    }) as const;
  const next = applySettings(
    stored,
    request(
      repository({
        enabled: false,
        targetBranch: "release",
        validationCache: "off",
        promotion: {
          ...repository().promotion,
          mode: "session-branch",
          reviewers: [],
        },
      }),
    ),
  );
  expect(next.disabledRepositories).toEqual(["/work/alpha/.git"]);
  expect(next.repositories[0]).toMatchObject({
    targetBranch: "release",
    validationCache: "off",
    setupCommandPolicy: "advisory",
    promotion: {
      type: "pull-request",
      mode: "session-branch",
      remote: "origin",
      reviewers: [],
    },
  });
  expect(next.repositories[0]!.promotion).not.toHaveProperty("assignees");
  expect(
    applySettings(next, request(repository({ enabled: true })))
      .disabledRepositories,
  ).toEqual([]);
  expect(() =>
    applySettings(
      stored,
      request(repository({ targetBranch: "sesh-integrator/integration" })),
    ),
  ).toThrow("must differ from the staging branch");
  expect(() =>
    applySettings(
      stored,
      request(
        repository({
          targetBranch: "main",
          promotion: { ...repository().promotion, productionBranch: "" },
        }),
      ),
    ),
  ).toThrow("target and production branches must differ");
  expect(() =>
    applySettings(stored, { ...request(repository()), repository: "/gone" }),
  ).toThrow("no longer registered");
});

it("edits agent commands and signing programs, keeping the legacy alias in step", () => {
  const stored = config();
  const request = (values: GlobalSettings) =>
    parseSettingsRequest({ scope: "global", revision, values });
  const commands = (
    overrides: Partial<GlobalSettings["harnessCommands"]>,
  ): GlobalSettings["harnessCommands"] => ({
    codex: "",
    claude: "",
    antigravity: "",
    grok: "",
    ...overrides,
  });
  const next = applySettings(
    stored,
    request(
      global({
        harnessCommands: commands({
          codex: " /opt/codex ",
          claude: "/usr/local/bin/claude",
        }),
      }),
    ),
  );
  // Older coordinators read only codexCommand.
  expect(next).toMatchObject({
    codexCommand: "/opt/codex",
    harnessCommands: { codex: "/opt/codex", claude: "/usr/local/bin/claude" },
  });
  expect(settingsView("{}", next).harnesses).toContainEqual({
    id: "claude",
    name: "Claude Code",
    defaultCommand: "claude",
    effectiveCommand: "/usr/local/bin/claude",
  });
  const cleared = applySettings(
    next,
    request(global({ harnessCommands: commands({}) })),
  );
  expect(cleared).not.toHaveProperty("harnessCommands");
  expect(cleared).not.toHaveProperty("codexCommand");
  // Commands for harnesses the form does not show are kept.
  const legacy = { ...config(), harnessCommands: { gemini: "gemini" } };
  expect(
    applySettings(
      legacy,
      request(
        global({ harnessCommands: commands({ codex: "codex", grok: "g" }) }),
      ),
    ).harnessCommands,
  ).toEqual({ gemini: "gemini", grok: "g" });
  for (const bad of [
    { ...commands({}), gemini: "gemini" },
    { codex: "codex" },
    commands({ claude: "claude\n--dangerously-skip-permissions" }),
  ])
    expect(() =>
      request(
        global({ harnessCommands: bad as GlobalSettings["harnessCommands"] }),
      ),
    ).toThrow();

  const repositoryRequest = (values: RepositorySettings) =>
    ({
      scope: "repository",
      revision,
      repository: "/work/alpha",
      values,
    }) as const;
  const signed = applySettings(
    stored,
    repositoryRequest(repository({ gpgProgram: "/usr/bin/gpg2" })),
  );
  expect(signed.repositories[0]!.gpgProgram).toBe("/usr/bin/gpg2");
  expect(settingsView("{}", signed).repositories[0]!.gpgProgram).toBe(
    "/usr/bin/gpg2",
  );
  expect(
    applySettings(signed, repositoryRequest(repository())).repositories[0],
  ).not.toHaveProperty("gpgProgram");
  expect(() =>
    parseSettingsRequest(
      repositoryRequest(repository({ gpgProgram: "gpg\rx" })),
    ),
  ).toThrow("single line");
});

it("saves under locks, rejects stale forms and never rewrites unchanged config", async () => {
  const root = await runtime(config());
  const path = join(root, "config.json");
  const before = await readFile(path, "utf8");
  const view = await loadSettings();
  await expect(
    saveSettings({
      scope: "global",
      revision: settingsRevision("other"),
      values: global({ lockWaitSeconds: 5 }),
    }),
  ).rejects.toThrow("changed since this form was loaded");
  await saveSettings({
    scope: "global",
    revision: view.revision,
    values: global(),
  });
  expect(await readFile(path, "utf8")).toBe(before);
  const lock = await acquireRepoLock(
    repoId("/work/alpha/.git"),
    "integrating",
    0,
    join(root, "worktrees", "x"),
  );
  await expect(
    saveSettings({
      scope: "repository",
      revision: view.revision,
      repository: "/work/alpha",
      values: repository({ targetBranch: "release" }),
    }),
  ).rejects.toThrow("Cannot change repository settings");
  await releaseRepoLock(lock);
  const saved = await saveSettings({
    scope: "repository",
    revision: view.revision,
    repository: "/work/alpha",
    values: repository({ targetBranch: "release" }),
  });
  expect(saved.revision).not.toBe(view.revision);
  expect(saved.repositories[0]!.effectiveTargetBranch).toBe("release");
  expect(JSON.parse(await readFile(path, "utf8")).repositories[0]).toEqual({
    ...config().repositories[0],
    targetBranch: "release",
  });
});

it("serves settings without creating state and requires same-origin saves", async () => {
  const root = await runtime();
  const server = await startWebDashboard({ watch: () => () => {} });
  servers.push(server);
  const page = await (await fetch(server.url)).text();
  expect(page).toContain('id="settings-button"');
  expect(page).toContain('role="tablist"');
  const loaded = await (await fetch(server.url + "/api/settings")).json();
  expect(loaded).toMatchObject({
    exists: false,
    global: { lockWaitSeconds: 900 },
    repositories: [],
  });
  expect(await readdir(root)).toEqual([]);
  const body = JSON.stringify({
    scope: "global",
    revision: loaded.revision,
    values: global({ defaultTargetBranch: "", reviewers: [] }),
  });
  const headers = {
    Origin: server.url,
    "Content-Type": "application/json",
    "X-Sesh-Dashboard": "1",
  };
  for (const forged of [
    { ...headers, Origin: "https://attacker.example" },
    { ...headers, "X-Sesh-Dashboard": "0" },
    { ...headers, "Content-Type": "text/plain" },
  ])
    expect(
      (
        await fetch(server.url + "/api/settings", {
          method: "POST",
          headers: forged,
          body,
        })
      ).status,
    ).toBe(403);
  expect(await readdir(root)).toEqual([]);
  const response = await fetch(server.url + "/api/settings", {
    method: "POST",
    headers,
    body: body.replace('"lockWaitSeconds":900', '"lockWaitSeconds":30'),
  });
  expect(response.status).toBe(200);
  expect((await response.json()).global.lockWaitSeconds).toBe(30);
  expect(
    JSON.parse(await readFile(join(root, "config.json"), "utf8")),
  ).toMatchObject({ lockWaitSeconds: 30 });
  const invalid = await fetch(server.url + "/api/settings", {
    method: "POST",
    headers,
    body: JSON.stringify({ scope: "global", revision, values: {} }),
  });
  expect(invalid.status).toBe(400);
});

const text = (value: Config) => JSON.stringify(value, null, 2);

it("parses edited config text with CLI validation and fixed registrations", () => {
  const stored = config();
  const edited = config();
  edited.lockWaitSeconds = 30;
  edited.repositories[0]!.setupCommands = [["npm", "ci"]];
  expect(parseConfigText(text(edited), stored)).toEqual(edited);
  expect(() => parseConfigText("{", stored)).toThrow("Invalid JSON");
  expect(() => parseConfigText("[]", stored)).toThrow("must be a JSON object");
  expect(() => parseConfigText('{"repositories":[1]}', stored)).toThrow(
    "path and gitCommonDir",
  );
  const invalid = config() as unknown as Record<string, unknown>;
  delete invalid.lockWaitSeconds;
  expect(() => parseConfigText(JSON.stringify(invalid), stored)).toThrow(
    "Invalid configuration: edited configuration",
  );
  const staging = config();
  staging.repositories[0]!.targetBranch = "sesh-integrator/integration";
  expect(() => parseConfigText(text(staging), stored)).toThrow(
    "must differ from the staging branch",
  );
  const moved = config();
  moved.repositories[0]!.path = "/work/beta";
  const added = config();
  added.repositories.push({
    ...added.repositories[0]!,
    path: "/work/beta",
    gitCommonDir: "/work/beta/.git",
  });
  const removed = { ...config(), repositories: [] };
  for (const changed of [moved, added, removed])
    expect(() => parseConfigText(text(changed), stored)).toThrow(
      "cannot be added, removed or moved",
    );
  // Repairing an unloadable file accepts any loadable configuration.
  expect(parseConfigText(text(moved), null)).toEqual(moved);
  expect(() =>
    parseSettingsJsonRequest({ revision, text: "{}", extra: true }),
  ).toThrow("Invalid settings request");
  expect(() => parseSettingsJsonRequest({ revision: "x", text: "{}" })).toThrow(
    "Invalid settings revision",
  );
  expect(() =>
    parseSettingsJsonRequest({ revision, text: "x".repeat(1_048_577) }),
  ).toThrow("Configuration must be text");
});

it("saves edited JSON under locks, rejects stale text and repairs invalid files", async () => {
  const root = await runtime(config());
  const path = join(root, "config.json");
  const before = await readFile(path, "utf8");
  const loaded = await loadSettingsJson();
  expect(loaded).toEqual({
    revision: settingsRevision(before),
    configPath: path,
    exists: true,
    text: before,
  });
  await expect(
    saveSettingsJson({ revision: settingsRevision("other"), text: before }),
  ).rejects.toThrow("changed since this form was loaded");
  // Equivalent text never rewrites the file.
  await saveSettingsJson({
    revision: loaded.revision,
    text: JSON.stringify(config()),
  });
  expect(await readFile(path, "utf8")).toBe(before);

  const lock = await acquireRepoLock(
    repoId("/work/alpha/.git"),
    "integrating",
    0,
    join(root, "worktrees", "x"),
  );
  const global = config();
  global.lockWaitSeconds = 30;
  const saved = await saveSettingsJson({
    revision: loaded.revision,
    text: text(global),
  });
  expect(saved.text).toBe(text(global) + "\n");
  const edited = structuredClone(global);
  edited.repositories[0]!.postIntegrationCommands = [["pnpm", "smoke"]];
  await expect(
    saveSettingsJson({ revision: saved.revision, text: text(edited) }),
  ).rejects.toThrow("Cannot change repository settings");
  const disabled = { ...global, disabledRepositories: ["/work/alpha/.git"] };
  await expect(
    saveSettingsJson({ revision: saved.revision, text: text(disabled) }),
  ).rejects.toThrow("Cannot change repository settings");
  await releaseRepoLock(lock);
  const repository = await saveSettingsJson({
    revision: saved.revision,
    text: text(edited),
  });
  expect(JSON.parse(await readFile(path, "utf8"))).toEqual(edited);

  await writeFile(path, "{ not json");
  await expect(loadSettings()).rejects.toThrow("Invalid configuration");
  const broken = await loadSettingsJson();
  expect(broken.text).toBe("{ not json");
  expect(broken.revision).not.toBe(repository.revision);
  await saveSettingsJson({ revision: broken.revision, text: text(config()) });
  expect((await loadSettings()).global.lockWaitSeconds).toBe(900);
});

it("serves the JSON editor and requires same-origin JSON saves", async () => {
  const root = await runtime();
  const server = await startWebDashboard({ watch: () => () => {} });
  servers.push(server);
  const page = await (await fetch(server.url)).text();
  expect(page).toContain('id="tab-json"');
  expect(page).toContain('id="panel-json"');
  const loaded = await (await fetch(server.url + "/api/settings/json")).json();
  expect(loaded).toMatchObject({ exists: false });
  expect(JSON.parse(loaded.text)).toMatchObject({ lockWaitSeconds: 900 });
  expect(await readdir(root)).toEqual([]);
  const value = JSON.parse(loaded.text);
  value.lockWaitSeconds = 45;
  // Larger than the 16 KiB limit for other dashboard requests.
  value.notes = "x".repeat(20_000);
  const body = JSON.stringify({
    revision: loaded.revision,
    text: JSON.stringify(value, null, 2),
  });
  const headers = {
    Origin: server.url,
    "Content-Type": "application/json",
    "X-Sesh-Dashboard": "1",
  };
  const forged = await fetch(server.url + "/api/settings/json", {
    method: "POST",
    headers: { ...headers, Origin: "https://attacker.example" },
    body,
  });
  expect(forged.status).toBe(403);
  expect(await readdir(root)).toEqual([]);
  const response = await fetch(server.url + "/api/settings/json", {
    method: "POST",
    headers,
    body,
  });
  expect(response.status).toBe(200);
  expect(
    JSON.parse(await readFile(join(root, "config.json"), "utf8")),
  ).toMatchObject({ lockWaitSeconds: 45 });
  const invalid = await fetch(server.url + "/api/settings/json", {
    method: "POST",
    headers,
    body: JSON.stringify({
      revision: (await response.json()).revision,
      text: "{",
    }),
  });
  expect(invalid.status).toBe(400);
  expect((await invalid.json()).error).toContain("Invalid JSON");
});
