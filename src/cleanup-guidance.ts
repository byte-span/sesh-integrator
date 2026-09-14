import { randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { run } from "./process.js";
import { runtimePaths } from "./runtime.js";

export function removeManagedGuidance(original: Buffer): Buffer | undefined {
  const text = original.toString("utf8");
  if (!Buffer.from(text).equals(original))
    throw new Error("not a UTF-8 text file");
  const markers = [
    ...text.matchAll(
      /<!-- (codex-handoff|parallel-integrator|sesh-integrator):managed:(start|end) -->/g,
    ),
  ];
  if (markers.length === 0) return undefined;
  if (
    markers.length !== 2 ||
    markers[0]![1] !== markers[1]![1] ||
    markers[0]![2] !== "start" ||
    markers[1]![2] !== "end"
  ) {
    throw new Error("malformed or multiple managed blocks");
  }
  const first = markers[0]!;
  const last = markers[1]!;
  const start = first.index!;
  const end = last.index! + last[0].length;
  if (
    insideFence(text.slice(0, start)) ||
    insideFence(text.slice(0, last.index))
  )
    throw new Error("managed markers appear inside a code example");
  if (
    (start > 0 && text[start - 1] !== "\n") ||
    !["", "\n", "\r\n"].some(
      (ending) =>
        text.slice(end) === ending ||
        (ending && text.slice(end).startsWith(ending)),
    )
  ) {
    throw new Error("managed markers must occupy their own lines");
  }
  if (
    !text
      .slice(start + first[0].length, last.index)
      .match(
        /^## (codex-handoff|parallel-integrator|sesh-integrator) workflow\r?$/m,
      )
  ) {
    throw new Error(
      "managed block is not recognized repository workflow guidance",
    );
  }
  const block = text.slice(start, end);
  if (
    !block.startsWith(first[0] + "\n") &&
    !block.startsWith(first[0] + "\r\n")
  )
    throw new Error("malformed start marker line");
  if (text[last.index! - 1] !== "\n")
    throw new Error("malformed end marker line");
  const lineEnd = text.slice(end).startsWith("\r\n")
    ? 2
    : text[end] === "\n"
      ? 1
      : 0;
  return Buffer.from(text.slice(0, start) + text.slice(end + lineEnd));
}

function insideFence(prefix: string): boolean {
  let fence: string | undefined;
  for (const line of prefix.split("\n")) {
    const match = /^ {0,3}(`{3,}|~{3,})(.*)/.exec(line);
    if (!match) continue;
    if (!fence) fence = match[1]!;
    else if (
      match[1]![0] === fence[0] &&
      match[1]!.length >= fence.length &&
      !match[2]!.trim()
    )
      fence = undefined;
  }
  return fence !== undefined;
}

export async function cleanupGuidanceCommand(apply: boolean): Promise<void> {
  const paths = runtimePaths();
  const config: unknown = JSON.parse(await readFile(paths.config, "utf8"));
  const repositories = (config as { repositories?: unknown })?.repositories;
  if (
    !Array.isArray(repositories) ||
    repositories.some(
      (entry) => typeof entry?.path !== "string" || !isAbsolute(entry.path),
    )
  ) {
    throw new Error(`Invalid repository paths in ${paths.config}`);
  }
  let changed = 0;
  let skipped = 0;
  const visited = new Set<string>();
  for (const entry of repositories) {
    const file = join(entry.path, "AGENTS.md");
    let temporary: string | undefined;
    try {
      const root = await realpath(entry.path);
      if (visited.has(root)) continue;
      visited.add(root);
      const repo = await run("git", ["rev-parse", "--show-toplevel"], {
        cwd: root,
        timeoutMs: 10_000,
      });
      if (repo.code !== 0 || (await realpath(repo.stdout.trim())) !== root)
        throw new Error("registered path is not a Git checkout root");
      let info;
      try {
        info = await lstat(file);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      if (!info.isFile() || info.nlink !== 1)
        throw new Error(
          "not a regular, unshared file (symlinks are not followed)",
        );
      const original = await readFile(file);
      const updated = removeManagedGuidance(original);
      if (updated === undefined) continue;
      const staged = await run(
        "git",
        ["diff", "--cached", "--quiet", "--", "AGENTS.md"],
        { cwd: root, timeoutMs: 10_000 },
      );
      if (staged.code !== 0)
        throw new Error(
          "AGENTS.md has staged changes or its index state could not be verified",
        );
      const remove = updated.toString("utf8").trim().length === 0;
      if (!apply) {
        process.stdout.write(`WOULD ${remove ? "DELETE" : "CLEAN"} ${file}\n`);
        changed++;
        continue;
      }
      const backup = join(paths.root, "guidance-backups", randomUUID());
      await mkdir(backup, { recursive: true, mode: 0o700 });
      await writeFile(join(backup, "AGENTS.md"), original, {
        flag: "wx",
        mode: 0o600,
      });
      await writeFile(
        join(backup, "metadata.json"),
        JSON.stringify({
          path: file,
          mode: info.mode & 0o777,
          createdAt: new Date().toISOString(),
        }) + "\n",
        { flag: "wx", mode: 0o600 },
      );
      if (!remove) {
        temporary = join(
          dirname(file),
          `.sesh-integrator-cleanup-${randomUUID()}`,
        );
        await writeFile(temporary, updated, {
          flag: "wx",
          mode: info.mode & 0o777,
        });
        await chmod(temporary, info.mode & 0o777);
      }
      const currentIndex = await run(
        "git",
        ["diff", "--cached", "--quiet", "--", "AGENTS.md"],
        { cwd: root, timeoutMs: 10_000 },
      );
      if (currentIndex.code !== 0)
        throw new Error(
          `index changed during cleanup; original backup: ${backup}`,
        );
      const current = await lstat(file);
      if (
        !current.isFile() ||
        current.nlink !== 1 ||
        current.ino !== info.ino ||
        current.dev !== info.dev ||
        current.mtimeMs !== info.mtimeMs ||
        current.ctimeMs !== info.ctimeMs ||
        !(await readFile(file)).equals(original)
      )
        throw new Error(
          `file changed during cleanup; original backup: ${backup}`,
        );
      if (remove) await unlink(file);
      else {
        await rename(temporary!, file);
        temporary = undefined;
      }
      changed++;
      process.stdout.write(
        `${remove ? "DELETED" : "CLEANED"} ${file}\n  Backup: ${backup}\n`,
      );
    } catch (error) {
      skipped++;
      process.stderr.write(
        `SKIPPED ${file}: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    } finally {
      if (temporary) {
        try {
          await unlink(temporary);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
            skipped++;
            process.stderr.write(
              `Could not remove cleanup temporary file: ${temporary}\n`,
            );
          }
        }
      }
    }
  }
  process.stdout.write(
    `${changed} ${apply ? "cleaned" : "eligible"}; ${skipped} skipped.\n`,
  );
  if (!apply && changed)
    process.stdout.write(
      "Run seshx cleanup-guidance --apply to clean all eligible registered checkouts.\n",
    );
  if (apply && changed)
    process.stdout.write(
      "Git branches and index were not changed. Review and commit tracked-file cleanup through your normal workflow.\n",
    );
  if (skipped) process.exitCode = 1;
}
