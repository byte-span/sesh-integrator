import { join } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { registerSmoke, smokeFixture } from "./smoke-fixture.js";

it("installs the packed release and completes an isolated CLI workflow", async () => {
  const bootstrap = await smokeFixture();
  let installed: Awaited<ReturnType<typeof smokeFixture>> | undefined;
  try {
    const pack = await bootstrap.command(
      "npm",
      [
        "pack",
        "--ignore-scripts",
        "--json",
        "--pack-destination",
        bootstrap.root,
      ],
      process.cwd(),
    );
    expect(pack.code, pack.stderr).toBe(0);
    const archive = join(bootstrap.root, JSON.parse(pack.stdout)[0].filename);
    const prefix = join(bootstrap.root, "installed");
    const install = await bootstrap.command("npm", [
      "install",
      "--global",
      "--prefix",
      prefix,
      "--offline",
      "--no-audit",
      "--no-fund",
      archive,
    ]);
    expect(install.code, install.stderr).toBe(0);
    installed = await smokeFixture(join(prefix, "bin/seshx"));
    const f = installed;
    expect((await f.run(f.repo, ["--help"])).stdout).toContain("seshx");
    await f.run(f.repo, ["setup", "--harness", "codex", "--yes"]);
    await registerSmoke(f);
    const fake = join(f.root, "codex-version");
    await writeFile(fake, '#!/bin/sh\necho "smoke harness 1.0"\n', {
      mode: 0o755,
    });
    await f.configure((c) => {
      c.codexCommand = fake;
    });
    expect(
      (await f.run(f.repo, ["doctor", "--harness", "codex"])).stdout,
    ).toContain("READY");
    // Dirty launch state must survive and never enter the isolated task commit.
    await writeFile(join(f.repo, "unrelated.txt"), "user edits\n");
    await mkdir(join(f.repo, "personal"));
    await writeFile(join(f.repo, "personal/note.txt"), "untracked\n");
    const session = await f.begin();
    expect(
      await readFile(join(session.worktreePath, "unrelated.txt"), "utf8"),
    ).toBe("preserve me\n");
    await f.commit(session.worktreePath, '{"alpha":true,"beta":false}\n');
    const ready = await f.git(session.worktreePath, "rev-parse", "HEAD");
    await f.run(
      session.worktreePath,
      ["integrate", "--summary", "package smoke", "--rollout", "none"],
      1,
    );
    expect((await f.sessions())[0]!.status).toBe("promotion_pending");
    expect(await readFile(join(f.repo, "unrelated.txt"), "utf8")).toBe(
      "user edits\n",
    );
    // The fixture owner commits its own edits, then retries the preserved session.
    await f.git(f.repo, "add", "unrelated.txt", "personal/note.txt");
    await f.git(f.repo, "commit", "-m", "save user edits");
    await f.run(session.worktreePath, ["resume"]);
    const done = (await f.sessions())[0]!;
    expect(done.status).toBe("succeeded");
    expect(await f.git(f.repo, "rev-parse", "main")).toBe(done.promotedCommit);
    await f.git(f.repo, "merge-base", "--is-ancestor", ready, "main");
    expect(
      JSON.parse(await readFile(join(f.repo, "features.json"), "utf8")),
    ).toEqual({ alpha: true, beta: false });
    expect(await readFile(join(f.repo, "unrelated.txt"), "utf8")).toBe(
      "user edits\n",
    );
    expect(await readFile(join(f.repo, "personal/note.txt"), "utf8")).toBe(
      "untracked\n",
    );
    expect(await f.git(session.worktreePath, "status", "--porcelain")).toBe("");
  } finally {
    await installed?.dispose();
    await bootstrap.dispose();
  }
}, 120_000);
