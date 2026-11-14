// Agent skill install contract v1 — reference implementation.
//
// Copy this file verbatim into each tool that installs skills (for example
// src/skill-contract.mjs). Never import it from another repository or package:
// each tool must work alone. Keep copies identical; change behavior only by
// publishing a new contract version and updating every copy.
//
// Contract: agent-skill-contract/1 (see SPEC.md shipped alongside this file).
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const CONTRACT = 'agent-skill-contract/1';
export const HARNESS_LIST_VERSION = '2026-11-13';
export const MANAGED_KEYS = ['managed-by', 'managed-version', 'managed-command', 'managed-hash'];

// Files never hashed or copied (legacy install markers, OS noise).
const IGNORED_FILES = new Set(['.box-up-installed', '.DS_Store', 'Thumbs.db']);
const MANAGED_LINE = /^ {2}managed-(by|version|command|hash): .*$/;

// User-level skill directories. One entry per directory, listing the harnesses
// that read it. Several harnesses read a shared directory (Gemini CLI reads
// ~/.agents/skills; Cursor and GitHub Copilot CLI read ~/.claude/skills), so
// they get no separate entry, which avoids duplicate skills in those harnesses.
export function skillTargets({ home = os.homedir(), env = process.env } = {}) {
  const config = env.XDG_CONFIG_HOME || path.join(home, '.config');
  const claude = env.CLAUDE_CONFIG_DIR || path.join(home, '.claude');
  const codex = env.CODEX_HOME || path.join(home, '.codex');
  const gemini = path.join(home, '.gemini');
  const opencode = env.OPENCODE_CONFIG_DIR || path.join(config, 'opencode');
  const pi = env.PI_CODING_AGENT_DIR || path.join(home, '.pi', 'agent');
  const grok = path.join(home, '.grok');
  return [
    { id: 'agents', harnesses: ['Codex', 'Gemini CLI'], dir: path.join(home, '.agents', 'skills'), detect: [path.join(home, '.agents'), codex, gemini] },
    { id: 'claude', harnesses: ['Claude Code', 'Cursor', 'GitHub Copilot CLI'], dir: path.join(claude, 'skills'), detect: [claude, path.join(home, '.cursor'), path.join(home, '.copilot')] },
    { id: 'grok', harnesses: ['Grok Build'], dir: path.join(grok, 'skills'), detect: [grok] },
    { id: 'antigravity-cli', harnesses: ['Antigravity CLI'], dir: path.join(gemini, 'antigravity-cli', 'skills'), detect: [path.join(gemini, 'antigravity-cli')] },
    { id: 'antigravity-ide', harnesses: ['Antigravity IDE'], dir: path.join(gemini, 'config', 'skills'), detect: [path.join(gemini, 'config')] },
    { id: 'antigravity-ide-legacy', harnesses: ['Antigravity IDE (legacy)'], dir: path.join(gemini, 'antigravity', 'skills'), detect: [path.join(gemini, 'antigravity')] },
    { id: 'opencode', harnesses: ['OpenCode'], dir: path.join(opencode, 'skills'), detect: [opencode] },
    { id: 'pi', harnesses: ['Pi'], dir: path.join(pi, 'skills'), detect: [pi] },
  ];
}

// Targets whose harness is present on this machine, deduplicated by real path.
export function activeTargets(options = {}) {
  const seen = new Set();
  const result = [];
  for (const target of skillTargets(options)) {
    if (!target.detect.some((p) => fs.existsSync(p))) continue;
    const key = realOrResolved(target.dir);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(target);
  }
  return result;
}

function realOrResolved(p) {
  try { return fs.realpathSync(p); } catch { return path.resolve(p); }
}

// --- Frontmatter stamping -------------------------------------------------

function splitFrontmatter(text) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(eol);
  if (lines[0] !== '---') throw new Error('SKILL.md must start with YAML frontmatter (---)');
  const end = lines.indexOf('---', 1);
  if (end < 0) throw new Error('SKILL.md frontmatter is not closed (---)');
  return { eol, lines, end };
}

const quote = (value) => JSON.stringify(String(value));

// Insert managed metadata into SKILL.md text. Source text must not already
// contain managed-* keys.
export function stamp(text, meta) {
  const { eol, lines, end } = splitFrontmatter(text);
  const front = lines.slice(1, end);
  if (front.some((l) => MANAGED_LINE.test(l))) throw new Error('Source SKILL.md already contains managed-* metadata');
  const entries = MANAGED_KEYS.map((key) => {
    const value = meta[key.slice('managed-'.length)];
    if (value === undefined || value === '') throw new Error(`Missing ${key}`);
    return `  ${key}: ${quote(value)}`;
  });
  const metaIndex = front.findIndex((l) => /^metadata:\s*$/.test(l));
  if (metaIndex >= 0) {
    const next = front[metaIndex + 1];
    if (next === undefined || !/^\s+\S/.test(next)) throw new Error('Source SKILL.md has an empty metadata map');
    front.splice(metaIndex + 1, 0, ...entries);
  } else {
    front.push('metadata:', ...entries);
  }
  return ['---', ...front, ...lines.slice(end)].join(eol);
}

// Remove managed metadata, restoring the source text exactly.
export function unstamp(text) {
  const { eol, lines, end } = splitFrontmatter(text);
  const front = lines.slice(1, end).filter((l) => !MANAGED_LINE.test(l));
  const metaIndex = front.findIndex((l) => /^metadata:\s*$/.test(l));
  if (metaIndex >= 0) {
    const next = front[metaIndex + 1];
    if (next === undefined || !/^\s+\S/.test(next)) front.splice(metaIndex, 1);
  }
  return ['---', ...front, ...lines.slice(end)].join(eol);
}

// Read managed metadata from an installed skill folder. Returns null if the
// folder or SKILL.md is missing, or {} when it has no managed metadata.
export function readStamp(skillDir) {
  let text;
  try { text = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf8'); } catch { return null; }
  let parts;
  try { parts = splitFrontmatter(text); } catch { return {}; }
  const meta = {};
  for (const line of parts.lines.slice(1, parts.end)) {
    const match = MANAGED_LINE.exec(line);
    if (!match) continue;
    const raw = line.slice(line.indexOf(':') + 1).trim();
    try { meta[match[1]] = JSON.parse(raw); } catch { meta[match[1]] = raw; }
  }
  return meta;
}

// --- Hashing ----------------------------------------------------------------

function listFiles(root, rel = '') {
  const out = [];
  for (const entry of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
    if (IGNORED_FILES.has(entry.name)) continue;
    const child = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...listFiles(root, child));
    else if (entry.isFile()) out.push(child);
    else throw new Error(`Unsupported entry in skill folder (symlinks are not allowed): ${child}`);
  }
  return out;
}

// Content hash of a skill folder in its source (unstamped) form. Works on
// both a bundled source folder and an installed (stamped) copy.
export function hashSkill(skillDir) {
  const files = listFiles(skillDir).sort();
  const manifest = crypto.createHash('sha256');
  for (const rel of files) {
    let bytes = fs.readFileSync(path.join(skillDir, rel));
    if (rel === 'SKILL.md') bytes = Buffer.from(unstamp(bytes.toString('utf8')), 'utf8');
    const digest = crypto.createHash('sha256').update(bytes).digest('hex');
    manifest.update(`${rel}\0${digest}\n`);
  }
  return `sha256:${manifest.digest('hex')}`;
}

// --- Classification -----------------------------------------------------------

// States:
//   missing     not installed in this directory
//   unmanaged   present without managed metadata (hand-made, or legacy copy)
//   legacy      unmanaged, but content matches a known earlier version of this owner's skill
//   other-owner managed by a different owner
//   edited      owned, but content changed since install (never overwrite)
//   current     owned, unedited, matches the bundled version
//   stale       owned, unedited, differs from the bundled version
export function classify(installedDir, { owner, bundledHash, legacyHashes = [] }) {
  const meta = readStamp(installedDir);
  if (meta === null) return fs.existsSync(installedDir) ? 'unmanaged' : 'missing';
  if (!meta.by) return legacyHashes.includes(safeHash(installedDir)) ? 'legacy' : 'unmanaged';
  if (meta.by !== owner) return 'other-owner';
  if (safeHash(installedDir) !== meta.hash) return 'edited';
  if (!bundledHash) return 'current';
  return meta.hash === bundledHash ? 'current' : 'stale';
}

function safeHash(dir) {
  try { return hashSkill(dir); } catch { return null; }
}

// --- Install / remove -----------------------------------------------------------

// Copy a bundled skill folder into targetDir/<name>, stamped with managed
// metadata. Callers must only replace an existing copy whose state is
// stale or legacy. The swap uses sibling temp folders, then renames.
export function installSkill({ source, name, targetDir, owner, version, command }) {
  const hash = hashSkill(source);
  fs.mkdirSync(targetDir, { recursive: true });
  const dest = path.join(targetDir, name);
  const temp = path.join(targetDir, `.${name}.installing-${process.pid}`);
  const old = path.join(targetDir, `.${name}.replaced-${process.pid}`);
  fs.rmSync(temp, { recursive: true, force: true });
  try {
    fs.mkdirSync(temp);
    for (const rel of listFiles(source)) {
      const to = path.join(temp, rel);
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(path.join(source, rel), to);
    }
    const skillMd = path.join(temp, 'SKILL.md');
    fs.writeFileSync(skillMd, stamp(fs.readFileSync(skillMd, 'utf8'), { by: owner, version, command, hash }));
    if (fs.existsSync(dest)) fs.renameSync(dest, old);
    fs.renameSync(temp, dest);
    fs.rmSync(old, { recursive: true, force: true });
  } catch (error) {
    fs.rmSync(temp, { recursive: true, force: true });
    if (!fs.existsSync(dest) && fs.existsSync(old)) fs.renameSync(old, dest);
    throw error;
  }
  return { dest, hash };
}

// Remove an owned copy. Refuses anything not current, stale or legacy.
export function removeSkill({ name, targetDir, owner, bundledHash, legacyHashes }) {
  const dest = path.join(targetDir, name);
  const state = classify(dest, { owner, bundledHash, legacyHashes });
  if (!['current', 'stale', 'legacy'].includes(state)) return { dest, state, removed: false };
  fs.rmSync(dest, { recursive: true, force: true });
  return { dest, state, removed: true };
}

// Compare dotted versions ("1.10.0" > "1.9.2"). Numeric segments compare as
// numbers, others as strings; missing segments count as 0.
export function compareVersions(a, b) {
  const pa = String(a ?? '').split(/[.+-]/);
  const pb = String(b ?? '').split(/[.+-]/);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const x = pa[i] ?? '0';
    const y = pb[i] ?? '0';
    const nx = /^\d+$/.test(x) ? Number(x) : NaN;
    const ny = /^\d+$/.test(y) ? Number(y) : NaN;
    const diff = Number.isNaN(nx) || Number.isNaN(ny) ? x.localeCompare(y) : nx - ny;
    if (diff !== 0) return Math.sign(diff);
  }
  return 0;
}

// One pass over active targets.
//   mode "install": install where missing; update legacy, and stale copies
//                   whose installed version is not newer than this one
//                   (allowDowngrade: true also replaces newer ones).
//   mode "heal":    update legacy, and stale copies with an older installed
//                   version only. Never adds a missing copy (respects
//                   deliberate removal) and never downgrades, so two installed
//                   versions of a tool cannot flip-flop. Use on normal CLI runs.
//   mode "status":  change nothing.
// Never touches unmanaged, other-owner or edited copies.
export function syncSkill({ source, name, owner, version, command, legacyHashes = [], mode = 'status', allowDowngrade = false, home, env }) {
  const bundledHash = hashSkill(source);
  return activeTargets({ home, env }).map((target) => {
    const dest = path.join(target.dir, name);
    const state = classify(dest, { owner, bundledHash, legacyHashes });
    const installedVersion = state === 'stale' ? readStamp(dest).version : undefined;
    const order = state === 'stale' ? compareVersions(version, installedVersion) : 0;
    let update = state === 'legacy';
    if (state === 'missing') update = mode === 'install';
    if (state === 'stale') update = mode === 'heal' ? order > 0 : order >= 0 || allowDowngrade;
    const row = { target: target.id, harnesses: target.harnesses, dest, state, installedVersion, changed: false };
    if (mode === 'status' || !update) return row;
    try {
      installSkill({ source, name, targetDir: target.dir, owner, version, command });
      return { ...row, changed: true };
    } catch (error) {
      return { ...row, error: error.message };
    }
  });
}
