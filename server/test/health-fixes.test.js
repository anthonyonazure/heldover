// The 2026-09-25 health fixes: which shared servers count as abandoned, and how
// bad startup settings are handled. Runs against a throwaway data folder.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'heldover-test-'));
const { isAbandonedShare } = await import('../src/plex.js');

const DAY = 24 * 60 * 60 * 1000;
const now = Date.parse('2026-09-25T00:00:00Z');
const seen = (daysAgo) => new Date(now - daysAgo * DAY).toISOString();

test('a shared server plex.tv has not seen for over 30 days is left out', () => {
  assert.equal(isAbandonedShare({ owned: false, presence: false, lastSeenAt: seen(127) }, now), true);
});

test('a shared server that is merely down today is kept', () => {
  assert.equal(isAbandonedShare({ owned: false, presence: false, lastSeenAt: seen(2) }, now), false);
});

test('a server plex.tv sees right now is kept, whatever its last-seen date', () => {
  assert.equal(isAbandonedShare({ owned: false, presence: true, lastSeenAt: seen(90) }, now), false);
});

test('your own server is never left out', () => {
  assert.equal(isAbandonedShare({ owned: true, presence: false, lastSeenAt: seen(400) }, now), false);
});

test('a missing last-seen date is not treated as abandoned', () => {
  assert.equal(isAbandonedShare({ owned: false, presence: false }, now), false);
});

const envCheck = fileURLToPath(new URL('../src/env-check.js', import.meta.url));
function runEnvCheck(env) {
  const script = `await import(${JSON.stringify(envCheck)}); console.log(JSON.stringify({PORT: process.env.PORT, DISABLE_MDNS: process.env.DISABLE_MDNS, OMDB_DAILY_LIMIT: process.env.OMDB_DAILY_LIMIT, TMDB_API_KEY: process.env.TMDB_API_KEY}))`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { PATH: process.env.PATH, ...env },
    encoding: 'utf8',
  });
  return { status: r.status, out: r.stdout.trim().split('\n').pop(), err: r.stderr };
}

test('bad startup settings are named and replaced by their defaults', () => {
  const r = runEnvCheck({ PORT: 'abc', OMDB_DAILY_LIMIT: 'lots' });
  assert.equal(r.status, 0);
  assert.deepEqual(JSON.parse(r.out), {});
  assert.match(r.err, /PORT="abc" ignored/);
  assert.match(r.err, /OMDB_DAILY_LIMIT="lots" ignored/);
});

test('"true" works where "1" was meant, and pasted keys lose stray spaces', () => {
  const r = runEnvCheck({ DISABLE_MDNS: 'true', PORT: ' 3080 ', TMDB_API_KEY: ' abc123 \n' });
  assert.deepEqual(JSON.parse(r.out), { PORT: '3080', DISABLE_MDNS: '1', TMDB_API_KEY: 'abc123' });
  assert.equal(r.err, '');
});

test('a data folder that cannot be written stops startup with a clear message', () => {
  const r = runEnvCheck({ DATA_DIR: '/System/heldover-cannot-write-here' });
  assert.equal(r.status, 1);
  assert.match(r.err, /cannot be written/);
});
