// Records the Git commit the build was made from, for `seshx version`.
// Never fails the build: outside a Git checkout the commit is null.
import { execFileSync } from "node:child_process";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const git = (...args) => {
  try {
    return execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return undefined;
  }
};
const commit = git("rev-parse", "--verify", "HEAD^{commit}");
const status = commit === undefined ? undefined : git("status", "--porcelain");
const info = {
  commit: /^[0-9a-f]{40,64}$/.test(commit ?? "") ? commit : null,
  dirty: status === undefined ? null : status.length > 0,
};
const file = join(root, "dist", "build-info.json");
mkdirSync(dirname(file), { recursive: true });
const temporary = `${file}.${process.pid}.tmp`;
writeFileSync(temporary, `${JSON.stringify(info, null, 2)}\n`);
renameSync(temporary, file);
