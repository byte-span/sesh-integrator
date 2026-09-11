import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { resolveRuntimeRoot } from "../src/runtime.js";

it("keeps existing sessions and locks in the original runtime after the rename", async () => {
  const home = await mkdtemp(join(tmpdir(), "parallel-integrator-rename-"));
  try {
    expect(resolveRuntimeRoot({}, home)).toBe(
      join(home, ".parallel-integrator"),
    );
    await mkdir(join(home, ".codex-handoff"));
    expect(resolveRuntimeRoot({}, home)).toBe(join(home, ".codex-handoff"));
    await mkdir(join(home, ".parallel-integrator"));
    expect(resolveRuntimeRoot({}, home)).toBe(join(home, ".codex-handoff"));
    expect(resolveRuntimeRoot({ CODEX_HANDOFF_HOME: "/legacy" }, home)).toBe(
      "/legacy",
    );
    expect(
      resolveRuntimeRoot(
        {
          CODEX_HANDOFF_HOME: "/legacy",
          PARALLEL_INTEGRATOR_HOME: "/explicit",
        },
        home,
      ),
    ).toBe("/explicit");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
