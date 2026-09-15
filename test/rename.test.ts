import { execFileSync } from "node:child_process";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { resolveRuntimeRoot } from "../src/runtime.js";

it("installs seshx and both compatibility commands against the same CLI", async () => {
  const root = await mkdtemp(join(tmpdir(), "seshx-install-"));
  try {
    const project = join(root, "project");
    const scripts = join(project, "scripts");
    const bin = join(root, "bin");
    await mkdir(scripts, { recursive: true });
    await cp(join(process.cwd(), "dist"), join(project, "dist"), {
      recursive: true,
    });
    await cp(
      join(process.cwd(), "harnesses.json"),
      join(project, "harnesses.json"),
    );
    await cp(
      join(process.cwd(), "package.json"),
      join(project, "package.json"),
    );
    await cp(
      join(process.cwd(), "scripts/install-cli.sh"),
      join(scripts, "install-cli.sh"),
    );
    // Keep this installer test isolated from host hooks, guidance, and systemd.
    await writeFile(
      join(scripts, "install-machine-safeguards.sh"),
      "#!/bin/sh\nexit 0\n",
      { mode: 0o755 },
    );
    const env = { ...process.env, PARALLEL_INTEGRATOR_BIN_DIR: bin };
    for (let attempt = 0; attempt < 2; attempt++) {
      expect(
        execFileSync("sh", [join(scripts, "install-cli.sh")], {
          env,
          encoding: "utf8",
        }),
      ).toContain("Installed seshx");
    }
    const manifest = JSON.parse(
      await readFile(join(project, "package.json"), "utf8"),
    );
    for (const name of [
      "seshx",
      "sesh-integrator",
      "pintx",
      "parallel-integrator",
      "codex-handoff",
    ]) {
      expect(manifest.bin[name]).toBe("dist/cli.js");
      expect(await realpath(join(bin, name))).toBe(
        await realpath(join(project, "dist/cli.js")),
      );
      const help = execFileSync(join(bin, name), ["--help"], {
        encoding: "utf8",
      });
      expect(help).toContain("seshx - one-shot Git integration");
      expect(help).toContain("seshx begin");
      expect(help).toContain(
        "Compatibility commands: sesh-integrator, pintx, parallel-integrator, codex-handoff",
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("keeps existing sessions and locks in the original runtime after the rename", async () => {
  const home = await mkdtemp(join(tmpdir(), "sesh-integrator-rename-"));
  try {
    expect(resolveRuntimeRoot({}, home)).toBe(join(home, ".sesh-integrator"));
    await mkdir(join(home, ".parallel-integrator"));
    expect(resolveRuntimeRoot({}, home)).toBe(
      join(home, ".parallel-integrator"),
    );
    expect(
      resolveRuntimeRoot(
        { SESH_INTEGRATOR_HOME: "/new", PARALLEL_INTEGRATOR_HOME: "/old" },
        home,
      ),
    ).toBe("/new");
    await mkdir(join(home, ".codex-handoff"));
    expect(resolveRuntimeRoot({}, home)).toBe(join(home, ".codex-handoff"));
    await mkdir(join(home, ".sesh-integrator"));
    expect(resolveRuntimeRoot({}, home)).toBe(join(home, ".codex-handoff"));
    expect(resolveRuntimeRoot({ CODEX_HANDOFF_HOME: "/legacy" }, home)).toBe(
      "/legacy",
    );
    expect(
      resolveRuntimeRoot(
        {
          CODEX_HANDOFF_HOME: "/legacy",
          PARALLEL_INTEGRATOR_HOME: "/explicit",
        },
        home,
      ),
    ).toBe("/explicit");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
