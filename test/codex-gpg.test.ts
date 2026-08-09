import { execFile } from "node:child_process";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readlink,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const roots: string[] = [];
const wrapper = join(process.cwd(), "scripts", "codex-gpg");

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((path) => rm(path, { recursive: true })),
  );
});

describe("codex-gpg wrapper", () => {
  it("requests launchd recovery and connects only to the canonical socket", async () => {
    const fixture = await createFixture();
    const result = await execFileAsync(wrapper, ["--version"], {
      env: fixture.env,
    });

    expect(result.stdout).toContain("fake-gpg --version");
    expect(await readlink(join(fixture.bridge, "S.gpg-agent"))).toBe(
      join(fixture.canonical, "S.gpg-agent"),
    );
    expect((await lstat(fixture.launchState)).isFile()).toBe(true);
  });

  it("fails precisely when launchd cannot recover the agent", async () => {
    const fixture = await createFixture(false);
    await expect(
      execFileAsync(wrapper, ["--version"], { env: fixture.env }),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining(
        "canonical gpg-agent is unreachable and launchd recovery failed",
      ),
    });
  });

  it("refuses a bridge containing private-key material", async () => {
    const fixture = await createFixture();
    const privateDirectory = join(fixture.bridge, "private-keys-v1.d");
    await mkdir(privateDirectory);
    await writeFile(join(privateDirectory, "keygrip"), "must-not-exist\n");

    await expect(
      execFileAsync(wrapper, ["--version"], { env: fixture.env }),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("private-key material exists"),
    });
  });
});

async function createFixture(launchSucceeds = true): Promise<{
  canonical: string;
  bridge: string;
  launchState: string;
  env: NodeJS.ProcessEnv;
}> {
  const root = await mkdtemp(join(tmpdir(), "codex-gpg-test-"));
  roots.push(root);
  const canonical = join(root, "gnupg");
  const bridge = join(root, "bridge");
  const bin = join(root, "bin");
  const launchState = join(root, "agent-healthy");
  await Promise.all([mkdir(canonical), mkdir(bridge), mkdir(bin)]);
  const fakeGpg = join(bin, "gpg");
  const fakeConnect = join(bin, "gpg-connect-agent");
  const fakeLaunchctl = join(bin, "launchctl");
  await writeFile(fakeGpg, "#!/bin/sh\nprintf 'fake-gpg %s\\n' \"$*\"\n");
  await writeFile(
    fakeConnect,
    `#!/bin/sh\n[ -f "${launchState}" ] || exit 1\nprintf 'D 123\\nOK\\n'\n`,
  );
  await writeFile(
    fakeLaunchctl,
    launchSucceeds
      ? `#!/bin/sh\ntouch "${launchState}"\n`
      : "#!/bin/sh\nexit 1\n",
  );
  await Promise.all(
    [fakeGpg, fakeConnect, fakeLaunchctl].map((path) => chmod(path, 0o755)),
  );
  return {
    canonical,
    bridge,
    launchState,
    env: {
      ...process.env,
      CODEX_GPG_CANONICAL_HOME: canonical,
      CODEX_GPG_BRIDGE_HOME: bridge,
      CODEX_GPG_BIN: fakeGpg,
      CODEX_GPG_CONNECT_BIN: fakeConnect,
      CODEX_GPG_LAUNCHCTL_BIN: fakeLaunchctl,
    },
  };
}
