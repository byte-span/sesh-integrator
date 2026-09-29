import { randomUUID } from "node:crypto";
import { lstat, open, readFile, unlink } from "node:fs/promises";
import { hostname } from "node:os";

export interface FileLock {
  path: string;
  token: string;
  dev: number;
  ino: number;
}

function code(error: unknown): string | undefined {
  return error instanceof Error && "code" in error
    ? String(error.code)
    : undefined;
}

/** Use the legacy directory pathname: mkdir and open(wx) exclude each other. */
export async function tryFileLock(
  path: string,
  metadata: Record<string, unknown> = {},
): Promise<FileLock | undefined> {
  let file;
  try {
    file = await open(path, "wx", 0o600);
  } catch (error) {
    if (code(error) === "EEXIST" || code(error) === "EISDIR") return;
    throw error;
  }
  return withCleanup(
    async () => {
      const identity = await file.stat();
      const handle = {
        path,
        token: randomUUID(),
        dev: identity.dev,
        ino: identity.ino,
      };
      try {
        await file.writeFile(
          JSON.stringify({
            ...metadata,
            pid: process.pid,
            hostname: hostname(),
            startedAt: new Date().toISOString(),
            token: handle.token,
          }) + "\n",
        );
      } catch (error) {
        // A partial record remains locked rather than admitting a second owner.
        throw new Error(
          `Could not initialize lock ${path}; preserve it for inspection: ${message(error)}`,
          { cause: error },
        );
      }
      return handle;
    },
    () => file.close(),
  );
}

export async function releaseFileLock(handle: FileLock): Promise<void> {
  const identity = await lstat(handle.path);
  if (
    !identity.isFile() ||
    identity.dev !== handle.dev ||
    identity.ino !== handle.ino
  ) {
    throw new Error(`Refusing to release replaced lock: ${handle.path}`);
  }
  const owner = JSON.parse(await readFile(handle.path, "utf8")) as {
    token?: unknown;
  };
  if (owner.token !== handle.token)
    throw new Error(`Refusing to release lock no longer owned: ${handle.path}`);
  // Never use recursive rm here: an unexpected directory must remain untouched.
  await unlink(handle.path);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class LockCleanupError extends Error {
  constructor(error: unknown) {
    super(`Lock cleanup failed: ${message(error)}`, { cause: error });
    this.name = "LockCleanupError";
  }
}

/** A failed release must not replace the error from the protected operation. */
export async function withCleanup<T>(
  action: () => Promise<T>,
  cleanup: () => Promise<void>,
  label = "Lock cleanup",
): Promise<T> {
  let value: T;
  try {
    value = await action();
  } catch (error) {
    try {
      await cleanup();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        `${message(error)}\n${label} also failed: ${message(cleanupError)}`,
        { cause: error },
      );
    }
    throw error;
  }
  try {
    await cleanup();
  } catch (error) {
    if (label === "Lock cleanup") throw new LockCleanupError(error);
    throw new Error(`${label} failed: ${message(error)}`, { cause: error });
  }
  return value;
}
