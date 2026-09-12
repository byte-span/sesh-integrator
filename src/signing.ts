import { basename } from "node:path";
import { run } from "./process.js";
import type { RepositoryConfig } from "./types.js";

interface SigningConfiguration {
  enabled: boolean;
  format: string;
  program?: string;
  signingKey?: string;
}

export async function preflightCommitSigning(
  repository: RepositoryConfig,
  cwd: string,
  purpose: string,
): Promise<boolean> {
  const signing = await readSigningConfiguration(repository, cwd);
  if (!signing.enabled) return false;
  if (signing.format !== "openpgp") {
    throw new Error(
      `Signed ${purpose} requires OpenPGP, but gpg.format is ${signing.format}`,
    );
  }

  const program = signing.program ?? "gpg";
  const args = ["--no-tty", "--armor", "--detach-sign", "--status-fd=2"];
  if (signing.signingKey) args.push("--local-user", signing.signingKey);
  const result = await run(program, args, {
    cwd,
    input: `parallel-integrator ${purpose} signing preflight\n`,
  });
  if (
    result.code !== 0 ||
    !result.stderr.includes("[GNUPG:] SIG_CREATED") ||
    !result.stdout.includes("-----BEGIN PGP SIGNATURE-----")
  ) {
    const details = (result.stderr || result.stdout).trim();
    throw new Error(
      `OpenPGP signing preflight failed for ${purpose} with ${program}` +
        `${details ? `: ${details}` : " (no diagnostic output)"}. ` +
        `The Git commit was not attempted. Check the canonical gpg-agent LaunchAgent, pinentry, signing key, and configured gpg.program.`,
    );
  }
  process.stdout.write(
    `Signing preflight passed for ${purpose} with ${basename(program)}.\n`,
  );
  return true;
}

async function readSigningConfiguration(
  repository: RepositoryConfig,
  cwd: string,
): Promise<SigningConfiguration> {
  const [enabled, format, configuredProgram, signingKey] = await Promise.all([
    gitConfig(cwd, ["--bool", "--get", "commit.gpgSign"]),
    gitConfig(cwd, ["--get", "gpg.format"]),
    gitConfig(cwd, ["--path", "--get", "gpg.program"]),
    gitConfig(cwd, ["--get", "user.signingkey"]),
  ]);
  return {
    enabled: enabled === "true",
    format: format || "openpgp",
    ...(repository.gpgProgram || configuredProgram
      ? { program: repository.gpgProgram ?? configuredProgram }
      : {}),
    ...(signingKey ? { signingKey } : {}),
  };
}

async function gitConfig(cwd: string, args: string[]): Promise<string> {
  const result = await run("git", ["config", ...args], { cwd });
  return result.code === 0 ? result.stdout.trim() : "";
}
