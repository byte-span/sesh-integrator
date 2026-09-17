import { mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it } from "vitest";
// @ts-expect-error JavaScript command runner is exercised directly.
import {
  selection,
  classifyFailure,
  executable,
  invocation,
  execute,
  ping,
  runSelected,
  validResponse,
} from "../smoke/ping.mjs";
const roots: string[] = [];
async function fixture(body: string) {
  const root = await mkdtemp(join(tmpdir(), "ping-test-"));
  roots.push(root);
  const command = join(root, "fake");
  await writeFile(command, `#!${process.execPath}\n${body}`, { mode: 0o755 });
  return { root, command };
}
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
it("requires explicit selection, rejects duplicates and mixed selection", () => {
  expect(
    selection(["--harness", "claude,gemini", "--harness", "grok"]),
  ).toEqual({ harnesses: ["claude", "gemini", "grok"] });
  expect(selection(["--installed"])).toEqual({ installed: true });
  expect(selection(["--help"])).toEqual({ help: true });
  for (const args of [
    [],
    ["--harness", "bad"],
    ["--harness", "claude,claude"],
    ["--installed", "--harness", "claude"],
    ["--harness", "claude,"],
  ])
    expect(() => selection(args)).toThrow();
});
const responses = {
  codex:
    '{"type":"item.completed","item":{"type":"agent_message","text":"OK"}}\n{"type":"turn.completed","usage":{"input_tokens":5,"output_tokens":1,"cached_input_tokens":0}}',
  claude: JSON.stringify({
    result: "OK",
    usage: {
      input_tokens: 5,
      output_tokens: 1,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
  }),
  gemini: JSON.stringify({
    response: "OK",
    stats: {
      models: {
        test: {
          tokens: {
            prompt: 5,
            candidates: 1,
            thoughts: 0,
            cached: 0,
            total: 6,
          },
        },
      },
    },
  }),
  grok: JSON.stringify({
    text: "OK",
    usage: {
      input_tokens: 5,
      output_tokens: 1,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
  }),
};
it.each(Object.entries(responses))(
  "checks %s response and reported usage with a fake CLI",
  async (harness, response) => {
    const { command } = await fixture(
      `process.stdout.write(${JSON.stringify(response)});`,
    );
    const result = await ping(harness, command);
    expect(result.passed).toBe(true);
    expect(result.line).toContain("tokens: 6");
    expect(result.line).not.toContain(response);
    expect(validResponse(harness, "not json")).toBe(false);
    expect(validResponse(harness, response.replace("OK", "Other"))).toBe(false);
  },
);
it("suppresses authentication failures and continues to remaining selected harnesses", async () => {
  const bad = await fixture(
    'process.stderr.write("secret credential from provider");process.exit(1);',
  );
  const good = await fixture(
    `process.stdout.write(${JSON.stringify(responses.grok)});`,
  );
  const lines: string[] = [];
  const code = await runSelected(
    { harnesses: ["claude", "grok"] },
    { harnessCommands: { claude: bad.command, grok: good.command } },
    process.env,
    (s: string) => lines.push(s),
  );
  expect(code).toBe(1);
  expect(lines[0]).toContain("authentication failed (check login)");
  expect(lines[1]).toContain("PASS");
  expect(lines.join()).not.toContain("secret");
});
it("detects configured executable overrides for --installed and fails on no installations", async () => {
  const { command } = await fixture(
    `process.stdout.write(${JSON.stringify(responses.claude)});`,
  );
  const lines: string[] = [];
  expect(
    await runSelected(
      { installed: true },
      { harnessCommands: { claude: command } },
      { PATH: "" },
      (s: string) => lines.push(s),
    ),
  ).toBe(0);
  expect(lines).toHaveLength(1);
  expect(
    await runSelected({ installed: true }, {}, { PATH: "" }, () => {}),
  ).toBe(1);
  expect(
    await runSelected({ harnesses: ["grok"] }, {}, { PATH: "" }, () => {}),
  ).toBe(1);
});
it("kills a CLI that ignores SIGTERM within the timeout", async () => {
  const { command, root } = await fixture(
    'process.on("SIGTERM",()=>{});setInterval(()=>{},1000);',
  );
  const start = Date.now();
  const result = await execute(command, [], {
    cwd: root,
    env: process.env,
    timeoutMs: 100,
  });
  expect(result.status).toBe("timeout");
  expect(Date.now() - start).toBeLessThan(2000);
});
it("caps output and handles missing executables without exposing their errors", async () => {
  const { command, root } = await fixture(
    'process.stdout.write("x".repeat(2_000_000));',
  );
  expect(
    (await execute(command, [], { cwd: root, env: process.env })).status,
  ).toBe("output limit");
  expect(
    (await execute(join(root, "missing"), [], { cwd: root, env: process.env }))
      .status,
  ).toBe("could not start");
});
it("rejects error envelopes even when they contain OK", () => {
  expect(validResponse("claude", '{"result":"OK","is_error":true}')).toBe(
    false,
  );
  expect(validResponse("gemini", '{"response":"OK","error":{}}')).toBe(false);
  expect(validResponse("grok", '{"text":"OK","type":"error"}')).toBe(false);
  expect(
    validResponse("codex", responses.codex + '\n{"type":"turn.failed"}'),
  ).toBe(false);
});
it("builds restricted calls while preserving authentication environment", async () => {
  const { root } = await fixture("");
  const env = { HOME: root, CODEX_HOME: root, TEST_AUTH: "sentinel" };
  for (const h of Object.keys(responses)) {
    const call = await invocation(h, root, env);
    expect(call.env.TEST_AUTH).toBe("sentinel");
    expect(call.env.HOME).toBe(root);
    expect(call.args).toContain("Reply exactly OK");
    if (h === "claude" || h === "grok")
      expect(call.args[call.args.indexOf("--tools") + 1]).toBe("");
    if (h === "claude") {
      expect(call.args).toContain("--safe-mode");
      expect(call.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS).toBe("16");
    }
    if (h === "gemini")
      expect(await readFile(join(root, "deny.toml"), "utf8")).toContain(
        'decision = "deny"',
      );
  }
  expect(env).not.toHaveProperty("CLAUDE_CODE_MAX_OUTPUT_TOKENS");
});

it("classifies failures without forwarding sensitive output", () => {
  expect(
    classifyFailure("Please set an Auth method; GEMINI_API_KEY=secret"),
  ).toBe("authentication failed (check login)");
  expect(classifyFailure("Unknown option --private-value")).toBe(
    "unsupported CLI options",
  );
  expect(classifyFailure("429 secret payload")).toBe("quota or rate limit");
  expect(classifyFailure("fetch failed at private URL")).toBe(
    "connection failed",
  );
});
it("does not count executable directories as installed commands", async () => {
  const { root } = await fixture("");
  expect(await executable(root)).toBeUndefined();
});
it("reports missing usage as unknown and rejects malformed success envelopes", async () => {
  const { command } = await fixture(
    'process.stdout.write(JSON.stringify({result:"OK"}));',
  );
  expect((await ping("claude", command)).line).toContain("tokens: unknown");
  for (const value of [
    "null",
    "[]",
    '{"result":123}',
    '{"result":"OK","subtype":"error_max_turns"}',
  ])
    expect(validResponse("claude", value)).toBe(false);
});
