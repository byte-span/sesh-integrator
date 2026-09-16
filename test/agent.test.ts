import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it } from "vitest";
import { runAgent } from "../src/agent.js";
import { harnesses, validateHarnessConfig } from "../src/harness.js";
import { defaultConfig } from "../src/runtime.js";

const roots: string[] = [];
afterEach(async () => {
  delete process.env.PARALLEL_INTEGRATOR_HOME;
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

it.each(harnesses)(
  "%s supports both agent purposes and rejects failed responses",
  async (harness) => {
    const root = await mkdtemp(join(tmpdir(), "sesh-agent-"));
    roots.push(root);
    process.env.PARALLEL_INTEGRATOR_HOME = root;
    const fake = join(root, "fake-agent");
    const record = join(root, "request.json");
    const response = join(root, "response.json");
    await writeFile(response, JSON.stringify({ ok: true }));
    await writeFile(
      fake,
      `#!/usr/bin/env node
const fs=require('fs');
const args=process.argv.slice(2);
const get=(name)=>args[args.indexOf(name)+1];
const prompt=args.includes('--prompt-file') ? fs.readFileSync(get('--prompt-file'),'utf8') : fs.readFileSync(0,'utf8');
fs.writeFileSync(${JSON.stringify(record)},JSON.stringify({args,prompt,policy:args.includes('--policy')?fs.readFileSync(get('--policy'),'utf8'):null}));
const value=JSON.parse(fs.readFileSync(${JSON.stringify(response)},'utf8'));
if(value.exit) process.exit(value.exit);
if(args.includes('--output-last-message')) fs.writeFileSync(get('--output-last-message'),JSON.stringify(value));
else process.stdout.write(JSON.stringify(value));
`,
      { mode: 0o755 },
    );
    const config = {
      ...defaultConfig(),
      harnessCommands: { [harness]: fake },
      codexCommand: join(root, "wrong-agent"),
    };
    const base = {
      config,
      harness,
      cwd: root,
      prompt: "Inspect supplied evidence. Do not commit.",
    };
    await runAgent({ ...base, purpose: "resolve" });
    const resolution = JSON.parse(await readFile(record, "utf8"));
    expect(resolution.prompt).toContain(base.prompt);
    expect(resolution.args.join(" ")).not.toMatch(
      /yolo|skip-permissions|bypassPermissions/,
    );
    if (harness === "gemini")
      expect(resolution.policy).not.toContain("run_shell_command");
    const diagnosis = { category: "test" };
    const envelope =
      harness === "codex"
        ? diagnosis
        : harness === "claude"
          ? { structured_output: diagnosis }
          : harness === "gemini"
            ? { response: JSON.stringify(diagnosis) }
            : { text: JSON.stringify(diagnosis) };
    await writeFile(response, JSON.stringify(envelope));
    expect(
      await runAgent({
        ...base,
        purpose: "diagnose",
        schema: { type: "object" },
      }),
    ).toEqual(diagnosis);
    const request = JSON.parse(await readFile(record, "utf8"));
    expect(request.prompt).toContain('"type":"object"');
    if (harness === "gemini") {
      expect(request.policy).toContain('decision = "deny"');
      expect(request.policy).not.toContain('"write_file"');
      expect(request.policy).not.toContain("commandPrefix");
    } else if (harness === "claude") {
      expect(request.args[request.args.indexOf("--tools") + 1]).toBe(
        "Read,Glob,Grep",
      );
    } else expect(request.args).toContain("read-only");
    await writeFile(response, JSON.stringify({ exit: 9 }));
    await expect(runAgent({ ...base, purpose: "resolve" })).rejects.toThrow(
      "exited 9",
    );
    if (harness !== "codex") {
      await writeFile(response, JSON.stringify({ is_error: true }));
      await expect(
        runAgent({ ...base, purpose: "diagnose", schema: {} }),
      ).rejects.toThrow("unsuccessful");
      await writeFile(
        response,
        JSON.stringify({
          response: "invalid",
          text: "invalid",
          result: "invalid",
        }),
      );
      await expect(
        runAgent({ ...base, purpose: "diagnose", schema: {} }),
      ).rejects.toThrow();
    }
  },
);

it("validates shared configuration and the legacy resolver alias", () => {
  for (const mode of [
    "current-session",
    "nested-agent",
    "nested-codex",
  ] as const)
    expect(() =>
      validateHarnessConfig({
        ...defaultConfig(),
        conflictResolutionMode: mode,
      }),
    ).not.toThrow();
  expect(() =>
    validateHarnessConfig({
      ...defaultConfig(),
      harnessCommands: { claude: "" },
    }),
  ).toThrow();
  expect(() =>
    validateHarnessConfig({
      ...defaultConfig(),
      harnessCommands: { unknown: "agent" },
    } as never),
  ).toThrow();
});

it("records failed provider usage and enables Codex JSON only for tracked calls", async () => {
  const { readUsageRecords } = await import("../src/usage.js");
  const root = await mkdtemp(join(tmpdir(), "sesh-agent-usage-"));
  roots.push(root);
  process.env.PARALLEL_INTEGRATOR_HOME = root;
  const previousDirectory = process.env.SESH_SMOKE_USAGE_DIR;
  const previousRun = process.env.SESH_SMOKE_USAGE_RUN_ID;
  process.env.SESH_SMOKE_USAGE_DIR = join(root, "usage");
  process.env.SESH_SMOKE_USAGE_RUN_ID = "test-run";
  const fake = join(root, "fake-agent");
  const request = join(root, "args.json");
  await writeFile(
    fake,
    `#!/usr/bin/env node
const fs = require('fs');
fs.readFileSync(0, 'utf8');
fs.writeFileSync(${JSON.stringify(request)}, JSON.stringify(process.argv.slice(2)));
console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 5, output_tokens: 2 } }));
process.exitCode = 9;
`,
    { mode: 0o755 },
  );
  const options = {
    config: { ...defaultConfig(), harnessCommands: { codex: fake } },
    harness: "codex" as const,
    purpose: "resolve" as const,
    cwd: root,
    prompt: "private prompt",
  };
  try {
    await expect(runAgent(options)).rejects.toThrow("exited 9");
    expect(JSON.parse(await readFile(request, "utf8"))).toEqual(
      expect.arrayContaining(["--json", "--sandbox", "workspace-write"]),
    );
    const history = await readUsageRecords(join(root, "usage"));
    expect(history.records).toHaveLength(1);
    expect(history.records[0]).toMatchObject({
      outcome: "failed",
      rows: [{ total: 12, coverage: "partial" }],
    });
    delete process.env.SESH_SMOKE_USAGE_RUN_ID;
    await expect(runAgent(options)).rejects.toThrow("exited 9");
    expect(JSON.parse(await readFile(request, "utf8"))).not.toContain("--json");
    expect((await readUsageRecords(join(root, "usage"))).records).toHaveLength(
      1,
    );
  } finally {
    if (previousDirectory === undefined)
      delete process.env.SESH_SMOKE_USAGE_DIR;
    else process.env.SESH_SMOKE_USAGE_DIR = previousDirectory;
    if (previousRun === undefined) delete process.env.SESH_SMOKE_USAGE_RUN_ID;
    else process.env.SESH_SMOKE_USAGE_RUN_ID = previousRun;
  }
});
