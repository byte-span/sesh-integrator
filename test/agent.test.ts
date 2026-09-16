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
