import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { runValidation } from "../src/process.js";
import type { ValidationStep } from "../src/types.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

it("serializes exclusive resource users across sessions while allowing shared users", async () => {
  const root = await mkdtemp(join(tmpdir(), "handoff-resources-"));
  roots.push(root);
  const previous = process.env.CODEX_HANDOFF_HOME;
  process.env.CODEX_HANDOFF_HOME = join(root, "runtime");
  const events = join(root, "events.log");
  const command = (
    label: string,
    mode: "shared" | "exclusive",
  ): ValidationStep => ({
    command: [
      process.execPath,
      "-e",
      `const fs=require('fs');const p=${JSON.stringify(events)};fs.appendFileSync(p,${JSON.stringify(`${label}-start\n`)});setTimeout(()=>fs.appendFileSync(p,${JSON.stringify(`${label}-end\n`)}),120)`,
    ],
    resources: { [mode]: ["generic:test-resource"] },
  });
  try {
    await Promise.all([
      runValidation([command("exclusive-a", "exclusive")], root, {
        sessionId: "a",
      }),
      runValidation([command("exclusive-b", "exclusive")], root, {
        sessionId: "b",
      }),
    ]);
    const exclusiveEvents = (await readFile(events, "utf8")).trim().split("\n");
    expect(exclusiveEvents[1]).toMatch(/-end$/);

    await rm(events);
    await Promise.all([
      runValidation([command("shared-a", "shared")], root, { sessionId: "c" }),
      runValidation([command("shared-b", "shared")], root, { sessionId: "d" }),
    ]);
    const sharedEvents = (await readFile(events, "utf8")).trim().split("\n");
    expect(new Set(sharedEvents.slice(0, 2))).toEqual(
      new Set(["shared-a-start", "shared-b-start"]),
    );
  } finally {
    if (previous === undefined) delete process.env.CODEX_HANDOFF_HOME;
    else process.env.CODEX_HANDOFF_HOME = previous;
  }
});
