#!/usr/bin/env node
import { harnessInfo, selectHarnesses } from "./harness-metadata.mjs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const START = "<!-- codex-handoff:managed:start -->";
const END = "<!-- codex-handoff:managed:end -->";
const project = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const doctorHome =
  process.env.PARALLEL_INTEGRATOR_DOCTOR_HOME ??
  process.env.CODEX_HANDOFF_DOCTOR_HOME ??
  homedir();

async function optional(path) {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return "";
    throw error;
  }
}

function block(contents) {
  const trimmed = contents.trim();
  return trimmed.startsWith(START) ? trimmed : `${START}\n${trimmed}\n${END}`;
}

function replaceManaged(existing, managed) {
  const start = existing.indexOf(START);
  const end = existing.indexOf(END);
  if (start < 0 !== end < 0 || (start >= 0 && end < start)) {
    throw new Error("malformed sesh-integrator managed markers");
  }
  const next =
    start >= 0
      ? existing.slice(0, start) + managed + existing.slice(end + END.length)
      : `${existing.trimEnd()}${existing.trim() ? "\n\n" : ""}${managed}\n`;
  return next.replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

async function update(path, managed) {
  const current = await optional(path);
  const next = replaceManaged(current, managed);
  if (current === next) return false;
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.sesh-integrator-${process.pid}`;
  await writeFile(temporary, next, { mode: 0o644 });
  await rename(temporary, path);
  return true;
}

const args = process.argv.slice(2);
const selected = selectHarnesses(args, doctorHome);

const globalManaged = block(
  await readFile(join(project, "GLOBAL_AGENTS_SNIPPET.md"), "utf8"),
);
const changed = [];
for (const harness of selected) {
  const info = harnessInfo[harness];
  if (await update(join(doctorHome, info.directory, info.instructions), globalManaged)) changed.push("global guidance");
}

console.log(
  changed.length
    ? `Synchronized ${changed.join(", ")}`
    : "Managed guidance already synchronized",
);
