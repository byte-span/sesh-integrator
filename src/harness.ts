export const harnesses = ["codex", "claude", "gemini", "grok"] as const;
export type Harness = (typeof harnesses)[number];

export function parseHarness(value: string): Harness {
  if (!(harnesses as readonly string[]).includes(value))
    throw new Error("--harness must be codex, claude, gemini, or grok");
  return value as Harness;
}

export const harnessInfo = {
  codex: {
    name: "Codex CLI",
    directory: ".codex",
    instructions: "AGENTS.md",
    skillDirectory: ".agents",
  },
  claude: {
    name: "Claude Code",
    directory: ".claude",
    instructions: "CLAUDE.md",
    skillDirectory: ".claude",
  },
  gemini: {
    name: "Gemini CLI",
    directory: ".gemini",
    instructions: "GEMINI.md",
    skillDirectory: ".gemini",
  },
  grok: {
    name: "Grok Build",
    directory: ".grok",
    instructions: "AGENTS.md",
    skillDirectory: ".grok",
  },
} as const;
