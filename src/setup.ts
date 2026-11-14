import { requireCapabilities } from "./capabilities.js";
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
import {
  installWorkflowSkill,
  installWouldChange,
  printInstall,
  removeWorkflowSkill,
  SKILL_NAME,
  skillStatus,
  skillTargetStatus,
} from "./skill.js";

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

/**
 * Remove owned skill copies for uninstalled harnesses; once no harness is
 * enrolled, from every detected harness directory. Customized copies stay.
 */
function removeSkillCopies(home: string, uninstalled: string[]): void {
  const remaining = installedHarnesses(home);
  const kept = new Set(
    remaining.flatMap((harness) => harnessInfo[harness].skillTarget ?? []),
  );
  const rows = removeWorkflowSkill({
    home,
    ...(remaining.length
      ? { targets: uninstalled.filter((id) => !kept.has(id)) }
      : {}),
  });
  for (const row of rows)
    if (row.removed) console.log(`Removed ${row.dest}`);
    else if (row.state !== "missing")
      console.log(`Preserving customized skill: ${row.dest} (${row.state})`);
}

export async function setupCommand(
  args: string[],
  uninstall = false,
): Promise<void> {
  if (!uninstall) await requireCapabilities();
  return withConfigLock(() => setupUnlocked(args, uninstall));
}

async function setupUnlocked(args: string[], uninstall = false): Promise<void> {
  const explicit: Harness[] = [];
  let detected = false;
  let yes = false;
  const skillFlags = {
    replaceUnmanaged: false,
    replaceEdited: false,
    allowDowngrade: false,
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--yes") yes = true;
    else if (arg === "--detected" && !uninstall) detected = true;
    else if (arg === "--replace-unmanaged" && !uninstall)
      skillFlags.replaceUnmanaged = true;
    else if (arg === "--replace-edited" && !uninstall)
      skillFlags.replaceEdited = true;
    else if (arg === "--allow-downgrade" && !uninstall)
      skillFlags.allowDowngrade = true;
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
          ? "No installed workflows found. To remove only the skill, run seshx skill remove."
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
    // The skill is shared by every detected harness directory through the
    // skill install contract; only guidance blocks are per harness.
    const selectedTargets = [
      ...new Set(
        selected.flatMap((harness) => harnessInfo[harness].skillTarget ?? []),
      ),
    ];
    const skillDestinations: string[] = [];
    if (!uninstall) {
      for (const id of selectedTargets) {
        const current = skillTargetStatus(id, { home });
        if (!current) continue;
        if (current.state === "other-owner")
          throw new Error(
            `Preserving ${current.dest}, which ${current.owner ?? "another tool"} manages. Remove it with that tool, then run setup again.`,
          );
        if (
          (current.state === "unmanaged" || current.state === "edited") &&
          !installWouldChange(current, skillFlags)
        )
          throw new Error(
            `Preserving customized skill: ${current.dest}. Rerun with --replace-${current.state} to back it up and replace it, or move it yourself first.`,
          );
        if (installWouldChange(current, skillFlags))
          skillDestinations.push(current.dest);
      }
      for (const current of skillStatus({ home }))
        if (
          !skillDestinations.includes(current.dest) &&
          installWouldChange(current, skillFlags)
        )
          skillDestinations.push(current.dest);
    }
    for (const harness of selected) {
      const info = harnessInfo[harness];
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
    if (!uninstall)
      await requireCapabilities(process.cwd(), false, [
        ...changes.map((change) => dirname(change.path)),
        ...skillDestinations.map((dest) => dirname(dest)),
      ]);
    console.log(
      `${uninstall ? "Remove" : "Install"} integrations: ${selected.join(", ")}`,
    );
    for (const change of changes)
      if (change.before !== change.after) console.log(`  ${change.path}`);
    for (const dest of skillDestinations) console.log(`  ${dest}`);
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
    if (uninstall) removeSkillCopies(home, selectedTargets);
    else {
      const rows = installWorkflowSkill({
        home,
        ...skillFlags,
        ensureTargets: selectedTargets,
      });
      printInstall(rows);
      const blocked = rows.filter(
        (row) => row.blocked && selectedTargets.includes(row.target),
      );
      if (blocked.length)
        throw new Error(
          `The ${SKILL_NAME} skill was not installed at ${blocked.map((row) => `${row.dest} (${row.note})`).join("; ")}`,
        );
    }
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
