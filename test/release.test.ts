import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { nextVersion, prepareRelease } from "../scripts/release.mjs";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), "sesh-release-"));
  roots.push(cwd);
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_AUTHOR_NAME: "Test",
        GIT_AUTHOR_EMAIL: "test@example.com",
        GIT_COMMITTER_NAME: "Test",
        GIT_COMMITTER_EMAIL: "test@example.com",
      },
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  git("init", "-b", "main");
  git("config", "commit.gpgsign", "false");
  git("config", "core.hooksPath", join(cwd, "no-hooks"));
  writeFileSync(
    join(cwd, "package.json"),
    '{"name":"sesh-integrator","version":"0.1.0"}\n',
  );
  git("add", ".");
  git("commit", "-m", "Reviewed source");
  const base = git("rev-parse", "HEAD");
  const options = {
    cwd,
    base,
    ref: "refs/heads/main",
    runId: "123",
    bump: "patch",
  };
  return { cwd, git, base, options };
}

it("increments from the highest stable version, ignoring prereleases and unrelated tags", () => {
  const tags = ["v0.9.9", "v0.10.2", "v99.0.0-beta.1", "archive", "v01.0.0"];
  expect(nextVersion("0.1.0", tags, "patch")).toBe("0.10.3");
  expect(nextVersion("0.1.0", tags, "minor")).toBe("0.11.0");
  expect(nextVersion("0.1.0", tags, "major")).toBe("1.0.0");
  expect(nextVersion("2.0.0", tags, "patch")).toBe("2.0.1");
  expect(() => nextVersion("0.1.0", [], "invalid")).toThrow("Choose");
  expect(() => nextVersion("invalid", [], "patch")).toThrow("stable");
});

it("creates a versioned child commit without changing main or creating a tag before validation", () => {
  const f = fixture();
  const result = prepareRelease(f.options);
  expect(result.tag).toBe("v0.1.1");
  expect(f.git("rev-parse", "main")).toBe(f.base);
  expect(f.git("rev-parse", "HEAD^")).toBe(f.base);
  expect(f.git("diff", "--name-only", f.base, result.commit)).toBe(
    "package.json",
  );
  expect(
    JSON.parse(readFileSync(join(f.cwd, "package.json"), "utf8")).version,
  ).toBe("0.1.1");
  expect(f.git("status", "--porcelain")).toBe("");
  expect(f.git("tag", "--list")).toBe("");
});

it("resumes the exact tagged commit on rerun instead of allocating another version", () => {
  const f = fixture();
  const first = prepareRelease(f.options);
  f.git("tag", first.tag, first.commit);
  f.git("checkout", "--detach", f.base);
  expect(prepareRelease(f.options)).toEqual(first);
});

it("uses existing tag versions even though main keeps the development baseline", () => {
  const f = fixture();
  f.git("tag", "v2.4.8");
  expect(prepareRelease({ ...f.options, bump: "minor" }).version).toBe("2.5.0");
});

it("refuses to resume an older release after a newer tag exists", () => {
  const f = fixture();
  const first = prepareRelease(f.options);
  f.git("tag", first.tag, first.commit);
  f.git("tag", "v0.2.0", f.base);
  f.git("checkout", "--detach", f.base);
  expect(() => prepareRelease(f.options)).toThrow("newer release");
});

it("rejects the wrong branch, wrong commit and dirty source before making changes", () => {
  const f = fixture();
  expect(() => prepareRelease({ ...f.options, ref: "refs/heads/dev" })).toThrow(
    "main only",
  );
  expect(() => prepareRelease({ ...f.options, base: "a".repeat(40) })).toThrow(
    "differs",
  );
  expect(() =>
    prepareRelease({ ...f.options, runId: "123\nvalue=bad" }),
  ).toThrow("run ID");
  writeFileSync(join(f.cwd, "user.txt"), "preserve");
  expect(() => prepareRelease(f.options)).toThrow("clean");
  expect(f.git("rev-parse", "HEAD")).toBe(f.base);
  expect(readFileSync(join(f.cwd, "user.txt"), "utf8")).toBe("preserve");
});

it("refuses a rerun tag with a different source commit", () => {
  const f = fixture();
  const first = prepareRelease(f.options);
  f.git("tag", first.tag, first.commit);
  f.git("checkout", "main");
  writeFileSync(join(f.cwd, "new.txt"), "next reviewed change");
  f.git("add", ".");
  f.git("commit", "-m", "Next source");
  expect(() =>
    prepareRelease({ ...f.options, base: f.git("rev-parse", "HEAD") }),
  ).toThrow("different source");
});
