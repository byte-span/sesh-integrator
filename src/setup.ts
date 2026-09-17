import {
  preflightRuntimeCompatibility,
  retainCoordinator,
  setEnrollment,
  unfinished,
  coordinatorDescription,
} from "./coordinator.js";
import { readSessions, withConfigLock } from "./runtime.js";
import { constants } from "node:fs";
import {
  access,
  stat,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import { execFileSync } from "node:child_process";
import {
  harnesses,
  harnessInfo,
  installedHarnesses,
  parseHarness,
  type Harness,
} from "./harness.js";
import { ensureRuntime, runtimePaths } from "./runtime.js";

const project = fileURLToPath(new URL("../", import.meta.url));
const start = "<!-- codex-handoff:managed:start -->";
const end = "<!-- codex-handoff:managed:end -->";
const hash = (text: string) => createHash("sha256").update(text).digest("hex");

export async function executableOnPath(
  command: string,
  path = process.env.PATH ?? "",
): Promise<boolean> {
  for (const directory of path.split(delimiter).filter(Boolean)) {
    const candidate = join(directory, command);
    try {
      await access(candidate, constants.X_OK);
      if ((await stat(candidate)).isDirectory()) continue;
      return true;
    } catch {
      /* Try the next PATH entry. */
    }
  }
  return false;
}

async function optional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export function managedRange(text: string): [number, number] | undefined {
  const first = text.indexOf(start);
  const last = text.indexOf(end);
  if (first === -1 && last === -1) return undefined;
  if (
    first < 0 ||
    last < first ||
    text.indexOf(start, first + start.length) !== -1 ||
    text.indexOf(end, last + end.length) !== -1
  )
    throw new Error(
      "Malformed or duplicate sesh-integrator managed markers; repair them before setup/uninstall.",
    );
  return [first, last + end.length];
}

async function atomicWrite(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.sesh-setup-${process.pid}`;
  await writeFile(temporary, text, { mode: 0o600 });
  await rename(temporary, path);
}

export async function setupCommand(
  args: string[],
  uninstall = false,
): Promise<void> {
  return withConfigLock(() => setupUnlocked(args, uninstall));
}

async function setupUnlocked(args: string[], uninstall = false): Promise<void> {
  const explicit: Harness[] = [];
  let detected = false;
  let yes = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--yes") yes = true;
    else if (arg === "--detected" && !uninstall) detected = true;
    else if (arg === "--harness" && args[i + 1])
      explicit.push(parseHarness(args[++i]!));
    else throw new Error(`Unknown or incomplete option: ${arg}`);
  }
  if (detected && explicit.length)
    throw new Error("Choose --detected or --harness, not both.");
  const home = homedir();
  const available: Harness[] = [];
  for (const harness of harnesses)
    if (await executableOnPath(harnessInfo[harness].command ?? harness))
      available.push(harness);
  let selected = [
    ...new Set(
      explicit.length
        ? explicit
        : uninstall
          ? installedHarnesses(home)
          : available,
    ),
  ];
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  if (!yes && !interactive)
    throw new Error(
      `Non-interactive use requires --yes${uninstall ? "" : " and --detected or --harness <name>"}.`,
    );
  if (!uninstall && yes && !detected && !explicit.length)
    throw new Error("Choose --detected or --harness <name> with --yes.");
  const prompt =
    interactive && !yes
      ? createInterface({ input: process.stdin, output: process.stdout })
      : undefined;
  try {
    if (!uninstall)
      console.log(`Detected harnesses: ${available.join(", ") || "none"}`);
    if (prompt && !explicit.length && !detected && !uninstall) {
      console.log(`Available integrations: ${harnesses.join(", ")}`);
      const answer = (
        await prompt.question(
          `Select harnesses, comma-separated [${selected.join(", ")}]: `,
        )
      ).trim();
      if (answer)
        selected = [...new Set(answer.split(/[\s,]+/).map(parseHarness))];
    }
    if (!selected.length)
      throw new Error(
        uninstall
          ? "No installed workflows found."
          : "No harnesses selected. Install a harness or pass --harness <name>.",
      );
    await preflightRuntimeCompatibility();
    const pending = (await readSessions(true)).filter(unfinished);
    for (const session of pending)
      console.log(
        `Existing session ${session.id} (${session.status}${session.waitingForLock ? ", waiting" : ""}): ${await coordinatorDescription(session)}`,
      );
    if (uninstall) {
      const affected = pending.filter((s) =>
        selected.includes(s.harness ?? "codex"),
      );
      if (affected.length) {
        if (
          prompt &&
          !/^y(es)?$/i.test(
            (
              await prompt.question(
                "Stop new enrollment and defer removal until sessions finish? [y/N] ",
              )
            ).trim(),
          )
        ) {
          console.log("Cancelled.");
          return;
        }
        await setEnrollment(selected, true);
        const fallback = await retainCoordinator();
        console.log(
          `Removal deferred for ${affected.length} unfinished session(s). New enrollment stopped for ${selected.join(", ")}; existing guidance, locks, sessions and recovery bundles retained. Finish sessions with their recorded coordinator (or compatible fallback: node ${fallback.cliPath}), then rerun uninstall --yes. npm package removal is separate and cannot be prevented.`,
        );
        return;
      }
    }
    const receiptPath = join(runtimePaths().root, "installation.json");
    const receipt: Record<string, string> = JSON.parse(
      (await optional(receiptPath)) ?? "{}",
    );
    const snippet = (
      await readFile(join(project, "GLOBAL_AGENTS_SNIPPET.md"), "utf8")
    ).trim();
    const block = snippet.startsWith(start)
      ? snippet
      : `${start}\n${snippet}\n${end}`;
    const changes: {
      path: string;
      before: string | undefined;
      after: string | undefined;
      digest?: string;
      previousDigest?: string;
    }[] = [];
    for (const harness of selected) {
      const info = harnessInfo[harness];
      for (const file of ["SKILL.md", ...info.metadataFiles]) {
        const path = join(
          home,
          info.skillDirectory,
          "skills",
          "sesh-integrator-workflow",
          file,
        );
        const bundled = await readFile(
          join(project, "skill/sesh-integrator-workflow", file),
          "utf8",
        );
        const before = await optional(path);
        const owned =
          before === undefined ||
          hash(before) === receipt[path] ||
          hash(before) === receipt[path + ":previous"] ||
          before === bundled;
        if (!owned) {
          if (!uninstall)
            throw new Error(
              `Preserving customized file: ${path}. Back it up and move it before running setup again.`,
            );
          console.log(`Preserving customized file: ${path}`);
          continue;
        }
        changes.push({
          path,
          before,
          after: uninstall ? undefined : bundled,
          digest: hash(bundled),
          ...(before !== undefined ? { previousDigest: hash(before) } : {}),
        });
      }
      const path = join(home, info.directory, info.instructions);
      const before = await optional(path);
      const range = managedRange(before ?? "");
      const currentBlock = range ? before!.slice(...range) : undefined;
      if (
        currentBlock &&
        currentBlock !== block &&
        hash(currentBlock) !== receipt[path] &&
        hash(currentBlock) !== receipt[path + ":previous"]
      ) {
        if (!uninstall)
          throw new Error(
            `Preserving customized guidance: ${path}. Back it up and move it before running setup again.`,
          );
        console.log(`Preserving customized guidance: ${path}`);
        continue;
      }
      const after = range
        ? before!.slice(0, range[0]) +
          (uninstall ? "" : block) +
          before!.slice(range[1])
        : uninstall
          ? before
          : `${before ?? ""}${before && !before.endsWith("\n") ? "\n" : ""}${block}\n`;
      changes.push({
        path,
        before,
        after,
        digest: hash(block),
        ...(currentBlock ? { previousDigest: hash(currentBlock) } : {}),
      });
    }
    console.log(
      `${uninstall ? "Remove" : "Install"} integrations: ${selected.join(", ")}`,
    );
    for (const change of changes)
      if (change.before !== change.after) console.log(`  ${change.path}`);
    if (!uninstall)
      console.log(
        `Initialize configuration if missing: ${runtimePaths().config}`,
      );
    if (
      prompt &&
      !/^y(es)?$/i.test((await prompt.question("Continue? [y/N] ")).trim())
    ) {
      console.log("Cancelled.");
      return;
    }
    if (uninstall) await setEnrollment(selected, true);
    if (!uninstall) {
      if (Number(process.versions.node.split(".")[0]) < 20)
        throw new Error("Node.js 20 or newer is required.");
      execFileSync("git", ["--version"], { stdio: "pipe", timeout: 10000 });
      await ensureRuntime();
      await retainCoordinator();
    }
    for (const change of changes) {
      if ((await optional(change.path)) !== change.before)
        throw new Error(
          `File changed during setup; preserving ${change.path}. Retry the command.`,
        );
      if (!uninstall) {
        if (change.previousDigest)
          receipt[change.path + ":previous"] = change.previousDigest;
        receipt[change.path] = change.digest!;
        await atomicWrite(receiptPath, JSON.stringify(receipt, null, 2) + "\n");
      }
      if (change.before !== change.after) {
        if (change.after === undefined) await rm(change.path, { force: true });
        else await atomicWrite(change.path, change.after);
      }
      if (uninstall) delete receipt[change.path];
      else receipt[change.path] = change.digest!;
      if ((await optional(change.path)) !== change.after)
        throw new Error(`Verification failed: ${change.path}`);
    }
    await atomicWrite(receiptPath, JSON.stringify(receipt, null, 2) + "\n");
    if (!uninstall) await setEnrollment(selected, false);
    if (uninstall)
      console.log(
        "Integrations removed; customized files, configuration, and sessions preserved. To remove the npm CLI: npm uninstall -g sesh-integrator",
      );
    else {
      console.log(
        "Setup verified: Git, runtime, skills, and managed guidance.",
      );
      for (const harness of selected)
        if (!available.includes(harness))
          console.log(
            `Warning: ${harnessInfo[harness].command ?? harness} is not on PATH. Install it before using this integration.`,
          );
      console.log(
        "Global setup cannot discover intended repositories or enroll open conversations. Next: in your project, run seshx register --auto-config, then seshx doctor --installed.",
      );
    }
  } finally {
    prompt?.close();
  }
}
