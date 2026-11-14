import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// Contract tests, kept as shipped except these imports: Vitest runs them here.
import { test } from 'vitest';
import { activeTargets, classify, hashSkill, removeSkill, stamp, syncSkill, unstamp } from '../src/skill-contract.mjs';

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

  // Owned unedited copy can be removed.
  assert.equal(removeSkill({ name: 'demo', targetDir: path.join(home, '.grok', 'skills'), owner: 'demo-tool', bundledHash: hashSkill(src) }).removed, true);
  fs.rmSync(home, { recursive: true, force: true });
});
