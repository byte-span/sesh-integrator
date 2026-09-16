import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { run } from "./process.js";

const retryable = new Set(["EBUSY", "EMFILE", "ENFILE", "ENOTEMPTY", "EPERM"]);

export async function cleanupBenchmark(root: string): Promise<void> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await rm(root, { recursive: true, force: true });
      return;
    } catch (error) {
      await recordCleanupFailure(root, attempt, error);
      if (
        !retryable.has((error as NodeJS.ErrnoException).code ?? "") ||
        attempt === 3
      ) {
        throw error;
      }
      await setTimeout(attempt * 100);
    }
  }
}

async function recordCleanupFailure(
  root: string,
  attempt: number,
  error: unknown,
): Promise<void> {
  const destination = process.env.SESH_INTEGRATOR_BENCHMARK_DIAGNOSTICS_DIR;
  if (!destination) return;
  try {
    // Only names/types from this disposable fixture; never read file contents.
    const entries: { path: string; type: string }[] = [];
    const pending = [""];
    while (pending.length > 0 && entries.length < 200) {
      const directory = pending.shift()!;
      try {
        for (const entry of await readdir(join(root, directory), {
          withFileTypes: true,
        })) {
          if (entries.length >= 200) break;
          const path = join(directory, entry.name);
          entries.push({
            path,
            type: entry.isDirectory()
              ? "directory"
              : entry.isSymbolicLink()
                ? "symlink"
                : "file",
          });
          if (entry.isDirectory()) pending.push(path);
        }
      } catch {
        // Cleanup and Git may still be changing the directory.
      }
    }
    // Executable names, PIDs and parent PIDs only: command arguments can contain secrets.
    const processes = await run("ps", ["-axo", "pid=,ppid=,comm="], {
      timeoutMs: 2000,
    });
    const gitProcesses = processes.stdout
      .split("\n")
      .filter((line) => /(?:^|[/\s])(git(?:-[\w-]+)?|node)$/.test(line.trim()));
    const failure = error as NodeJS.ErrnoException;
    await mkdir(destination, { recursive: true });
    await writeFile(
      join(destination, `${basename(root)}-cleanup-${attempt}.json`),
      JSON.stringify(
        {
          timestamp: new Date().toISOString(),
          platform: process.platform,
          node: process.version,
          pid: process.pid,
          root,
          attempt,
          error: {
            code: failure.code,
            syscall: failure.syscall,
            path: failure.path,
          },
          entries,
          entriesLimit: 200,
          gitProcesses,
        },
        null,
        2,
      ) + "\n",
    );
  } catch {
    // Diagnostics must not replace the original cleanup failure.
    process.stderr.write("Could not write benchmark cleanup diagnostics.\n");
  }
}
