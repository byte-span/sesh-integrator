import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach } from "vitest";

let root: string;
let previous: string | undefined;
beforeEach(async () => {
  previous = process.env.SESH_BUILD_QUEUE_HOME;
  root = await mkdtemp(join(tmpdir(), "sesh-test-queue-"));
  process.env.SESH_BUILD_QUEUE_HOME = root;
  // Legacy overlap tests explicitly expect at least two simultaneous commands.
  await writeFile(
    join(root, "config.json"),
    JSON.stringify({ concurrency: 2, waitSeconds: 30 }),
  );
});
afterEach(async () => {
  if (previous === undefined) delete process.env.SESH_BUILD_QUEUE_HOME;
  else process.env.SESH_BUILD_QUEUE_HOME = previous;
  await rm(root, { recursive: true, force: true });
});
