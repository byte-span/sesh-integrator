#!/usr/bin/env node
// Explicit self-development completion step. Never invoke from validation/hooks.
import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { git, inspectGit } from "../dist/git.js";
import {
  readConfig,
  repoId,
  runtimePaths,
  writeJsonAtomic,
} from "../dist/runtime.js";
import { requireCapabilities } from "../dist/capabilities.js";
import {
  preflightRuntimeCompatibility,
  enrollmentStopped,
} from "../dist/coordinator.js";
import { installedHarnesses } from "../dist/harness.js";
import {
  tryFileLock,
  releaseFileLock,
  withCleanup,
} from "../dist/file-lock.js";
import { acquireRepoLock, releaseRepoLock } from "../dist/lock.js";
import { run } from "../dist/process.js";

const project = fileURLToPath(new URL("../", import.meta.url));
const aliases = [
  "seshx",
  "sesh-integrator",
  "pintx",
  "parallel-integrator",
  "codex-handoff",
];
const assets = [
  "skill",
  "scripts",
  "systemd",
  "package.json",
  "harnesses.json",
  "GLOBAL_AGENTS_SNIPPET.md",
];
const buildInputs = [...assets, "src", "tsconfig.json", "tsconfig.build.json"];

export function installationRelevant(path) {
  return /^(src\/|scripts\/|skill\/|systemd\/|package\.json$|pnpm-lock\.yaml$|tsconfig[^/]*\.json$|harnesses\.json$|GLOBAL_AGENTS_SNIPPET\.md$)/.test(
    path,
  );
}
async function command(executable, args, cwd = project, env = process.env) {
  const result = await run(executable, args, { cwd, env, timeoutMs: 120000 });
  if (result.code !== 0)
    throw new Error(
      `${executable} ${args.join(" ")} failed (exit ${result.code}):\n${result.stderr || result.stdout}`,
    );
  return result.stdout;
}
async function physicalDestination(path) {
  try {
    return await realpath(path);
  } catch (error) {
    if (error.code !== "ENOENT" || dirname(path) === path) throw error;
    return join(
      await physicalDestination(dirname(path)),
      relative(dirname(path), path),
    );
  }
}
async function optionalJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
}
async function eligible(sessionId, cwd) {
  if (!/^[a-zA-Z0-9_-]+$/.test(sessionId))
    throw new Error("Invalid session ID");
  const session = await optionalJson(
    join(runtimePaths().sessions, `${sessionId}.json`),
  );
  const context = await inspectGit(cwd);
  if (
    !session ||
    session.id !== sessionId ||
    session.repositoryId !== repoId(context.gitCommonDir)
  )
    throw new Error("Session does not belong to this repository");
  const remoteOnly =
    session.status === "needs_review" &&
    session.recoveryPhase === "pull_request";
  if (
    (!remoteOnly && session.status !== "succeeded") ||
    !session.integratedAt ||
    !session.promotedAt ||
    !session.promotedCommit ||
    session.promotedCommit !== session.integratedCommit ||
    (session.postIntegrationResults ?? []).some(
      (result) => result.exitCode !== 0,
    )
  )
    throw new Error(
      "Local installation requires validated local promotion and successful post-integration checks. Finish or resume integration first.",
    );
  const repository = (await readConfig(true)).repositories.find(
    (repo) => repo.gitCommonDir === context.gitCommonDir,
  );
  if (!repository) throw new Error("Repository is not registered");
  const target =
    repository.targetBranch ??
    repository.globalDefaultTargetBranch ??
    repository.defaultBranch;
  if (
    session.targetBranch !== target ||
    (await git(["rev-parse", `refs/heads/${target}`], cwd)) !==
      session.promotedCommit
  )
    throw new Error(
      "Target moved since this session's promotion; install the newer validated session instead",
    );
  const tree = await git(
    ["rev-parse", `${session.promotedCommit}^{tree}`],
    cwd,
  );
  if (
    (await git(["rev-parse", "HEAD^{tree}"], cwd)) !== tree ||
    (await git(["status", "--porcelain=v1", "--untracked-files=all"], cwd))
  )
    throw new Error(
      "Use a clean source worktree whose tree matches the exact promoted commit; user changes were preserved",
    );
  return { session, context, tree, remoteOnly };
}
async function entries(cwd, commit) {
  return (await git(["ls-tree", "-r", "-z", commit, "--", ...buildInputs], cwd))
    .split("\0")
    .filter(Boolean)
    .map((line) => {
      const match = /^(100644|100755) blob ([a-f0-9]+)\t(.+)$/s.exec(line);
      if (!match)
        throw new Error(
          `Unsupported build asset (regular files required): ${line}`,
        );
      const [, mode, oid, path] = match;
      if (
        path
          .split("/")
          .some((part) => part === ".env" || part.startsWith(".env."))
      )
        throw new Error(`Secret-protected asset excluded: ${path}`);
      return { mode, oid, path };
    });
}
async function prepareBuild(cwd, session, releaseRoot) {
  // Copy only committed inputs, verifying Git blob hashes. Ignored dist files
  // and untracked/ignored files inside packaged directories are never imported.
  const root = await mkdtemp(join(releaseRoot, "build-local-"));
  try {
    for (const entry of await entries(cwd, session.promotedCommit)) {
      const source = join(cwd, entry.path);
      if (!(await lstat(source)).isFile())
        throw new Error(`Build input is not a regular file: ${source}`);
      const bytes = await readFile(source);
      const hash = createHash(entry.oid.length === 64 ? "sha256" : "sha1")
        .update(`blob ${bytes.length}\0`)
        .update(bytes)
        .digest("hex");
      if (hash !== entry.oid) throw new Error(`Build input changed: ${source}`);
      const destination = join(root, entry.path);
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, bytes, {
        flag: "wx",
        mode: entry.mode === "100755" ? 0o755 : 0o644,
      });
    }
    const dependencies = await realpath(join(cwd, "node_modules"));
    const link = join(root, "node_modules");
    await symlink(dependencies, link, "dir");
    await withCleanup(
      () =>
        command(
          process.execPath,
          [
            join(dependencies, "typescript/bin/tsc"),
            "-p",
            join(root, "tsconfig.build.json"),
          ],
          root,
        ),
      () => unlink(link),
      "Build dependency link cleanup",
    );
    return root;
  } catch (error) {
    throw new Error(
      `Local build failed; preserved build artifacts at ${root}: ${error.message}`,
      { cause: error },
    );
  }
}
async function assetDigest(root) {
  // Verify every packaged byte, including compiled output, before reporting success.
  const { readdir } = await import("node:fs/promises");
  const hash = createHash("sha256");
  async function walk(path) {
    const info = await lstat(join(root, path));
    if (info.isDirectory())
      for (const name of (await readdir(join(root, path))).sort())
        await walk(join(path, name));
    else if (info.isFile()) {
      const bytes = await readFile(join(root, path));
      hash.update(path + "\0" + bytes.length + "\0").update(bytes);
    } else throw new Error(`Unexpected installed asset: ${join(root, path)}`);
  }
  for (const path of ["dist", ...assets]) await walk(path);
  return hash.digest("hex");
}
async function aliasesMatch(bin, cli) {
  try {
    for (const name of aliases)
      if ((await realpath(join(bin, name))) !== cli) return false;
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}
export async function installLocal(sessionId, cwd = project) {
  if (process.platform === "win32")
    throw new Error(
      "This source snapshot installer supports Linux/macOS/WSL; use the platform's native installation procedure on Windows",
    );
  const { session, context } = await eligible(sessionId, cwd);
  const changed = (
    await git(
      ["diff", "--name-only", session.startCommit, session.readyCommit, "--"],
      cwd,
    )
  ).split("\n");
  if (!changed.some(installationRelevant)) {
    console.log(
      "Local installation not required: this session changed no installed behavior or assets.",
    );
    return;
  }
  const bin = await physicalDestination(
    resolve(
      process.env.SESH_INTEGRATOR_BIN_DIR ??
        process.env.PARALLEL_INTEGRATOR_BIN_DIR ??
        process.env.CODEX_HANDOFF_BIN_DIR ??
        join(homedir(), ".local/bin"),
    ),
  );
  const releases = await physicalDestination(
    resolve(
      process.env.SESH_INTEGRATOR_RELEASE_DIR ??
        join(homedir(), ".local/share/sesh-integrator/releases"),
    ),
  );
  const worktrees = (await git(["worktree", "list", "--porcelain", "-z"], cwd))
    .split("\0")
    .filter((part) => part.startsWith("worktree "))
    .map((part) => part.slice(9));
  for (const worktree of worktrees)
    for (const destination of [bin, releases]) {
      const rel = relative(await realpath(worktree), destination);
      if (
        !rel ||
        (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel))
      )
        throw new Error(
          "Installation destinations must be outside all repository worktrees",
        );
    }
  await requireCapabilities(cwd, false, [bin, releases]);
  await preflightRuntimeCompatibility();
  const paths = runtimePaths();
  const installLock = await tryFileLock(
    join(paths.locks, "local-install.lock"),
    { sessionId },
  );
  if (!installLock)
    throw new Error(
      "Another local installation owns local-install.lock; preserve unknown locks and retry after its owner finishes",
    );
  return withCleanup(
    async () => {
      const repoLock = await acquireRepoLock(
        session.repositoryId,
        sessionId,
        0,
        session.integrationWorktreePath ?? cwd,
        true,
        "install a locally promoted CLI",
      );
      return withCleanup(
        async () => {
          const state = await eligible(sessionId, cwd);
          const receiptPath = join(
            paths.root,
            "local-installations",
            `${session.repositoryId}.json`,
          );
          const previous = await optionalJson(receiptPath);
          if (previous && previous.version !== 1)
            throw new Error(
              `Unsupported installation receipt version at ${receiptPath}; preserve it and use a compatible installer`,
            );
          let receipt = {
            version: 1,
            sessionId,
            sourceCommit: session.readyCommit,
            promotedCommit: session.promotedCommit,
            tree: state.tree,
            phase: "preparing",
            bin,
            remotePromotion: state.remoteOnly ? "pending" : "not-pending",
          };
          try {
            let reusable =
              previous?.version === 1 &&
              previous.tree === state.tree &&
              previous.bin === bin &&
              previous.cliPath &&
              (await aliasesMatch(bin, previous.cliPath));
            if (reusable)
              reusable =
                (await assetDigest(dirname(dirname(previous.cliPath)))) ===
                previous.assetDigest;
            if (reusable) {
              receipt = {
                ...receipt,
                cliPath: previous.cliPath,
                assetDigest: previous.assetDigest,
                buildPath: previous.buildPath,
                phase: "published",
              };
              console.log(
                `Reusing verified installed snapshot: ${receipt.cliPath}`,
              );
            } else {
              await mkdir(releases, { recursive: true });
              // Resolve after creation too: reject a symlink into the source tree.
              const physical = await realpath(releases);
              const rel = relative(context.worktreePath, physical);
              if (
                !rel ||
                (!rel.startsWith(`..${sep}`) &&
                  rel !== ".." &&
                  !isAbsolute(rel))
              )
                throw new Error(
                  "Release directory resolves inside the source worktree",
                );
              receipt.buildPath = await prepareBuild(cwd, session, physical);
              await eligible(sessionId, cwd);
              receipt.phase = "publishing";
              receipt.assetDigest = await assetDigest(receipt.buildPath);
              await writeJsonAtomic(receiptPath, receipt);
              const output = await command(
                "sh",
                [join(receipt.buildPath, "scripts/install-cli.sh"), "--stable"],
                cwd,
                {
                  ...process.env,
                  SESH_INTEGRATOR_BIN_DIR: bin,
                  SESH_INTEGRATOR_RELEASE_DIR: releases,
                },
              );
              process.stdout.write(output);
              receipt.cliPath = await realpath(join(bin, "seshx"));
              receipt.phase = "published";
              await writeJsonAtomic(receiptPath, receipt);
            }
            if (
              !(await aliasesMatch(bin, receipt.cliPath)) ||
              (await assetDigest(dirname(dirname(receipt.cliPath)))) !==
                receipt.assetDigest
            )
              throw new Error(
                "Installed aliases or assets differ from the built snapshot",
              );
            const help = await command(join(bin, "seshx"), ["--help"], cwd);
            if (!help.startsWith("seshx -"))
              throw new Error(
                "Installed CLI verification failed: unexpected help output",
              );
            await command(
              process.execPath,
              [receipt.cliPath, "installation-check"],
              cwd,
            );
            receipt.phase = "refreshing-guidance";
            await writeJsonAtomic(receiptPath, receipt);
            const harnesses = [];
            const deferredHarnesses = [];
            for (const harness of installedHarnesses(homedir())) {
              if (await enrollmentStopped(harness))
                deferredHarnesses.push(harness);
              else harnesses.push(harness);
            }
            receipt.deferredHarnesses = deferredHarnesses;
            if (harnesses.length)
              await command(
                process.execPath,
                [
                  receipt.cliPath,
                  "setup",
                  ...harnesses.flatMap((h) => ["--harness", h]),
                  "--yes",
                ],
                cwd,
              );
            // Respect manual mode and opt-outs; never clear blocked reports by recheck.
            await requireCapabilities(cwd, false, [bin, releases]);
            await eligible(sessionId, cwd);
            if (!(await aliasesMatch(bin, receipt.cliPath)))
              throw new Error("Installed aliases changed during verification");
            receipt.phase = "verified";
            receipt.verifiedAt = new Date().toISOString();
            receipt.harnesses = harnesses;
            await writeJsonAtomic(receiptPath, receipt);
            console.log(
              `Local installation: verified\nSource commit: ${receipt.sourceCommit}\nPromoted commit: ${receipt.promotedCommit}\nInstalled CLI: ${receipt.cliPath}\nGuidance refreshed: ${harnesses.join(", ") || "none applicable"}\nStopped harnesses preserved: ${deferredHarnesses.join(", ") || "none"}\nReceipt: ${receiptPath}\nPinned coordinators retained; source/remote integration status was not changed.`,
            );
            return receipt;
          } catch (error) {
            const failure = new Error(
              `Local installation incomplete (${receipt.phase}). Source promotion is unchanged. Published aliases may already reference the new snapshot; previous releases and build artifacts are preserved. Retry this script with the same session after correcting the reported condition. Receipt: ${receiptPath}\n${error.message}`,
              { cause: error },
            );
            await withCleanup(
              async () => {
                throw failure;
              },
              () =>
                writeJsonAtomic(receiptPath, {
                  ...receipt,
                  failedAt: new Date().toISOString(),
                  error: error.message,
                }),
              "Installation evidence persistence",
            );
          }
        },
        () => releaseRepoLock(repoLock),
      );
    },
    () => releaseFileLock(installLock),
  );
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const args = process.argv.slice(2);
  if (
    args.length !== 2 ||
    args[0] !== "--session" ||
    !/^[a-zA-Z0-9_-]+$/.test(args[1])
  ) {
    console.error(
      "Usage: node scripts/install-local.mjs --session <integrated-session-id>",
    );
    process.exitCode = 1;
  } else
    installLocal(args[1]).catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}
