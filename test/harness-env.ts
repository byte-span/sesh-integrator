/**
 * Environment for a child process whose harness directories must all live
 * under `home`. Variables that relocate a harness directory would otherwise
 * point skill installs at the operator's real directories.
 */
export function harnessHomeEnv(
  home: string,
  extra: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home };
  for (const name of [
    "CLAUDE_CONFIG_DIR",
    "CODEX_HOME",
    "XDG_CONFIG_HOME",
    "OPENCODE_CONFIG_DIR",
    "PI_CODING_AGENT_DIR",
  ])
    delete env[name];
  return { ...env, ...extra };
}
