import { readdir, readFile, realpath } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import type { Command } from "./types.js";

const SKIPPED_DIRECTORIES = new Set([
  ".git",
  ".next",
  ".nuxt",
  ".output",
  ".svelte-kit",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "out",
  "target",
  "vendor",
]);

interface PackageManifest {
  path: string;
  directory: string;
  scripts: Record<string, string>;
  dependencies: Map<string, string>;
}

export interface InferredPreparation {
  environment: string;
  cwd: string;
  command: Command;
}

interface PreparationConvention {
  environment: string;
  dependencies: string[];
  executable: string;
  args: string[];
  alreadyPrepared: RegExp;
  supportedVersion?: (version: string) => boolean;
}

const CONVENTIONS: PreparationConvention[] = [
  {
    environment: "Next.js",
    dependencies: ["next"],
    executable: "next",
    args: ["typegen"],
    alreadyPrepared: /(?:^|\s)next\s+typegen(?:\s|$)/,
    supportedVersion: (version) => minimumMajorMinor(version, 15, 5),
  },
  {
    environment: "SvelteKit",
    dependencies: ["@sveltejs/kit"],
    executable: "svelte-kit",
    args: ["sync"],
    alreadyPrepared: /(?:^|\s)svelte-kit\s+sync(?:\s|$)/,
  },
  {
    environment: "Nuxt",
    dependencies: ["nuxt"],
    executable: "nuxt",
    args: ["prepare"],
    alreadyPrepared: /(?:^|\s)nuxt\s+prepare(?:\s|$)/,
  },
  {
    environment: "Astro",
    dependencies: ["astro"],
    executable: "astro",
    args: ["sync"],
    alreadyPrepared: /(?:^|\s)astro\s+sync(?:\s|$)/,
  },
  {
    environment: "React Router",
    dependencies: ["@react-router/dev"],
    executable: "react-router",
    args: ["typegen"],
    alreadyPrepared: /(?:^|\s)react-router\s+typegen(?:\s|$)/,
  },
];

export async function detectValidationPreparation(
  repositoryPath: string,
): Promise<InferredPreparation[]> {
  const canonicalPath = await realpath(repositoryPath);
  const manifests = await findPackageManifests(canonicalPath);
  if (manifests.length === 0) return [];
  const packageManager = await detectPackageManager(canonicalPath, manifests);
  const preparations: InferredPreparation[] = [];
  for (const manifest of manifests) {
    const scriptBodies = Object.values(manifest.scripts);
    for (const convention of CONVENTIONS) {
      if (
        !convention.dependencies.some((dependency) => {
          const version = manifest.dependencies.get(dependency);
          return (
            version !== undefined &&
            (!convention.supportedVersion ||
              convention.supportedVersion(version))
          );
        }) ||
        scriptBodies.some((script) => convention.alreadyPrepared.test(script))
      ) {
        continue;
      }
      preparations.push({
        environment: convention.environment,
        cwd: manifest.directory,
        command: packageExecutableCommand(
          packageManager,
          convention.executable,
          convention.args,
        ),
      });
    }
  }
  return preparations;
}

async function findPackageManifests(
  repositoryPath: string,
): Promise<PackageManifest[]> {
  const paths: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const path = join(directory, entry.name);
      if (entry.isFile() && entry.name === "package.json") paths.push(path);
      if (
        entry.isDirectory() &&
        !SKIPPED_DIRECTORIES.has(entry.name) &&
        !entry.name.startsWith(".parallel-integrator") &&
        !entry.name.startsWith(".codex-handoff")
      ) {
        await visit(path);
      }
    }
  };
  await visit(repositoryPath);
  return await Promise.all(paths.sort().map(readManifest));
}

async function readManifest(path: string): Promise<PackageManifest> {
  const value: unknown = JSON.parse(await readFile(path, "utf8"));
  if (!isRecord(value)) throw new Error(`Invalid package manifest: ${path}`);
  const scripts = stringRecord(value.scripts);
  const dependencies = new Map<string, string>();
  for (const field of [
    value.dependencies,
    value.devDependencies,
    value.optionalDependencies,
    value.peerDependencies,
  ]) {
    for (const [dependency, version] of Object.entries(stringRecord(field))) {
      dependencies.set(dependency, version);
    }
  }
  return { path, directory: dirname(path), scripts, dependencies };
}

async function detectPackageManager(
  repositoryPath: string,
  manifests: PackageManifest[],
): Promise<string> {
  const rootManifest = manifests.find(
    (manifest) => manifest.directory === repositoryPath,
  );
  const value: unknown = rootManifest
    ? JSON.parse(await readFile(rootManifest.path, "utf8"))
    : null;
  if (isRecord(value) && typeof value.packageManager === "string") {
    const declared = value.packageManager.split("@", 1)[0];
    if (declared && ["pnpm", "yarn", "npm", "bun"].includes(declared)) {
      return declared;
    }
  }
  for (const [lockfile, packageManager] of [
    ["pnpm-lock.yaml", "pnpm"],
    ["yarn.lock", "yarn"],
    ["bun.lock", "bun"],
    ["bun.lockb", "bun"],
    ["package-lock.json", "npm"],
  ] as const) {
    try {
      await readFile(join(repositoryPath, lockfile));
      return packageManager;
    } catch {
      // Try the next conventional lockfile.
    }
  }
  return "npm";
}

function packageExecutableCommand(
  packageManager: string,
  executable: string,
  args: string[],
): Command {
  switch (packageManager) {
    case "pnpm":
    case "yarn":
      return ["corepack", packageManager, "exec", executable, ...args];
    case "bun":
      return ["bunx", "--no-install", executable, ...args];
    default:
      return ["npx", "--no-install", executable, ...args];
  }
}

export function displayPreparationDirectory(
  repositoryPath: string,
  directory: string,
): string {
  const path = relative(repositoryPath, directory);
  return path ? path : basename(repositoryPath);
}

function stringRecord(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function minimumMajorMinor(
  version: string,
  minimumMajor: number,
  minimumMinor: number,
): boolean {
  const match = version.match(/(?:^|[^0-9])(\d+)\.(\d+)/);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return (
    major > minimumMajor || (major === minimumMajor && minor >= minimumMinor)
  );
}
