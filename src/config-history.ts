import { randomBytes } from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";

// Every config.json write keeps the text it replaces, so a change made from
// the CLI or the dashboard can be compared and restored later.
export const configHistoryLimit = 20;

export interface ConfigSnapshot {
  version: 1;
  id: string;
  /** When this text was replaced. */
  replacedAt: string;
  /** What replaced it, for example `seshx register` or `Dashboard JSON`. */
  source: string;
  text: string;
}

export interface ConfigSnapshotSummary {
  id: string;
  replacedAt: string;
  source: string;
  bytes: number;
}

// Millisecond timestamp plus a random suffix: names sort oldest first.
const idPattern = /^\d{13}-[0-9a-f]{8}$/;
const fileName = (id: string) => `${id}.json`;

export const configHistoryDirectory = (configPath: string): string =>
  join(dirname(configPath), "config-history");

async function snapshotIds(directory: string): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return names
    .filter((name) => name.endsWith(".json"))
    .map((name) => name.slice(0, -".json".length))
    .filter((id) => idPattern.test(id))
    .sort();
}

/**
 * Keep `previous` before config.json is replaced with `next`. Nothing is kept
 * for a new file or an unchanged one. Call it under the configuration lock,
 * before writing, so a failure leaves config.json untouched.
 */
export async function recordConfigSnapshot(
  configPath: string,
  previous: string | null,
  next: string,
  source: string,
): Promise<void> {
  if (previous === null || previous === next) return;
  const directory = configHistoryDirectory(configPath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const ids = await snapshotIds(directory);
  for (const id of ids.slice(
    0,
    Math.max(0, ids.length - configHistoryLimit + 1),
  ))
    await rm(join(directory, fileName(id)), { force: true });
  // Stay after the newest snapshot even if the clock moved backwards.
  const newest = Number(ids.at(-1)?.slice(0, 13) ?? 0);
  const at = Math.max(Date.now(), newest + 1);
  const id = `${String(at).padStart(13, "0")}-${randomBytes(4).toString("hex")}`;
  const snapshot: ConfigSnapshot = {
    version: 1,
    id,
    replacedAt: new Date(at).toISOString(),
    source,
    text: previous,
  };
  const path = join(directory, fileName(id));
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(snapshot, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporary, path);
}

function parseSnapshot(text: string, id: string): ConfigSnapshot | null {
  try {
    const value = JSON.parse(text) as ConfigSnapshot;
    return value?.version === 1 &&
      value.id === id &&
      typeof value.replacedAt === "string" &&
      typeof value.source === "string" &&
      typeof value.text === "string"
      ? value
      : null;
  } catch {
    return null;
  }
}

/** Newest first. Unreadable snapshots are skipped. Never creates the folder. */
export async function listConfigHistory(
  configPath: string,
): Promise<ConfigSnapshotSummary[]> {
  const directory = configHistoryDirectory(configPath);
  const ids = (await snapshotIds(directory)).reverse();
  const entries = await Promise.all(
    ids.map(async (id) => {
      try {
        return parseSnapshot(
          await readFile(join(directory, fileName(id)), "utf8"),
          id,
        );
      } catch {
        return null;
      }
    }),
  );
  return entries.flatMap((entry) =>
    entry
      ? [
          {
            id: entry.id,
            replacedAt: entry.replacedAt,
            source: entry.source,
            bytes: Buffer.byteLength(entry.text),
          },
        ]
      : [],
  );
}

export async function readConfigSnapshot(
  configPath: string,
  id: string,
): Promise<ConfigSnapshot> {
  if (!idPattern.test(id)) throw new Error("Invalid history entry");
  let text: string;
  try {
    text = await readFile(
      join(configHistoryDirectory(configPath), fileName(id)),
      "utf8",
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      throw new Error("History entry no longer exists");
    throw error;
  }
  const snapshot = parseSnapshot(text, id);
  if (!snapshot) throw new Error("History entry is unreadable");
  return snapshot;
}
