import { readFile } from "node:fs/promises";

/** What `scripts/build-info.mjs` records next to the built CLI. */
interface BuildInfo {
  commit?: string | null;
  dirty?: boolean | null;
}

export interface VersionDocument {
  name: string;
  version: string;
  /** The Git commit this build was made from, or null when unknown. */
  commit: string | null;
  /** Whether the checkout had uncommitted changes at build time. */
  dirty: boolean | null;
}

export async function versionDocument(): Promise<VersionDocument> {
  const pkg = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  ) as { name: string; version: string };
  let info: BuildInfo = {};
  try {
    info = JSON.parse(
      await readFile(new URL("./build-info.json", import.meta.url), "utf8"),
    ) as BuildInfo;
  } catch {
    // Built without the build step's commit record.
  }
  return {
    name: pkg.name,
    version: pkg.version,
    commit: typeof info.commit === "string" ? info.commit : null,
    dirty: typeof info.dirty === "boolean" ? info.dirty : null,
  };
}

export async function versionCommand(args: string[]): Promise<void> {
  if (args.length > 1 || (args.length === 1 && args[0] !== "--json"))
    throw new Error("Usage: seshx version [--json]");
  const document = await versionDocument();
  if (args[0] === "--json") {
    process.stdout.write(`${JSON.stringify(document, null, 2)}\n`);
    return;
  }
  process.stdout.write(
    `${document.name} ${document.version}\nCommit: ${
      document.commit
        ? `${document.commit}${document.dirty ? " (built with uncommitted changes)" : ""}`
        : "unknown (not built from a Git checkout)"
    }\n`,
  );
}
