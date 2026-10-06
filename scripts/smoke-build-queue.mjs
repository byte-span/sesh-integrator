// Run after build. Uses only disposable machine-local queue state.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runQueued } from "../dist/queued-process.js";
import { queueEntries, queueCommand } from "../dist/build-queue.js";

const root = await mkdtemp(join(tmpdir(), "sesh-queue-smoke-"));
process.env.SESH_BUILD_QUEUE_HOME = root;
try {
  await queueCommand(["configure", "--concurrency", "2"]);
  const events = join(root, "events.jsonl");
  await Promise.all(
    Array.from({ length: 4 }, (_, id) =>
      runQueued(
        process.execPath,
        [
          "-e",
          `const f=require('fs'),p=${JSON.stringify(events)};f.appendFileSync(p,JSON.stringify({id:${id},kind:'start'})+'\\n');setTimeout(()=>f.appendFileSync(p,JSON.stringify({id:${id},kind:'end'})+'\\n'),250)`,
        ],
        root,
        "native concurrency",
        `session-${id}`,
      ),
    ),
  );
  let running = 0,
    peak = 0;
  for (const line of (await readFile(events, "utf8")).trim().split("\n")) {
    running += JSON.parse(line).kind === "start" ? 1 : -1;
    peak = Math.max(peak, running);
  }
  assert.equal(peak, 2);
  assert.equal(running, 0);
  assert.deepEqual(await queueEntries(), []);
  const ready = join(root, "ready");
  const parent = join(root, "parent.cjs");
  // Cooperative POSIX parent reaps its child; Windows taskkill terminates both.
  await writeFile(
    parent,
    `const {spawn}=require('child_process');const child=spawn(process.execPath,['-e',${JSON.stringify(`require('fs').writeFileSync(${JSON.stringify(ready)},'ready');setTimeout(()=>{},20000)`)}],{stdio:'inherit'});process.on('SIGTERM',()=>{child.once('exit',()=>process.exit(0));});`,
  );
  const cancelled = runQueued(
    process.execPath,
    [parent],
    root,
    "native cancellation",
  );
  void cancelled.catch(() => undefined);
  const deadline = Date.now() + 10000;
  for (;;) {
    try {
      await readFile(ready);
      break;
    } catch {
      if (Date.now() >= deadline)
        throw Error("Timed out starting cancellation fixture");
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  // Exercise the installed handler without relying on shell signal delivery.
  process.emit("SIGTERM");
  await assert.rejects(cancelled, /cancelled/);
  assert.deepEqual(await queueEntries(), []);
  console.log(
    JSON.stringify({
      platform: process.platform,
      node: process.version,
      peakConcurrent: peak,
      cancellation: "tree stopped and slot released",
      failures: 0,
    }),
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
