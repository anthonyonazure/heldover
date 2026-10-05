// The settings file holds the access PIN and the Plex sign-in. Only a file
// that is not there means a new install. A file that is there but cannot be
// read or understood used to be treated the same way: the app started with
// blank settings (no PIN, so every device on the network was let in) and
// wrote them over the old file.
//
// And a file that is not there never switches downloads on. One case used to:
// a folder with a database and a Plex token in the environment was taken for
// an upgrade from an older version, and started with downloads on. That is
// also how an install looks after its settings file is moved away, which is
// what the message for a damaged file tells the owner to do.
//
// Each case starts the settings module in a fresh process, as a real start
// does, against a throwaway data folder.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import fs from 'fs';
import os from 'os';
import path from 'path';

const configModule = fileURLToPath(new URL('../src/config.js', import.meta.url));

const newDataDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'heldover-test-'));
const fileIn = (dataDir) => path.join(dataDir, 'config.json');

/** Starts the settings module in its own process and reports what it ended up with. */
function start(dataDir, { env = {}, then = '' } = {}) {
  const script = `
    const config = await import(${JSON.stringify(configModule)});
    ${then}
    console.log('RESULT ' + JSON.stringify({
      pinEnabled: config.pinEnabled(),
      rightPin: config.checkPin('246810'),
      setupComplete: config.isSetupComplete(),
      downloadsEnabled: config.downloadsEnabled(),
    }));
  `;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { PATH: process.env.PATH, DATA_DIR: dataDir, ...env },
    encoding: 'utf8',
  });
  const line = r.stdout.split('\n').find((l) => l.startsWith('RESULT '));
  return { status: r.status, err: r.stderr, out: r.stdout, result: line ? JSON.parse(line.slice(7)) : null };
}

/** A data folder whose settings file holds a PIN and a finished setup. */
function installWithPin() {
  const dataDir = newDataDir();
  const made = start(dataDir, { then: "config.updateConfig({ setupComplete: true }); config.setPin('246810');" });
  assert.equal(made.status, 0);
  assert.equal(made.result.pinEnabled, true);
  return dataDir;
}

test('no settings file is a new install: one is made, readable only by this user, with no PIN', () => {
  const dataDir = newDataDir();
  const r = start(dataDir);
  assert.equal(r.status, 0);
  assert.deepEqual(r.result, { pinEnabled: false, rightPin: false, setupComplete: false, downloadsEnabled: false });
  assert.equal(fs.statSync(fileIn(dataDir)).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(dataDir), ['config.json'], 'no half-written file is left beside it');
});

test('a settings file that is intact keeps its PIN across a restart', () => {
  const dataDir = installWithPin();
  const again = start(dataDir);
  assert.equal(again.status, 0);
  assert.deepEqual(again.result, { pinEnabled: true, rightPin: true, setupComplete: true, downloadsEnabled: false });
});

// What the log says, once, when a settings file was expected and not found.
const MISSING_FILE_LINE = /settings file was missing/;
const TOKEN_IN_ENV = { PLEX_TOKEN: 'dummy-account-token' };
const addDatabase = (dataDir) => fs.writeFileSync(path.join(dataDir, 'ratings.db'), '');
/** Moves the settings file out of the way, as the message for a damaged file says to, and returns where it went. */
function moveSettingsAway(dataDir) {
  const movedTo = path.join(dataDir, 'config.json.moved');
  fs.renameSync(fileIn(dataDir), movedTo);
  return movedTo;
}

test('a settings file that was moved away, with a Plex token in the environment and a database present: setup is not asked for again, downloads are off, there is no PIN, and the log says so', () => {
  // The owner's downloads switch was off, as it is on a new install.
  const dataDir = installWithPin();
  addDatabase(dataDir);
  const movedTo = moveSettingsAway(dataDir);
  const moved = fs.readFileSync(movedTo);

  const r = start(dataDir, { env: TOKEN_IN_ENV });
  assert.equal(r.status, 0);
  assert.deepEqual(r.result, { pinEnabled: false, rightPin: false, setupComplete: true, downloadsEnabled: false });
  const said = r.out.split('\n').filter((l) => MISSING_FILE_LINE.test(l));
  assert.equal(said.length, 1, 'one line in the log');
  assert.match(said[0], /downloads switched off/);
  assert.match(said[0], /no access PIN/);
  assert.match(said[0], /open Settings on the computer that runs Heldover/);
  assert.doesNotMatch(r.out + r.err, /dummy-account-token/);
  assert.equal(fs.statSync(fileIn(dataDir)).mode & 0o777, 0o600);
  assert.deepEqual(fs.readFileSync(movedTo), moved, 'the file that was moved away is left alone');

  // The new file is an ordinary settings file from then on: the same answers
  // at the next start, and nothing more to say.
  const again = start(dataDir, { env: TOKEN_IN_ENV });
  assert.deepEqual(again.result, r.result);
  assert.doesNotMatch(again.out, MISSING_FILE_LINE);
});

test('downloads the owner had switched on do not come back on by themselves either, when the settings file goes missing', () => {
  const dataDir = installWithPin();
  assert.equal(start(dataDir, { then: 'config.updateConfig({ downloadsEnabled: true });' }).result.downloadsEnabled, true);
  addDatabase(dataDir);
  moveSettingsAway(dataDir);

  const r = start(dataDir, { env: TOKEN_IN_ENV });
  assert.deepEqual(r.result, { pinEnabled: false, rightPin: false, setupComplete: true, downloadsEnabled: false });
  assert.match(r.out, MISSING_FILE_LINE);
  // Switched on again by the owner, it stays on.
  assert.equal(start(dataDir, { env: TOKEN_IN_ENV, then: 'config.updateConfig({ downloadsEnabled: true });' }).result.downloadsEnabled, true);
  assert.equal(start(dataDir, { env: TOKEN_IN_ENV }).result.downloadsEnabled, true);
});

test('an intact settings file starts as it was saved, PIN and downloads switch and all, with a Plex token in the environment and a database present', () => {
  const dataDir = installWithPin();
  start(dataDir, { then: 'config.updateConfig({ downloadsEnabled: true });' });
  addDatabase(dataDir);
  const r = start(dataDir, { env: TOKEN_IN_ENV });
  assert.deepEqual(r.result, { pinEnabled: true, rightPin: true, setupComplete: true, downloadsEnabled: true });
  assert.doesNotMatch(r.out, MISSING_FILE_LINE);
});

test('a new folder with a Plex token in the environment and no database starts at the setup screen with downloads off', () => {
  const dataDir = newDataDir();
  const r = start(dataDir, { env: TOKEN_IN_ENV });
  assert.deepEqual(r.result, { pinEnabled: false, rightPin: false, setupComplete: false, downloadsEnabled: false });
  assert.doesNotMatch(r.out, MISSING_FILE_LINE, 'a new install is not told a file is missing');
});

test('no settings file beside a database, with no Plex token in the environment, starts at the setup screen with downloads off', () => {
  // An install that signed in on the setup screen: its token was in the file.
  const dataDir = installWithPin();
  addDatabase(dataDir);
  moveSettingsAway(dataDir);
  const r = start(dataDir);
  assert.deepEqual(r.result, { pinEnabled: false, rightPin: false, setupComplete: false, downloadsEnabled: false });
  assert.doesNotMatch(r.out, MISSING_FILE_LINE);
});

const DAMAGE = {
  'an empty file': '',
  'a file cut off part way': '{\n  "setupComplete": true,\n  "pinHash": "9f2c',
  'a hand edit with a stray comma': '{\n  "setupComplete": true,\n  "downloadsEnabled": false,\n}',
  'a file that holds only null': 'null',
  'a file that holds a list': '[]',
  'a file that holds a bare word': '"settings"',
};

for (const [name, content] of Object.entries(DAMAGE)) {
  test(`${name} stops startup and is left exactly as it was`, () => {
    const dataDir = installWithPin();
    fs.writeFileSync(fileIn(dataDir), content);
    const before = fs.readFileSync(fileIn(dataDir));

    const r = start(dataDir);
    assert.equal(r.status, 1, 'the start fails');
    assert.equal(r.result, null, 'nothing ran with blank settings');
    assert.match(r.err, /settings file .*config\.json is empty or damaged/);
    assert.match(r.err, /will not start with blank settings/);
    assert.match(r.err, /To start again with new settings on purpose, move the file away/);
    assert.deepEqual(fs.readFileSync(fileIn(dataDir)), before, 'the file has the same bytes');
    assert.deepEqual(fs.readdirSync(dataDir), ['config.json']);
  });
}

test('a damaged file is not mistaken for an upgrade either, with a Plex token in the environment and a database present', () => {
  // The quiet variant: this combination used to start as a finished setup
  // with downloads on and no PIN, and the log read like a normal start.
  const dataDir = installWithPin();
  fs.writeFileSync(path.join(dataDir, 'ratings.db'), '');
  fs.writeFileSync(fileIn(dataDir), '');

  const r = start(dataDir, { env: TOKEN_IN_ENV });
  assert.equal(r.status, 1);
  assert.equal(r.result, null);
  assert.equal(fs.statSync(fileIn(dataDir)).size, 0);
  assert.doesNotMatch(r.out, MISSING_FILE_LINE, 'a damaged file is not called a missing one');
});

test('a settings file this user may not read stops startup and is not replaced', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, () => {
  const dataDir = installWithPin();
  const size = fs.statSync(fileIn(dataDir)).size;
  fs.chmodSync(fileIn(dataDir), 0o000);
  try {
    const r = start(dataDir);
    assert.equal(r.status, 1);
    assert.equal(r.result, null);
    assert.match(r.err, /cannot be read \(EACCES\)/);
    const after = fs.statSync(fileIn(dataDir));
    assert.equal(after.mode & 0o777, 0o000);
    assert.equal(after.size, size);
  } finally {
    fs.chmodSync(fileIn(dataDir), 0o600);
  }
  // Repaired, it is the same install as before: the PIN is still in force.
  assert.equal(start(dataDir).result.pinEnabled, true);
});
