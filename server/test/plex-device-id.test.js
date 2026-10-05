// Every install has its own Plex device id.
//
// A sign-in from the setup screen is collected from plex.tv by naming the id
// that asked for it. Installs that predate the setup screen all carried the
// same fixed id, "plex-picker", which anyone can read in the source. Each of
// those gets its own id at the next start, and keeps it.
//
// Each case starts the settings module in a fresh process, as a real start
// does, against a throwaway data folder. Dummy tokens only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import fs from 'fs';
import os from 'os';
import path from 'path';

const configModule = fileURLToPath(new URL('../src/config.js', import.meta.url));
const connectionsModule = fileURLToPath(new URL('../src/plex-connections.js', import.meta.url));

const OWN_ID = /^heldover-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const newDataDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'heldover-test-'));
const fileIn = (dataDir) => path.join(dataDir, 'config.json');
const saved = (dataDir) => JSON.parse(fs.readFileSync(fileIn(dataDir), 'utf8'));

/** Starts the settings module in its own process and reports the id it ends up with. */
function start(dataDir, env = {}) {
  const script = `
    const config = await import(${JSON.stringify(configModule)});
    const { PLEX_CLIENT_ID } = await import(${JSON.stringify(connectionsModule)});
    console.log('RESULT ' + JSON.stringify({
      clientId: config.getClientId(),
      sentToPlex: PLEX_CLIENT_ID,
      pinEnabled: config.pinEnabled(),
      setupComplete: config.isSetupComplete(),
      downloadsEnabled: config.downloadsEnabled(),
    }));
  `;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { PATH: process.env.PATH, DATA_DIR: dataDir, ...env },
    encoding: 'utf8',
  });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout.split('\n').find((l) => l.startsWith('RESULT ')).slice(7));
}

/** The settings file of an install from before the setup screen, PIN and all. */
const OLD_INSTALL = {
  setupComplete: true,
  downloadsEnabled: true,
  clientId: 'plex-picker',
  secret: 'a'.repeat(64),
  ownerCode: 'ABCD-EFGH',
  plexToken: 'dummy-account-token',
  pinSalt: '00112233445566778899aabbccddeeff',
  pinHash: 'f'.repeat(64),
};

test('an install that carried the shared id "plex-picker" gets its own at the next start, and nothing else in its settings changes', () => {
  const dataDir = newDataDir();
  fs.writeFileSync(fileIn(dataDir), JSON.stringify(OLD_INSTALL, null, 2));

  const first = start(dataDir);
  assert.match(first.clientId, OWN_ID);
  assert.equal(first.sentToPlex, first.clientId, 'the id sent to Plex is the one in the settings');
  assert.deepEqual(
    { pinEnabled: first.pinEnabled, setupComplete: first.setupComplete, downloadsEnabled: first.downloadsEnabled },
    { pinEnabled: true, setupComplete: true, downloadsEnabled: true }
  );
  // The same start also gives an older install the key that signs its picture
  // addresses, which it did not have. Nothing it did have is changed.
  const { pictureKey, ...kept } = saved(dataDir);
  assert.deepEqual(kept, { ...OLD_INSTALL, clientId: first.clientId }, 'saved, with every other setting as it was');
  assert.match(pictureKey, /^[0-9a-f]{64}$/);

  // It is given once: later starts keep it.
  assert.equal(start(dataDir).clientId, first.clientId);
  assert.equal(start(dataDir).clientId, first.clientId);
});

test('two installs that both carried the shared id end up with different ones', () => {
  const ids = [newDataDir(), newDataDir()].map((dataDir) => {
    fs.writeFileSync(fileIn(dataDir), JSON.stringify(OLD_INSTALL));
    return start(dataDir).clientId;
  });
  assert.match(ids[0], OWN_ID);
  assert.match(ids[1], OWN_ID);
  assert.notEqual(ids[0], ids[1]);
});

test('an older install starting for the first time with this version gets its own id too, and keeps its setup', () => {
  // How such an install looks: a database, a Plex token in the environment,
  // and no settings file yet. This start used to write "plex-picker". Setup
  // is not asked for again. Downloads start off: an install whose settings
  // file went missing looks the same from here (settings-file.test.js).
  const dataDir = newDataDir();
  fs.writeFileSync(path.join(dataDir, 'ratings.db'), '');
  const env = { PLEX_TOKEN: 'dummy-account-token' };

  const first = start(dataDir, env);
  assert.match(first.clientId, OWN_ID);
  assert.deepEqual({ setupComplete: first.setupComplete, downloadsEnabled: first.downloadsEnabled }, { setupComplete: true, downloadsEnabled: false });
  assert.equal(saved(dataDir).clientId, first.clientId);
  assert.equal(start(dataDir, env).clientId, first.clientId);
});

test('a settings file with no usable id is given one', () => {
  for (const missing of [undefined, null, '', '   ', 42]) {
    const dataDir = newDataDir();
    const settings = { ...OLD_INSTALL, clientId: missing };
    fs.writeFileSync(fileIn(dataDir), JSON.stringify(settings));
    const r = start(dataDir);
    assert.match(r.clientId, OWN_ID, JSON.stringify(missing));
    assert.equal(saved(dataDir).clientId, r.clientId);
  }
});

test('an id that is already the install\'s own is left alone', () => {
  for (const own of ['heldover-0b9f6c1e-7a51-4f0e-9d0b-3c1f5a2e8d47', 'plex-picker-2', 'my-own-id']) {
    const dataDir = newDataDir();
    fs.writeFileSync(fileIn(dataDir), JSON.stringify({ ...OLD_INSTALL, clientId: own }));
    assert.equal(start(dataDir).clientId, own);
    assert.equal(saved(dataDir).clientId, own);
  }
});
