import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// Contract tests, kept as shipped except these import paths: Vitest runs them here.
import { test } from 'vitest';
import { activeTargets, classify, hashSkill, removeSkill, replaceSkill, stamp, syncSkill, unstamp } from '../src/skill-contract.mjs';

const SOURCE = '---\nname: demo\ndescription: Demo skill.\n---\n\n# Demo\n';
const WITH_META = '---\nname: demo\ndescription: Demo skill.\nmetadata:\n  author: me\n---\nBody\n';
const meta = { by: 'demo-tool', version: '1.2.3', command: 'demo', hash: 'sha256:abc' };

test('stamp/unstamp round-trips with and without an existing metadata map', () => {
  for (const text of [SOURCE, WITH_META, SOURCE.replaceAll('\n', '\r\n')]) {
    const stamped = stamp(text, meta);
    assert.match(stamped, /managed-by: "demo-tool"/);
    assert.equal(unstamp(stamped), text);
  }
});

test('install, heal, edit protection and removal across harness dirs', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-contract-'));
  fs.mkdirSync(path.join(home, '.claude'));
  fs.mkdirSync(path.join(home, '.grok'));
  const src = path.join(home, 'src', 'demo');
  fs.mkdirSync(path.join(src, 'references'), { recursive: true });
  fs.writeFileSync(path.join(src, 'SKILL.md'), SOURCE);
  fs.writeFileSync(path.join(src, 'references', 'a.md'), 'A\n');
  const env = {};
  const base = { source: src, name: 'demo', owner: 'demo-tool', version: '1.0.0', command: 'demo', home, env };

  assert.deepEqual(activeTargets({ home, env }).map((t) => t.id), ['claude', 'grok']);
  assert.ok(syncSkill({ ...base, mode: 'heal' }).every((r) => r.state === 'missing' && !r.changed));
  assert.ok(syncSkill({ ...base, mode: 'install' }).every((r) => r.changed));
  assert.ok(syncSkill({ ...base }).every((r) => r.state === 'current'));

  // Bundled skill changes without a version bump -> stale, heal leaves it.
  fs.writeFileSync(path.join(src, 'references', 'a.md'), 'A2\n');
  assert.ok(syncSkill({ ...base, mode: 'heal' }).every((r) => r.state === 'stale' && !r.changed));
  // Newer version -> heal updates; an older tool then never downgrades it.
  assert.ok(syncSkill({ ...base, version: '1.10.0', mode: 'heal' }).every((r) => r.state === 'stale' && r.changed));
  fs.writeFileSync(path.join(src, 'references', 'a.md'), 'A-old\n');
  assert.ok(syncSkill({ ...base, version: '1.9.0', mode: 'heal' }).every((r) => !r.changed));
  assert.ok(syncSkill({ ...base, version: '1.9.0', mode: 'install' }).every((r) => !r.changed && r.installedVersion === '1.10.0'));
  fs.writeFileSync(path.join(src, 'references', 'a.md'), 'A2\n');
  const claudeCopy = path.join(home, '.claude', 'skills', 'demo');
  assert.equal(fs.readFileSync(path.join(claudeCopy, 'references', 'a.md'), 'utf8'), 'A2\n');
  assert.equal(hashSkill(claudeCopy), hashSkill(src));

  // User edit -> edited -> never overwritten or removed.
  fs.appendFileSync(path.join(claudeCopy, 'SKILL.md'), 'my note\n');
  fs.writeFileSync(path.join(src, 'references', 'a.md'), 'A3\n');
  const healed = syncSkill({ ...base, mode: 'heal' });
  assert.equal(healed.find((r) => r.target === 'claude').state, 'edited');
  assert.match(fs.readFileSync(path.join(claudeCopy, 'SKILL.md'), 'utf8'), /my note/);
  assert.equal(removeSkill({ name: 'demo', targetDir: path.join(home, '.claude', 'skills'), owner: 'demo-tool', bundledHash: hashSkill(src) }).removed, false);

  // Other owner and hand-made copies are left alone.
  assert.equal(classify(claudeCopy, { owner: 'someone-else', bundledHash: hashSkill(src) }), 'other-owner');
  const hand = path.join(home, '.grok', 'skills', 'hand');
  fs.mkdirSync(hand);
  fs.writeFileSync(path.join(hand, 'SKILL.md'), SOURCE);
  assert.equal(classify(hand, { owner: 'demo-tool' }), 'unmanaged');
  assert.equal(classify(hand, { owner: 'demo-tool', legacyHashes: [hashSkill(hand)] }), 'legacy');

  // Leftovers from a crashed or raced install are swept on the next install.
  const grokSkills = path.join(home, '.grok', 'skills');
  const leftover = path.join(grokSkills, '.demo.replaced-999999999');
  fs.mkdirSync(leftover);
  fs.writeFileSync(path.join(leftover, 'SKILL.md'), SOURCE);
  syncSkill({ ...base, version: '2.0.0', mode: 'install' });
  assert.equal(fs.existsSync(leftover), false);
  assert.deepEqual(fs.readdirSync(grokSkills).filter((e) => e.startsWith('.')), []);

  // Owned unedited copy can be removed.
  assert.equal(removeSkill({ name: 'demo', targetDir: path.join(home, '.grok', 'skills'), owner: 'demo-tool', bundledHash: hashSkill(src) }).removed, true);
  fs.rmSync(home, { recursive: true, force: true });
});

test('concurrent installs and heals never crash or leave stray folders', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-contract-race-'));
  fs.mkdirSync(path.join(home, '.claude'));
  const src = path.join(home, 'src', 'demo');
  fs.mkdirSync(src, { recursive: true });
  fs.writeFileSync(path.join(src, 'SKILL.md'), SOURCE);
  const moduleUrl = new URL('../src/skill-contract.mjs', import.meta.url).href;
  const worker = `
    const { syncSkill } = await import(${JSON.stringify(moduleUrl)});
    const [src, home, id] = process.argv.slice(1);
    for (let i = 0; i < 25; i += 1) {
      const mode = i % 2 ? 'heal' : 'install';
      const rows = syncSkill({ source: src, name: 'demo', owner: 'demo-tool', version: String(id * 100 + i), command: 'demo', mode, home, env: {} });
      if (rows.some((r) => r.state === 'error')) { console.error(JSON.stringify(rows)); process.exit(1); }
    }`;
  const runs = Array.from({ length: 6 }, (_, id) => new Promise((resolve) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', worker, src, home, String(id)], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    child.stderr.on('data', (d) => { err += d; });
    child.on('close', (code) => resolve({ code, err }));
  }));
  for (const { code, err } of await Promise.all(runs)) assert.equal(code, 0, err);
  const skills = path.join(home, '.claude', 'skills');
  assert.deepEqual(fs.readdirSync(skills), ['demo']);
  assert.equal(classify(path.join(skills, 'demo'), { owner: 'demo-tool', bundledHash: hashSkill(src) }), 'current');
  fs.rmSync(home, { recursive: true, force: true });
});

test('replaceSkill backs up an edited copy outside skills dirs, then installs', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-contract-replace-'));
  const targetDir = path.join(home, '.claude', 'skills');
  const src = path.join(home, 'src', 'demo');
  fs.mkdirSync(src, { recursive: true });
  fs.writeFileSync(path.join(src, 'SKILL.md'), SOURCE);
  const opts = { source: src, name: 'demo', targetDir, owner: 'demo-tool', version: '1.0.0', command: 'demo' };
  const backupDir = path.join(home, 'state', 'skill-backups', 'demo-20261113T000000Z', 'claude');
  replaceSkill({ ...opts, backupDir });
  assert.equal(fs.existsSync(backupDir), false, 'nothing to back up on first install');
  fs.appendFileSync(path.join(targetDir, 'demo', 'SKILL.md'), 'my edit\n');
  assert.equal(classify(path.join(targetDir, 'demo'), { owner: 'demo-tool', bundledHash: hashSkill(src) }), 'edited');
  const result = replaceSkill({ ...opts, backupDir });
  assert.equal(result.backup, backupDir);
  assert.match(fs.readFileSync(path.join(backupDir, 'SKILL.md'), 'utf8'), /my edit/);
  assert.equal(classify(path.join(targetDir, 'demo'), { owner: 'demo-tool', bundledHash: hashSkill(src) }), 'current');
  assert.throws(() => replaceSkill({ ...opts, backupDir }), /already exists/);
  assert.deepEqual(fs.readdirSync(targetDir), ['demo']);
  fs.rmSync(home, { recursive: true, force: true });
});
