import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { harnessCommand, harnessInfo, type Harness } from "./harness.js";
import { ensureRuntime, prepareCodexResolverHome } from "./runtime.js";
import { run } from "./process.js";
import type { Config } from "./types.js";

/** The lifecycle owns prompts, validation and recovery; adapters own CLI syntax. */
export async function runAgent(options: {
  config: Config;
  harness: Harness;
  purpose: "resolve" | "diagnose";
  cwd: string;
  prompt: string;
  schema?: object;
}): Promise<unknown> {
  const { config, harness, purpose, cwd, schema } = options;
  const diagnosis = purpose === "diagnose";
  const paths = await ensureRuntime();
  const temporary = await mkdtemp(join(paths.root, "agent-call-"));
  try {
    const prompt =
      options.prompt +
      (schema
        ? `\nReturn only a JSON object matching this schema:\n${JSON.stringify(schema)}`
        : "");
    const promptPath = join(temporary, "prompt.txt");
    const schemaPath = join(temporary, "schema.json");
    const outputPath = join(temporary, "result.json");
    await writeFile(promptPath, prompt, { mode: 0o600 });
    if (schema)
      await writeFile(schemaPath, JSON.stringify(schema), { mode: 0o600 });
    let args: string[];
    let input: string | undefined;
    const env = { ...process.env };
    switch (harness) {
      case "codex":
        env.CODEX_HOME = await prepareCodexResolverHome();
        args = [
          "exec",
          "--sandbox",
          diagnosis ? "read-only" : "workspace-write",
          ...(diagnosis
            ? [
                "--ephemeral",
                "--output-schema",
                schemaPath,
                "--output-last-message",
                outputPath,
              ]
            : []),
          "-",
        ];
        input = prompt;
        break;
      case "claude":
        args = [
          "-p",
          "--bare",
          "--output-format",
          "json",
          "--no-session-persistence",
          "--permission-mode",
          diagnosis ? "plan" : "acceptEdits",
          "--tools",
          diagnosis ? "Read,Glob,Grep" : "Read,Glob,Grep,Edit,Write",
          "--strict-mcp-config",
          "--mcp-config",
          '{"mcpServers":{}}',
          "--disable-slash-commands",
          "--max-turns",
          "30",
          ...(diagnosis ? ["--json-schema", JSON.stringify(schema)] : []),
        ];
        input = prompt;
        break;
      case "gemini": {
        // A per-call policy prevents a user's broader approvals from turning
        // diagnosis into an editing session, including via shell or MCP tools.
        const policyPath = join(temporary, "policy.toml");
        const readTools = [
          "read_file",
          "read_many_files",
          "list_directory",
          "glob",
          "grep_search",
        ];
        const tools = diagnosis
          ? readTools
          : [...readTools, "replace", "write_file"];
        const policy = `[[rule]]\ntoolName = "*"\ndecision = "deny"\npriority = 998\n\n[[rule]]\ntoolName = ${JSON.stringify(tools)}\ndecision = "allow"\npriority = 999\n`;
        await writeFile(policyPath, policy, { mode: 0o600 });
        args = [
          "-p",
          "Follow the task supplied on stdin.",
          "--output-format",
          "json",
          "--approval-mode",
          diagnosis ? "plan" : "auto_edit",
          "--policy",
          policyPath,
        ];
        input = prompt;
        break;
      }
      case "grok":
        args = [
          "--no-auto-update",
          "--prompt-file",
          promptPath,
          "--output-format",
          "json",
          "--sandbox",
          diagnosis ? "read-only" : "workspace",
          "--no-subagents",
          "--no-memory",
          "--no-plan",
          "--disable-web-search",
          "--tools",
          diagnosis
            ? "read_file,grep,list_dir"
            : "read_file,grep,list_dir,search_replace",
          "--deny",
          "MCPTool",
          "--max-turns",
          "30",
          "--allow",
          "Read",
          "--allow",
          "Grep",
          ...(diagnosis ? [] : ["--allow", "Edit", "--allow", "Write"]),
        ];
        break;
    }
    const result = await run(harnessCommand(config, harness), args, {
      cwd,
      env,
      ...(input === undefined ? {} : { input }),
      timeoutMs: diagnosis ? 120_000 : 300_000,
    });
    if (result.code !== 0)
      throw new Error(
        `${harnessInfo[harness].name} ${purpose} exited ${result.code}; inspect the preserved session evidence`,
      );
    if (harness === "codex")
      return diagnosis
        ? JSON.parse(await readFile(outputPath, "utf8"))
        : undefined;
    const envelope = JSON.parse(result.stdout) as Record<string, unknown>;
    if (
      !envelope ||
      typeof envelope !== "object" ||
      envelope.error ||
      envelope.is_error ||
      envelope.type === "error"
    )
      throw new Error(
        `${harnessInfo[harness].name} reported an unsuccessful response`,
      );
    if (!diagnosis) return undefined;
    if (harness === "claude" && envelope.structured_output !== undefined)
      return envelope.structured_output;
    const answer =
      harness === "claude"
        ? envelope.result
        : harness === "grok"
          ? envelope.text
          : envelope.response;
    if (typeof answer !== "string")
      throw new Error(`${harnessInfo[harness].name} returned no diagnosis`);
    return JSON.parse(answer);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
