import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanupBenchmark } from "../src/benchmark-cleanup.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, rm: vi.fn(actual.rm) };
});

const actual =
  await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
let root: string;
beforeEach(async () => {
  vi.mocked(rm).mockReset().mockImplementation(actual.rm);
  root = await mkdtemp(join(tmpdir(), "benchmark-cleanup-test-"));
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await actual.rm(root, { recursive: true, force: true });
});

it("records a transient failure before successful cleanup without reading files or following symlinks", async () => {
  const fixture = join(root, "fixture");
  const diagnostics = join(root, "diagnostics");
  const outside = join(root, "outside");
  await mkdir(fixture);
  await mkdir(outside);
  await writeFile(join(fixture, "remaining.txt"), "DO_NOT_RECORD_CONTENTS");
  await writeFile(join(outside, "outside.txt"), "keep");
  await symlink(outside, join(fixture, "link"));
  vi.stubEnv("SESH_INTEGRATOR_BENCHMARK_DIAGNOSTICS_DIR", diagnostics);
  vi.mocked(rm).mockRejectedValueOnce(
    Object.assign(new Error("busy"), { code: "ENOTEMPTY" }),
  );

  await cleanupBenchmark(fixture);

  await expect(readdir(fixture)).rejects.toMatchObject({ code: "ENOENT" });
  const report = await readFile(
    join(diagnostics, "fixture-cleanup-1.json"),
    "utf8",
  );
  expect(JSON.parse(report)).toMatchObject({
    attempt: 1,
    error: { code: "ENOTEMPTY" },
  });
  expect(report).toContain("remaining.txt");
  expect(report).not.toContain("DO_NOT_RECORD_CONTENTS");
  expect(report).not.toContain("outside.txt");
  expect(await readFile(join(outside, "outside.txt"), "utf8")).toBe("keep");
});

it("stops after three transient failures and preserves the error", async () => {
  const failure = Object.assign(new Error("busy"), { code: "ENOTEMPTY" });
  vi.stubEnv("SESH_INTEGRATOR_BENCHMARK_DIAGNOSTICS_DIR", "");
  vi.mocked(rm).mockRejectedValue(failure);
  await expect(cleanupBenchmark(join(root, "fixture"))).rejects.toBe(failure);
  expect(rm).toHaveBeenCalledTimes(3);
});

it("does not retry unrelated errors or replace them when diagnostics fail", async () => {
  const failure = Object.assign(new Error("denied"), { code: "EACCES" });
  const destination = join(root, "file");
  await writeFile(destination, "not a directory");
  vi.stubEnv("SESH_INTEGRATOR_BENCHMARK_DIAGNOSTICS_DIR", destination);
  vi.mocked(rm).mockRejectedValue(failure);
  await expect(cleanupBenchmark(join(root, "fixture"))).rejects.toBe(failure);
  expect(rm).toHaveBeenCalledTimes(1);
});
