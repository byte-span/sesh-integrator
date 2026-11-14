// No test may heal or install skills in the operator's harness directories.
// Child CLIs inherit this environment; skill tests pass their own HOME and
// re-enable healing explicitly.
process.env.AGENT_SKILL_HEAL = "0";
for (const name of [
  "CLAUDE_CONFIG_DIR",
  "OPENCODE_CONFIG_DIR",
  "PI_CODING_AGENT_DIR",
])
  delete process.env[name];
