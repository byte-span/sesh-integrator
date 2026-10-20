import { afterEach, expect, it, vi } from "vitest";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  configHistoryDirectory,
  configHistoryLimit,
  listConfigHistory,
  readConfigSnapshot,
  recordConfigSnapshot,
} from "../src/config-history.js";
import {
  loadSettings,
  loadSettingsJson,
  saveSettings,
  saveSettingsJson,
} from "../src/dashboard-settings.js";
import { startWebDashboard } from "../src/dashboard-web.js";
import { writeConfig, writeConfigFile } from "../src/runtime.js";
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

async function runtime(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "config-history-"));
  roots.push(root);
  vi.stubEnv("SESH_INTEGRATOR_HOME", root);
  return root;
}

const config = (lockWaitSeconds: number): Config => ({
  lockWaitSeconds,
  repositories: [],
});
const text = (value: Config) => `${JSON.stringify(value, null, 2)}\n`;

it("keeps replaced text, newest first, and never records new or unchanged files", async () => {
  const root = await runtime();
  const path = join(root, "config.json");
  await writeConfigFile(path, config(1), "seshx register");
  await writeConfigFile(path, config(1), "seshx register");
  expect(await listConfigHistory(path)).toEqual([]);
  await expect(readdir(root)).resolves.toEqual(["config.json"]);

  await writeConfigFile(path, config(2), "seshx enable");
  await writeFile(path, "{ hand edited");
  await writeConfigFile(path, config(3), "Dashboard JSON");
  const entries = await listConfigHistory(path);
  expect(entries.map((e) => e.source)).toEqual([
    "Dashboard JSON",
    "seshx enable",
  ]);
  expect(entries[1]).toMatchObject({ bytes: text(config(1)).length });
  // Unparseable text is kept as is, so a broken file can still be recovered.
  expect((await readConfigSnapshot(path, entries[0]!.id)).text).toBe(
    "{ hand edited",
  );
  const snapshot = await readConfigSnapshot(path, entries[1]!.id);
  expect(snapshot).toMatchObject({ version: 1, text: text(config(1)) });
  expect(Date.parse(snapshot.replacedAt)).not.toBeNaN();
  const file = join(configHistoryDirectory(path), `${entries[0]!.id}.json`);
  expect((await stat(file)).mode & 0o777).toBe(0o600);

  await expect(readConfigSnapshot(path, "../config")).rejects.toThrow(
    "Invalid history entry",
  );
  await expect(
    readConfigSnapshot(path, "0000000000000-00000000"),
  ).rejects.toThrow("no longer exists");
  // Unrelated and unreadable files are ignored.
  await writeFile(join(configHistoryDirectory(path), "notes.json"), "{}");
  await writeFile(
    join(configHistoryDirectory(path), "0000000000001-00000000.json"),
    "{",
  );
  expect(await listConfigHistory(path)).toHaveLength(2);
});

it(`keeps only the newest ${configHistoryLimit} versions`, async () => {
  const root = await runtime();
  const path = join(root, "config.json");
  for (let i = 0; i < configHistoryLimit + 3; i++)
    await recordConfigSnapshot(path, `v${i}`, `v${i + 1}`, "seshx");
  const entries = await listConfigHistory(path);
  expect(entries).toHaveLength(configHistoryLimit);
  const texts = await Promise.all(
    entries.map(async (e) => (await readConfigSnapshot(path, e.id)).text),
  );
  expect(texts[0]).toBe(`v${configHistoryLimit + 2}`);
  expect(texts.at(-1)).toBe("v3");
  expect(new Set(entries.map((e) => e.id)).size).toBe(configHistoryLimit);
});

it("records CLI and dashboard writes and serves history read-only", async () => {
  const root = await runtime();
  const server = await startWebDashboard({ watch: () => () => {} });
  servers.push(server);
  const empty = await fetch(server.url + "/api/settings/history");
  expect(await empty.json()).toEqual({
    limit: configHistoryLimit,
    entries: [],
  });
  expect(await readdir(root)).toEqual([]);

  await writeConfig(config(10));
  await writeConfig(config(20));
  const view = await loadSettings();
  await saveSettings({
    scope: "global",
    revision: view.revision,
    values: { ...view.global, lockWaitSeconds: 30 },
  });
  const raw = await loadSettingsJson();
  await saveSettingsJson({ revision: raw.revision, text: text(config(40)) });

  const listed = await (
    await fetch(server.url + "/api/settings/history")
  ).json();
  expect(
    listed.entries.map((e: { source: string }) => e.source),
    // The first CLI write replaces the default file that runtime setup created.
  ).toEqual(["Dashboard JSON", "Dashboard form", "seshx", "seshx"]);
  expect(listed.entries[0]).not.toHaveProperty("text");
  const latest = await (
    await fetch(server.url + "/api/settings/history/" + listed.entries[0].id)
  ).json();
  expect(JSON.parse(latest.text)).toMatchObject({ lockWaitSeconds: 30 });
  const missing = await fetch(
    server.url + "/api/settings/history/0000000000000-00000000",
  );
  expect(missing.status).toBe(400);
  expect((await missing.json()).error).toContain("no longer exists");
  // Reading history never changes config.json.
  expect(JSON.parse(await readFile(join(root, "config.json"), "utf8"))).toEqual(
    config(40),
  );
});
