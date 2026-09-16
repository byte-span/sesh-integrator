import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute } from "node:path";
import { harnesses, type Harness } from "../src/harness.js";

/** Shared smoke/eval authentication policy; never reads credential values. */
export async function liveOptions(env = process.env) {
  const selected = env.SESH_SMOKE_HARNESSES?.split(",") ?? [];
  const sandboxHome = env.SESH_SMOKE_HOME ?? "";
  if (
    env.SESH_SMOKE_LIVE_CONFIRMED !== "1" ||
    selected.length === 0 ||
    new Set(selected).size !== selected.length ||
    selected.some((h) => !harnesses.includes(h as Harness))
  )
    throw new Error(
      "Use an explicit live smoke/eval command with --harness <name> to opt in to real AI calls.",
    );
  if (
    selected.some((h) => h !== "codex") &&
    (env.SESH_SMOKE_BUDGET_CONFIRMED !== "1" ||
      !isAbsolute(sandboxHome) ||
      (await realpath(sandboxHome)) === (await realpath(homedir())))
  )
    throw new Error(
      "Non-Codex harnesses require a separate SESH_SMOKE_HOME and SESH_SMOKE_BUDGET_CONFIRMED=1. See smoke/README.md.",
    );
  if (sandboxHome) {
    if (!isAbsolute(sandboxHome))
      throw new Error("SESH_SMOKE_HOME must be absolute.");
    await realpath(sandboxHome);
  }
  return { selected: selected as Harness[], sandboxHome };
}
