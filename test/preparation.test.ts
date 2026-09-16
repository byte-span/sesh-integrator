import { chmod, mkdtemp, mkdir, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { detectValidationPreparation } from "../src/preparation.js";
import { runValidation } from "../src/process.js";

describe("validation preparation inference", () => {
  it("detects safe disposable framework generators across a monorepo", async () => {
    const repository = await mkdtemp(join(tmpdir(), "handoff-prepare-"));
    await writeJson(join(repository, "package.json"), {
      private: true,
      packageManager: "pnpm@10.14.0",
    });
    await writeFile(
      join(repository, "pnpm-lock.yaml"),
      "lockfileVersion: '9.0'\n",
    );
    await writePackage(repository, "apps/next", { next: "^16.0.0" });
    await writePackage(repository, "apps/svelte", {
      "@sveltejs/kit": "^2.0.0",
    });
    await writePackage(repository, "apps/nuxt", { nuxt: "^4.0.0" });
    await writePackage(repository, "apps/astro", { astro: "^5.0.0" });
    await writePackage(repository, "apps/router", {
      "@react-router/dev": "^7.0.0",
    });

    const canonicalRepository = await realpath(repository);
    const preparations = await detectValidationPreparation(repository);

    expect(
      preparations.map(({ environment, cwd, command }) => ({
        environment,
        cwd: relative(canonicalRepository, cwd),
        command,
      })),
    ).toEqual([
      {
        environment: "Astro",
        cwd: "apps/astro",
        command: ["corepack", "pnpm", "exec", "astro", "sync"],
      },
      {
        environment: "Next.js",
        cwd: "apps/next",
        command: ["corepack", "pnpm", "exec", "next", "typegen"],
      },
      {
        environment: "Nuxt",
        cwd: "apps/nuxt",
        command: ["corepack", "pnpm", "exec", "nuxt", "prepare"],
      },
      {
        environment: "React Router",
        cwd: "apps/router",
        command: ["corepack", "pnpm", "exec", "react-router", "typegen"],
      },
      {
        environment: "SvelteKit",
        cwd: "apps/svelte",
        command: ["corepack", "pnpm", "exec", "svelte-kit", "sync"],
      },
    ]);
  });

  it("does not duplicate preparation already included in a script", async () => {
    const repository = await mkdtemp(join(tmpdir(), "handoff-prepare-"));
    await writeJson(join(repository, "package.json"), {
      packageManager: "npm@11.0.0",
      dependencies: { next: "16.1.0" },
      scripts: { typecheck: "next typegen && tsc --noEmit" },
    });
    await writeFile(join(repository, "package-lock.json"), "{}\n");

    expect(await detectValidationPreparation(repository)).toEqual([]);
  });

  it("skips Next.js versions that do not provide next typegen", async () => {
    const repository = await mkdtemp(join(tmpdir(), "handoff-prepare-"));
    await writeJson(join(repository, "package.json"), {
      dependencies: { next: "^14.2.0" },
    });

    expect(await detectValidationPreparation(repository)).toEqual([]);
  });

  it("runs inferred preparation before validation", async () => {
    const repository = await mkdtemp(join(tmpdir(), "handoff-prepare-"));
    await writeJson(join(repository, "package.json"), {
      packageManager: "npm@11.0.0",
      dependencies: { next: "16.1.0" },
    });
    await writeFile(join(repository, "package-lock.json"), "{}\n");
    const binDirectory = join(repository, "node_modules/.bin");
    await mkdir(binDirectory, { recursive: true });
    const next = join(binDirectory, "next");
    await writeFile(
      next,
      "#!/usr/bin/env node\nrequire('node:fs').writeFileSync('next-env.d.ts', 'generated\\n')\n",
    );
    await chmod(next, 0o755);
    await writeFile(
      join(repository, "check.mjs"),
      "import { access } from 'node:fs/promises'; await access('next-env.d.ts');\n",
    );

    const result = await runValidation(
      [[process.execPath, "check.mjs"]],
      repository,
    );

    expect(result).toEqual({ cacheHits: 0, executed: 1 });
  });
});

async function writePackage(
  repository: string,
  path: string,
  devDependencies: Record<string, string>,
): Promise<void> {
  const directory = join(repository, path);
  await mkdir(directory, { recursive: true });
  await writeJson(join(directory, "package.json"), { devDependencies });
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}
