import {
  chmod,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { incidentCommand, recordIncident } from "../src/incident.js";
import { ensureRuntime } from "../src/runtime.js";
import type { Session } from "../src/types.js";

const roots: string[] = [];

afterEach(async () => {
  delete process.env.PARALLEL_INTEGRATOR_HOME;
  await Promise.all(
    roots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

function session(overrides: Partial<Session> = {}): Session {
  return {
    id: "session_test",
    status: "needs_review",
    repositoryPath: "/repo",
    repositoryId: "repo",
    worktreePath: "/repo",
    branch: "task",
    startCommit: "aaaa",
    startedAt: "2026-01-01T00:00:00.000Z",
    taskSummary: "task",
    dependsOn: [],
    ...overrides,
  };
}

async function configureCodex(executable: string): Promise<void> {
  const paths = await ensureRuntime();
  const config = JSON.parse(await readFile(paths.config, "utf8"));
  config.codexCommand = executable;
  await writeFile(paths.config, `${JSON.stringify(config, null, 2)}\n`);
}

describe("failure incidents", () => {
  it("stores a schema-validated agent diagnosis and links its ticket", async () => {
    const root = await mkdtemp(join(tmpdir(), "handoff-incident-"));
    roots.push(root);
    process.env.PARALLEL_INTEGRATOR_HOME = root;
    const fake = join(root, "fake-codex");
    await writeFile(
      fake,
      `#!/usr/bin/env node
const fs=require("fs");
const args=process.argv.slice(2);const output=args[args.indexOf("--output-last-message")+1];
fs.writeFileSync(output,JSON.stringify({category:"workflow gap",confidence:"high",diagnosis:"The workflow omitted a required recovery step.",proposedFix:"Update the workflow instructions with the recovered step.",fixScope:"instructions"}));
`,
    );
    await chmod(fake, 0o755);
    await configureCodex(fake);
    const value = session({
      repositoryPath: root,
      worktreePath: root,
      latestError: "signing timeout 123",
    });
    const incident = await recordIncident(value, value.latestError!);
    expect(incident.id).toMatch(/^CH-\d{8}-[0-9A-F]{6}$/);
    expect(value.latestIncidentId).toBe(incident.id);
    const names = await readdir(join(root, "incidents"));
    expect(names).toEqual([`${incident.id}.json`]);
    const stored = JSON.parse(
      await readFile(join(root, "incidents", names[0]!), "utf8"),
    );
    expect(stored.investigationSource).toBe("agent");
    expect(stored.fixScope).toBe("instructions");
    await expect(incidentCommand(incident.id)).resolves.toBeUndefined();
  });

  it("records a neutral fallback when investigation is unavailable", async () => {
    const root = await mkdtemp(join(tmpdir(), "handoff-incident-"));
    roots.push(root);
    process.env.PARALLEL_INTEGRATOR_HOME = root;
    await configureCodex(join(root, "missing-codex"));
    const incident = await recordIncident(session(), "novel failure 42");
    expect(incident.investigationSource).toBe("fallback");
    expect(incident.category).toBe("unclassified");
    expect(incident.investigationError).toBeTruthy();
  });
});
