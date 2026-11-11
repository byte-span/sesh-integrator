import { stripVTControlCharacters } from "node:util";
import { run } from "./process.js";
import { matchesPath, validationCommandValue } from "./validation.js";
import type { Command, RepositoryConfig, ValidationStep } from "./types.js";

/**
 * Files whose change can alter what validation runs, flagged on adopted
 * branches (`adopt.validationFiles`). The flag never stops an adoption: it
 * tells whoever relies on the result that checks written elsewhere, such as
 * in a cloud sandbox, may have changed the checks themselves. Canonical
 * description: docs/commands.md#adopt.
 *
 * Built-in patterns use the validation tier `paths` syntax: package manifests
 * and lockfiles, workspace files, test/build/lint/typecheck configuration,
 * Claude settings, CI workflows and toolchain pins.
 */
export const BUILT_IN_VALIDATION_FILE_PATHS: readonly string[] = [
  // JavaScript and TypeScript packages, workspaces and package managers.
  ...[
    "package.json",
    "package-lock.json",
    "npm-shrinkwrap.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    ".pnpmfile.cjs",
    "yarn.lock",
    ".yarnrc",
    ".yarnrc.yml",
    ".npmrc",
    "bun.lock",
    "bun.lockb",
    "bunfig.toml",
    "deno.json",
    "deno.jsonc",
    "deno.lock",
    "lerna.json",
    "nx.json",
    "turbo.json",
    "rush.json",
    // Test, build, lint, format and typecheck configuration.
    "tsconfig*.json",
    "jsconfig*.json",
    "vitest.config.*",
    "vitest.workspace.*",
    "vite.config.*",
    "jest.config.*",
    "playwright.config.*",
    "cypress.config.*",
    "karma.conf.*",
    ".mocharc*",
    "ava.config.*",
    ".c8rc*",
    ".nycrc*",
    "babel.config.*",
    ".babelrc*",
    ".swcrc",
    "webpack.config.*",
    "rollup.config.*",
    "esbuild.config.*",
    "tsup.config.*",
    "eslint.config.*",
    ".eslintrc*",
    ".eslintignore",
    "prettier.config.*",
    ".prettierrc*",
    ".prettierignore",
    "biome.json",
    "biome.jsonc",
    "stylelint.config.*",
    ".stylelintrc*",
    ".editorconfig",
    // Python.
    "pyproject.toml",
    "poetry.lock",
    "uv.lock",
    "Pipfile",
    "Pipfile.lock",
    "requirements*.txt",
    "setup.py",
    "setup.cfg",
    "tox.ini",
    "noxfile.py",
    "pytest.ini",
    "conftest.py",
    "mypy.ini",
    ".mypy.ini",
    "ruff.toml",
    ".ruff.toml",
    ".flake8",
    ".pylintrc",
    "pylintrc",
    ".coveragerc",
    // Rust.
    "Cargo.toml",
    "Cargo.lock",
    "build.rs",
    ".cargo/config",
    ".cargo/config.toml",
    "clippy.toml",
    ".clippy.toml",
    "rustfmt.toml",
    ".rustfmt.toml",
    // Go.
    "go.mod",
    "go.sum",
    "go.work",
    "go.work.sum",
    ".golangci.*",
    // Ruby, PHP and Elixir.
    "Gemfile",
    "Gemfile.lock",
    "*.gemspec",
    "Rakefile",
    ".rubocop.yml",
    ".rspec",
    "composer.json",
    "composer.lock",
    "phpunit.xml",
    "phpunit.xml.dist",
    "phpstan.neon",
    "phpstan.neon.dist",
    "mix.exs",
    "mix.lock",
    ".formatter.exs",
    ".credo.exs",
    // JVM, .NET, Swift, Dart and Nix.
    "pom.xml",
    "mvnw",
    ".mvn/**",
    "build.gradle",
    "build.gradle.kts",
    "settings.gradle",
    "settings.gradle.kts",
    "gradle.properties",
    "gradlew",
    "gradlew.bat",
    "gradle/wrapper/**",
    "gradle/*.versions.toml",
    "build.sbt",
    "*.csproj",
    "*.fsproj",
    "*.vbproj",
    "*.sln",
    "Directory.Build.props",
    "Directory.Build.targets",
    "Directory.Packages.props",
    "global.json",
    "NuGet.config",
    "nuget.config",
    "packages.lock.json",
    "Package.swift",
    "Package.resolved",
    "pubspec.yaml",
    "pubspec.lock",
    "flake.nix",
    "flake.lock",
    "shell.nix",
    "default.nix",
    "devbox.json",
    // Build files and task runners.
    "Makefile",
    "makefile",
    "GNUmakefile",
    "*.mk",
    "justfile",
    "Justfile",
    ".justfile",
    "Taskfile.yml",
    "Taskfile.yaml",
    "CMakeLists.txt",
    "*.cmake",
    "meson.build",
    "BUILD",
    "BUILD.bazel",
    "WORKSPACE",
    "WORKSPACE.bazel",
    "MODULE.bazel",
    ".bazelrc",
    // Commit-time and lint hooks.
    ".husky/**",
    "lefthook.yml",
    ".lefthook.yml",
    ".pre-commit-config.yaml",
    // Claude Code settings, which define hooks and permissions.
    ".claude/settings*.json",
    // Toolchain pins.
    ".node-version",
    ".nvmrc",
    ".tool-versions",
    "mise.toml",
    ".mise.toml",
    ".prototools",
    ".python-version",
    ".ruby-version",
    ".go-version",
    ".java-version",
    ".sdkmanrc",
    "rust-toolchain",
    "rust-toolchain.toml",
    ".bazelversion",
  ].map((pattern) => `**/${pattern}`),
  // CI workflows, at the repository root only.
  ".github/workflows/**",
  ".github/actions/**",
  ".gitlab-ci.yml",
  ".gitlab/ci/**",
  ".circleci/**",
  ".buildkite/**",
  ".azure-pipelines/**",
  "azure-pipelines.yml",
  "bitbucket-pipelines.yml",
  "Jenkinsfile",
  ".travis.yml",
  ".drone.yml",
  ".woodpecker.yml",
  ".woodpecker/**",
  "appveyor.yml",
  ".appveyor.yml",
];

/**
 * The paths among `changed` that can alter validation, sorted and
 * deduplicated: built-in patterns, the registration's `validationFilePaths`,
 * and files named by its setup, source and integration validation commands,
 * including the root package scripts those commands run (`scripts`).
 */
export function validationFiles(
  changed: string[],
  repository: Pick<
    RepositoryConfig,
    | "setupCommands"
    | "sourceValidationCommands"
    | "integrationValidationCommands"
    | "validationFilePaths"
  >,
  scripts: Record<string, string> = {},
): string[] {
  const patterns = [
    ...BUILT_IN_VALIDATION_FILE_PATHS,
    ...(repository.validationFilePaths ?? []),
  ];
  const referenced = commandReferences(repository, scripts);
  return [...new Set(changed)]
    .filter(
      (path) =>
        referenced.has(path) ||
        patterns.some((pattern) => matchesPath(pattern, path)),
    )
    .sort();
}

/** `validationFiles` for the net diff from `baseCommit` to `headSha`. */
export async function adoptedValidationFiles(
  cwd: string,
  repository: RepositoryConfig,
  baseCommit: string,
  headSha: string,
): Promise<string[]> {
  const diff = await run(
    "git",
    ["diff", "--name-only", "--no-renames", "-z", baseCommit, headSha],
    { cwd },
  );
  if (diff.code !== 0)
    throw new Error(
      `Could not list the adopted changes ${baseCommit}..${headSha}: ${(diff.stderr || diff.stdout).trim()}`,
    );
  const changed = diff.stdout.split("\0").filter(Boolean);
  return validationFiles(
    changed,
    repository,
    await packageScripts(cwd, headSha),
  );
}

/** One line for people: `none`, or the count and the first few paths. */
export function describeValidationFiles(files: string[], limit = 10): string {
  if (!files.length) return "none";
  const shown = files
    .slice(0, limit)
    .map((path) => stripVTControlCharacters(path).replace(/[^\x20-\x7e]/g, "?"))
    .join(", ");
  const more = files.length > limit ? `, and ${files.length - limit} more` : "";
  return `${files.length} (${shown}${more})`;
}

/** Root `package.json` scripts at `commit`; empty when absent or unreadable. */
async function packageScripts(
  cwd: string,
  commit: string,
): Promise<Record<string, string>> {
  const shown = await run("git", ["show", `${commit}:package.json`], { cwd });
  if (shown.code !== 0) return {};
  try {
    const scripts = (JSON.parse(shown.stdout) as { scripts?: unknown }).scripts;
    if (!scripts || typeof scripts !== "object" || Array.isArray(scripts))
      return {};
    return Object.fromEntries(
      Object.entries(scripts).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    );
  } catch {
    return {};
  }
}

const PACKAGE_MANAGERS = new Set(["npm", "pnpm", "yarn", "bun"]);
/** Package manager commands that run the root install lifecycle scripts. */
const INSTALLS = new Set(["install", "i", "ci", "add"]);

/**
 * Repository-relative files named by the configured commands and by the
 * package scripts they run (with their pre/post scripts), one level of shell
 * text deep. Globs, directories, flags and absolute paths are not followed.
 */
function commandReferences(
  repository: Parameters<typeof validationFiles>[1],
  scripts: Record<string, string>,
): Set<string> {
  const steps: ValidationStep[] = [
    ...repository.sourceValidationCommands,
    ...repository.integrationValidationCommands,
  ];
  const commands: Command[] = [
    ...repository.setupCommands,
    ...steps
      .flatMap((step) =>
        Array.isArray(step) || "command" in step ? [step] : step.parallel,
      )
      .map(validationCommandValue),
  ];
  const references = new Set<string>();
  const pending: string[] = [];
  const visit = (words: string[]) => {
    for (const word of words) {
      const path = pathReference(word);
      if (path) references.add(path);
    }
    const name = scriptName(words);
    if (name)
      pending.push(...(INSTALLS.has(name) ? ["install", "prepare"] : [name]));
  };
  for (const command of commands) {
    visit(command);
    // Shell text such as `bash -c "..."` names files too.
    for (const argument of command)
      if (/\s/.test(argument)) shellCommands(argument).forEach(visit);
  }
  const seen = new Set<string>();
  while (pending.length) {
    const name = pending.pop()!;
    for (const script of [name, `pre${name}`, `post${name}`]) {
      if (seen.has(script) || !Object.hasOwn(scripts, script)) continue;
      seen.add(script);
      shellCommands(scripts[script]!).forEach(visit);
    }
  }
  return references;
}

/** Simple commands in shell text, as words with quotes removed. */
function shellCommands(text: string): string[][] {
  return text
    .split(/&&|\|\||[;&|()\n]/)
    .map((part) => part.replace(/["'`]/g, "").split(/\s+/).filter(Boolean))
    .filter((words) => words.length > 0);
}

/** The package script a command runs, such as `pnpm run test` or `npm test`. */
function scriptName(words: string[]): string | undefined {
  const start = words.findIndex((word) =>
    PACKAGE_MANAGERS.has(word.replaceAll("\\", "/").split("/").at(-1)!),
  );
  if (start < 0) return undefined;
  const rest = words.slice(start + 1).filter((word) => !word.startsWith("-"));
  return rest[0] === "run" || rest[0] === "run-script" ? rest[1] : rest[0];
}

/** A repository-relative file a command word names, normalized, if any. */
function pathReference(word: string): string | undefined {
  // `--config=vitest.ci.config.ts` and `NAME=value` name their value.
  const value = (
    word.startsWith("-") || /^[A-Za-z_]\w*=/.test(word)
      ? word.slice(word.indexOf("=") + 1)
      : word
  ).replaceAll("\\", "/");
  if (
    !value ||
    value.startsWith("-") ||
    !/[./]/.test(value) ||
    value.startsWith("/") ||
    /^[A-Za-z]:/.test(value) ||
    value.endsWith("/") ||
    value.includes("://") ||
    /[*?[\]{}$~<>]/.test(value)
  )
    return undefined;
  const parts = value.split("/").filter((part) => part && part !== ".");
  if (!parts.length || parts.some((part) => /^\.\.+$/.test(part)))
    return undefined;
  return parts.join("/");
}
