import { runValidation } from "../src/process.js";
import * as fs from "node:fs/promises";
import { spawn } from "node:child_process";
import { hostname, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { tryFileLock, releaseFileLock, withCleanup } from "../src/file-lock.js";
import { ensureRuntime, withConfigLock, runtimePaths } from "../src/runtime.js";
import {
  acquireRepoLock,
  releaseRepoLock,
  readLockMetadata,
} from "../src/lock.js";
import {
  acquireValidationResources,
  releaseValidationResources,
} from "../src/resource-lock.js";

vi.mock("node:fs/promises", async (original) => ({
  ...(await original<typeof import("node:fs/promises")>()),
}));

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});
async function fixture() {
  const root = await fs.mkdtemp(join(tmpdir(), "sesh-file-lock-"));
  roots.push(root);
  vi.stubEnv("SESH_INTEGRATOR_HOME", join(root, "runtime"));
  await ensureRuntime();
  return root;
}

it("excludes legacy directory acquisition in both directions without removing old locks", async () => {
  const path = join(await fixture(), "lock");
  await fs.mkdir(path);
  expect(await tryFileLock(path)).toBeUndefined();
  expect((await fs.lstat(path)).isDirectory()).toBe(true);
  await fs.rmdir(path);
  const owner = (await tryFileLock(path))!;
  await expect(fs.mkdir(path)).rejects.toMatchObject({ code: "EEXIST" });
  expect(await tryFileLock(path)).toBeUndefined();
  await releaseFileLock(owner);
  await fs.mkdir(path);
});

it("serializes independent processes and never admits two owners", async () => {
  const root = await fixture();
  const script = `
    import {tryFileLock, releaseFileLock} from ${JSON.stringify(resolve("dist/file-lock.js"))};
    import {open, unlink} from 'node:fs/promises';
    for(let i=0;i<12;i++) {
      let lock;
      while(!(lock=await tryFileLock(${JSON.stringify(join(root, "lock"))})))
        await new Promise(r=>setTimeout(r,2));
      const sentinel=await open(${JSON.stringify(join(root, "critical"))},'wx');
      await new Promise(r=>setTimeout(r,2));
      await sentinel.close();
      await unlink(${JSON.stringify(join(root, "critical"))});
      await releaseFileLock(lock);
    }
  `;
  await Promise.all(
    Array.from(
      { length: 4 },
      () =>
        new Promise<void>((accept, reject) => {
          const child = spawn(
            process.execPath,
            ["--input-type=module", "-e", script],
            { stdio: ["ignore", "ignore", "pipe"] },
          );
          let stderr = "";
          child.stderr.on("data", (data) => (stderr += String(data)));
          child.on("error", reject);
          child.on("exit", (code) =>
            code === 0 ? accept() : reject(new Error(stderr)),
          );
        }),
    ),
  );
}, 15000);

it("does not remove a lock whose token changed", async () => {
  const path = join(await fixture(), "lock");
  const owner = (await tryFileLock(path))!;
  await fs.writeFile(path, JSON.stringify({ token: "another owner" }));
  await expect(releaseFileLock(owner)).rejects.toThrow("no longer owned");
  expect(JSON.parse(await fs.readFile(path, "utf8")).token).toBe(
    "another owner",
  );
});

it("does not follow symlinks or remove replacement directories", async () => {
  const root = await fixture();
  const path = join(root, "lock");
  const owner = (await tryFileLock(path))!;
  await fs.rename(path, join(root, "original"));
  await fs.symlink(join(root, "original"), path);
  await expect(releaseFileLock(owner)).rejects.toThrow("replaced lock");
  expect(await tryFileLock(path)).toBeUndefined();
  await fs.unlink(path);
  await fs.mkdir(path);
  await expect(releaseFileLock(owner)).rejects.toThrow("replaced lock");
});

it("preserves interrupted empty owner records instead of stealing them", async () => {
  const path = join(await fixture(), "lock");
  await fs.writeFile(path, "");
  expect(await tryFileLock(path)).toBeUndefined();
  expect(await fs.readFile(path, "utf8")).toBe("");
});

it("retains an interrupted process's lock for inspection", async () => {
  const path = join(await fixture(), "lock");
  const script = `import {tryFileLock} from ${JSON.stringify(resolve("dist/file-lock.js"))}; await tryFileLock(${JSON.stringify(path)}); process.exit(0);`;
  await new Promise<void>((accept, reject) => {
    const child = spawn(process.execPath, [
      "--input-type=module",
      "-e",
      script,
    ]);
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0 ? accept() : reject(new Error(`exit ${code}`)),
    );
  });
  expect(await tryFileLock(path)).toBeUndefined();
  expect(JSON.parse(await fs.readFile(path, "utf8")).pid).not.toBe(process.pid);
});

it("preserves the primary error and release error together", async () => {
  const action = new Error("original setup failure");
  const cleanup = new Error("EPERM releasing lock");
  const result = await withCleanup(
    async () => {
      throw action;
    },
    async () => {
      throw cleanup;
    },
  ).catch((e) => e);
  expect(result).toBeInstanceOf(AggregateError);
  expect(result.errors).toEqual([action, cleanup]);
  expect(result.cause).toBe(action);
  expect(result.message).toContain(action.message);
  expect(result.message).toContain(cleanup.message);
  await expect(
    withCleanup(
      async () => {
        throw action;
      },
      async () => {},
    ),
  ).rejects.toBe(action);
});

it("reports release failures even when the operation succeeds", async () => {
  await expect(
    withCleanup(
      async () => 42,
      async () => {
        throw new Error("release denied");
      },
    ),
  ).rejects.toThrow("release denied");
});

it("releases configuration, repository, and validation gates without directory deletion", async () => {
  await fixture();
  const original = fs.rm;
  vi.spyOn(fs, "rm").mockImplementation(async (path, options) => {
    if (options?.recursive)
      throw Object.assign(new Error("directory removal denied"), {
        code: "EPERM",
      });
    return original(path, options);
  });
  for (let i = 0; i < 3; i++) {
    await withConfigLock(async () =>
      expect(
        (await fs.lstat(join(runtimePaths().locks, "configuration"))).isFile(),
      ).toBe(true),
    );
    const repo = await acquireRepoLock("repo", "session", 0, "/not-used");
    expect((await readLockMetadata(repo.path))?.sessionId).toBe("session");
    await releaseRepoLock(repo);
    const resource = await acquireValidationResources(
      [],
      ["service:test"],
      "session",
      0,
    );
    await releaseValidationResources(resource);
  }
});

it("serializes configuration mutations and releases after an action fails", async () => {
  await fixture();
  let inFlight = 0;
  await Promise.all(
    Array.from({ length: 8 }, () =>
      withConfigLock(async () => {
        expect(++inFlight).toBe(1);
        await new Promise((r) => setTimeout(r, 5));
        --inFlight;
      }),
    ),
  );
  const original = new Error("setup failed");
  await expect(
    withConfigLock(async () => {
      throw original;
    }),
  ).rejects.toBe(original);
  await expect(withConfigLock(async () => "next command")).resolves.toBe(
    "next command",
  );
});

it("configuration cleanup failure cannot hide the original action error", async () => {
  await fixture();
  const unlink = fs.unlink;
  vi.spyOn(fs, "unlink").mockImplementation(async (path) => {
    if (String(path).endsWith("configuration"))
      throw Object.assign(new Error("EPERM"), { code: "EPERM" });
    return unlink(path);
  });
  const result = await withConfigLock(async () => {
    throw new Error("original action error");
  }).catch((e) => e);
  expect(result.message).toContain("original action error");
  expect(result.message).toContain("EPERM");
  expect(
    (await fs.lstat(join(runtimePaths().locks, "configuration"))).isFile(),
  ).toBe(true);
});

it("recognizes legacy repository owner records and refuses busy legacy locks", async () => {
  await fixture();
  const path = join(runtimePaths().locks, "repo.lock");
  await fs.mkdir(path);
  const owner = {
    pid: process.pid,
    hostname: hostname(),
    sessionId: "old",
    acquiredAt: "now",
    startedAt: "now",
  };
  await fs.writeFile(join(path, "owner.json"), JSON.stringify(owner));
  expect(await readLockMetadata(path)).toEqual(owner);
  await expect(acquireRepoLock("repo", "new", 0, "/not-used")).rejects.toThrow(
    "Timed out",
  );
  expect(await readLockMetadata(path)).toEqual(owner);
});

it("preserves malformed metadata and does not treat it as a dead owner", async () => {
  await fixture();
  const path = join(runtimePaths().locks, "repo.lock");
  await fs.writeFile(path, JSON.stringify({ pid: -1, hostname: hostname() }));
  expect(await readLockMetadata(path)).toBeNull();
  await expect(acquireRepoLock("repo", "new", 0, "/not-used")).rejects.toThrow(
    "unknown owner",
  );
  expect((await fs.lstat(path)).isFile()).toBe(true);
});

it("blocks on a legacy validation gate and leaves it intact", async () => {
  await fixture();
  const key = "legacy:gate";
  const gate = join(
    runtimePaths().locks,
    "validation-resources",
    createHash("sha256").update(key).digest("hex"),
    "gate",
  );
  await fs.mkdir(gate, { recursive: true });
  await expect(acquireValidationResources([], [key], "new", 0)).rejects.toThrow(
    "Timed out",
  );
  expect((await fs.lstat(gate)).isDirectory()).toBe(true);
});

it("fails closed on interrupted resource lease metadata", async () => {
  await fixture();
  const key = "interrupted:lease";
  const root = join(
    runtimePaths().locks,
    "validation-resources",
    createHash("sha256").update(key).digest("hex"),
  );
  await fs.mkdir(join(root, "holders"), { recursive: true });
  await fs.writeFile(join(root, "holders", "partial.json"), "{");
  await expect(acquireValidationResources([], [key], "new", 0)).rejects.toThrow(
    "unreadable or invalid",
  );
  expect(await fs.readFile(join(root, "holders", "partial.json"), "utf8")).toBe(
    "{",
  );
  await expect(fs.stat(join(root, "gate"))).rejects.toMatchObject({
    code: "ENOENT",
  });
});

it("does not retry validation when releasing its resource fails, and keeps both errors", async () => {
  const root = await fixture();
  const attempts = join(root, "attempts");
  const original = fs.rm;
  vi.spyOn(fs, "rm").mockImplementation(async (path, options) => {
    if (String(path).includes("/holders/"))
      throw new Error("lease cleanup denied");
    return original(path, options);
  });
  const result = await runValidation(
    [
      {
        command: [
          process.execPath,
          "-e",
          `require('fs').appendFileSync(${JSON.stringify(attempts)},'attempt\\n');process.exit(1)`,
        ],
        resources: { exclusive: ["cleanup:test"] },
        failure: {
          classification: "transient",
          maxAttempts: 3,
          initialBackoffMs: 1,
          maxBackoffMs: 1,
        },
      },
    ],
    root,
    { sessionId: "cleanup-test", resourceWaitSeconds: 0 },
  ).catch((error) => error);
  expect(result).toBeInstanceOf(AggregateError);
  expect(result.message).toContain("Validation failed (1)");
  expect(result.message).toContain("lease cleanup denied");
  expect(await fs.readFile(attempts, "utf8")).toBe("attempt\n");
});
