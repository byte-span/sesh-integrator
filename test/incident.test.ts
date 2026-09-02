import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  diagnoseFailure,
  incidentCommand,
  recordIncident,
} from "../src/incident.js";
import type { Session } from "../src/types.js";

const roots: string[] = [];

afterEach(async () => {
  delete process.env.CODEX_HANDOFF_HOME;
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

describe("failure incidents", () => {
  it("classifies guarded and instruction-improvement failures", () => {
    expect(
      diagnoseFailure(session({ awaitingConflictResolution: true }), "conflict")
        .fixScope,
    ).toBe("project");
    expect(diagnoseFailure(session(), "unrecognized failure").fixScope).toBe(
      "instructions",
    );
  });

  it("writes an immutable ticket and links it from the session", async () => {
    const root = await mkdtemp(join(tmpdir(), "handoff-incident-"));
    roots.push(root);
    process.env.CODEX_HANDOFF_HOME = root;
    const value = session({ latestError: "signing timeout 123" });
    const incident = await recordIncident(value, value.latestError!);
    expect(incident.id).toMatch(/^CH-\d{8}-[0-9A-F]{6}$/);
    expect(value.latestIncidentId).toBe(incident.id);
    const names = await readdir(join(root, "incidents"));
    expect(names).toEqual([`${incident.id}.json`]);
    const stored = JSON.parse(
      await readFile(join(root, "incidents", names[0]!), "utf8"),
    );
    expect(stored.proposedFix).toContain("environment failure");
    await expect(incidentCommand(incident.id)).resolves.toBeUndefined();
  });
});
