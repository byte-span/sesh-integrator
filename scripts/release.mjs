import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const stableVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export function nextVersion(current, tags, bump) {
  if (!stableVersion.test(current))
    throw new Error("Expected a stable package version");
  const index = ["major", "minor", "patch"].indexOf(bump);
  if (index < 0) throw new Error("Choose patch, minor, or major");
  const versions = [
    current,
    ...tags.filter((tag) => /^v/.test(tag)).map((tag) => tag.slice(1)),
  ]
    .filter((version) => stableVersion.test(version))
    .map((version) => version.split(".").map(BigInt));
  versions.sort((a, b) => {
    for (let i = 0; i < 3; i++) {
      if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
    }
    return 0;
  });
  const version = versions.at(-1);
  version[index] += 1n;
  for (let i = index + 1; i < 3; i++) version[i] = 0n;
  return version.join(".");
}

// Only mutates the disposable Actions checkout. Branch tips are never advanced.
export function prepareRelease({ cwd, ref, base, runId, bump }) {
  if (ref !== "refs/heads/main") throw new Error("Run Release from main only");
  if (!/^[a-f0-9]{40}$/.test(base ?? ""))
    throw new Error("Expected the dispatch commit SHA");
  if (!/^\d+$/.test(runId ?? ""))
    throw new Error("Expected a GitHub workflow run ID");
  const git = (...args) =>
    execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  if (git("rev-parse", "HEAD") !== base)
    throw new Error("Checkout differs from the dispatch commit");
  if (git("status", "--porcelain"))
    throw new Error("Release checkout must be clean");
  const tags = git("tag", "--list").split("\n").filter(Boolean);
  const marker = `Release-run: ${runId}`;
  const existing = tags.filter(
    (tag) =>
      /^v\d+\.\d+\.\d+$/.test(tag) &&
      git("log", "-1", "--format=%B", tag).split("\n").includes(marker),
  );
  if (existing.length > 1)
    throw new Error("Multiple release tags claim this workflow run");
  if (existing.length === 1) {
    const tag = existing[0];
    if (git("rev-parse", `${tag}^`) !== base)
      throw new Error("Existing release has a different source commit");
    const pkg = JSON.parse(git("show", `${tag}:package.json`));
    if (`v${pkg.version}` !== tag)
      throw new Error("Existing tag and package versions differ");
    if (
      nextVersion(pkg.version, tags, "patch") !==
      nextVersion(pkg.version, [], "patch")
    ) {
      throw new Error("A newer release tag exists; start a new run from main");
    }
    const original = JSON.parse(git("show", `${base}:package.json`));
    original.version = pkg.version;
    if (JSON.stringify(original) !== JSON.stringify(pkg)) {
      throw new Error("Existing release changed other package fields");
    }
    if (git("diff", "--name-only", base, tag) !== "package.json") {
      throw new Error("Existing release changed more than the package version");
    }
    git("checkout", "--detach", tag);
    return { version: pkg.version, tag, commit: git("rev-parse", "HEAD") };
  }
  const path = resolve(cwd, "package.json");
  const pkg = JSON.parse(readFileSync(path, "utf8"));
  const version = nextVersion(pkg.version, tags, bump);
  // Release versions live on tags; main/dev keep their development baseline.
  pkg.version = version;
  writeFileSync(path, `${JSON.stringify(pkg, null, 2)}\n`);
  git("checkout", "--detach", base);
  git("add", "--", "package.json");
  git(
    "-c",
    "user.name=github-actions[bot]",
    "-c",
    "user.email=41898282+github-actions[bot]@users.noreply.github.com",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-m",
    `Release v${version}\n\n${marker}`,
  );
  return { version, tag: `v${version}`, commit: git("rev-parse", "HEAD") };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const result = prepareRelease({
    cwd: process.cwd(),
    ref: process.env.GITHUB_REF,
    base: process.env.GITHUB_SHA,
    runId: process.env.GITHUB_RUN_ID,
    bump: process.env.RELEASE_BUMP,
  });
  if (process.env.GITHUB_OUTPUT) {
    for (const [key, value] of Object.entries(result)) {
      appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
    }
  }
  console.log(`Prepared ${result.tag} at ${result.commit}`);
}
