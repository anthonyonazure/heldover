// Looking is open, changing is not: the rule that keeps a guest on the Wi-Fi
// from casting to the TV or editing the owner's Plex watchlist. Runs against a
// throwaway data folder.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'heldover-test-'));
delete process.env.PLEX_TOKEN;

const config = await import('../src/config.js');
const auth = await import('../src/auth.js');
const { changeGate, isChange } = await import('../src/change-gate.js');

function fakeReq({ path: reqPath = '/queue', address = '192.168.1.50', cookie, method = 'GET' } = {}) {
  return {
    path: reqPath,
    method,
    ip: address,
    socket: { remoteAddress: address },
    app: { get: () => false },
    headers: { cookie, host: '192.168.1.10:3001' },
  };
}

function run(req) {
  let status = 200;
  let body = null;
  let passed = false;
  const res = { status(code) { status = code; return this; }, json(value) { body = value; return this; }, setHeader() {} };
  changeGate(req, res, () => { passed = true; });
  return passed ? 'next' : { status, body };
}

/** The cookie a device holds after signing in as `kind`. */
function sessionCookie(kind) {
  let header = null;
  auth.grantSession(fakeReq(), { setHeader: (name, value) => { header = value; } }, kind);
  return header.split(';')[0];
}

test('reading is not a change; saving, playing and download links are', () => {
  for (const read of ['/queue', '/libraries', '/plex/sessions', '/tv/devices', '/download/file/a/1/0']) {
    assert.equal(isChange('GET', read), false, read);
  }
  for (const [method, changing] of [
    ['POST', '/queue'],
    ['DELETE', '/queue/5'],
    ['PUT', '/profiles/2'],
    ['POST', '/ratings/personal'],
    ['POST', '/plex/play'],
    ['POST', '/plex-watchlist/add'],
    ['POST', '/tv/play'],
    ['POST', '/tv/control'],
    ['POST', '/swipe/vote'],
    ['POST', '/cache/clear'],
    ['POST', '/download/gopeed'],
    ['GET', '/download-url/server/12'],
  ]) {
    assert.equal(isChange(method, changing), true, `${method} ${changing}`);
  }
});

test('questions sent as POST, sign-in and setup are left to their own rules', () => {
  for (const asks of ['/ask', '/voice/parse', '/availability/batch', '/library-match', '/status/check', '/auth/pin', '/auth/claim', '/setup/keys']) {
    assert.equal(isChange('POST', asks), false, asks);
  }
  assert.equal(isChange('POST', '/asking'), true, 'only the exact routes are exempt');
});

// Express delivers /DOWNLOAD-URL/x/12 and /download-url/x/12/ to the same route
// as the plain spelling, so the rule has to read them the same way. It did
// not: a look-only device asked for /DOWNLOAD-URL/... and was given links.
const spellingsOf = (plain) => {
  const mixed = plain.replace(/[a-z]+/g, (word, at) => (at % 2 ? word.toUpperCase() : word[0].toUpperCase() + word.slice(1)));
  return [plain.toUpperCase(), mixed, `${plain}/`, `${plain.toUpperCase()}/`, `${mixed}/`];
};

test('letter case and a slash at the end do not get a download link past the rule', () => {
  assert.equal(config.pinEnabled(), false);
  for (const spelling of ['/DOWNLOAD-URL/server/12', '/Download-Url/server/12', '/download-URL/server/12', ...spellingsOf('/download-url/server/12')]) {
    assert.equal(isChange('GET', spelling), true, spelling);
    const refused = run(fakeReq({ path: spelling }));
    assert.equal(refused.status, 403, spelling);
    assert.equal(refused.body.lookOnly, true, spelling);
  }
  // Not the route at all, so not a change: nothing answers at these.
  for (const other of ['/download-urls', '/download-url', '/downloads', '/']) {
    assert.equal(isChange('GET', other), false, other);
  }
});

test('every listed path is judged the same in any letter case, with or without a slash at the end', () => {
  // One real route for each entry of the two lists in change-gate.js.
  const asksOnly = ['/auth/pin', '/auth/claim', '/setup/keys', '/ask', '/voice/parse', '/availability/batch', '/library-match', '/status/check'];
  for (const plain of asksOnly) {
    assert.equal(run(fakeReq({ path: plain, method: 'POST' })), 'next', plain);
    for (const spelling of spellingsOf(plain)) {
      assert.equal(isChange('POST', spelling), false, spelling);
      assert.equal(run(fakeReq({ path: spelling, method: 'POST' })), 'next', spelling);
    }
  }
  // The exemptions stay exact: a longer or doubled path is still a change.
  for (const notListed of ['/asking', '/ASKING/', '/ask//', '/ask/more', '/voice/parse/x', '/authx/pin', '/status/check/now']) {
    assert.equal(isChange('POST', notListed), true, notListed);
    assert.equal(run(fakeReq({ path: notListed, method: 'POST' })).status, 403, notListed);
  }
  // And an ordinary change stays one however it is spelled.
  for (const spelling of spellingsOf('/queue')) {
    assert.equal(run(fakeReq({ path: spelling, method: 'POST' })).status, 403, spelling);
    assert.equal(run(fakeReq({ path: spelling, method: 'GET' })), 'next', spelling);
  }
});

test('with no PIN, another device can look but not change; the owner can do both', () => {
  assert.equal(config.pinEnabled(), false);
  assert.equal(run(fakeReq()), 'next');

  const blocked = run(fakeReq({ method: 'POST' }));
  assert.equal(blocked.status, 403);
  assert.equal(blocked.body.lookOnly, true);
  assert.equal(run(fakeReq({ path: '/download-url/server/12' })).status, 403);

  assert.equal(run(fakeReq({ method: 'POST', address: '127.0.0.1' })), 'next', 'the computer the app runs on');
  assert.equal(run(fakeReq({ method: 'POST', cookie: sessionCookie('owner') })), 'next', 'a device that entered the settings code');
});

test('a PIN session may change things only while a PIN is set', () => {
  config.setPin('135790');
  const cookie = sessionCookie('viewer');
  assert.equal(auth.canChange(fakeReq({ cookie })), true);
  assert.equal(run(fakeReq({ method: 'POST', cookie })), 'next');
  assert.equal(run(fakeReq({ method: 'POST' })).status, 403, 'no session at all');

  // RESET_PIN=1 removes the PIN without clearing sessions: the leftover
  // session must not keep its rights.
  config.setPin(null);
  assert.equal(auth.canChange(fakeReq({ cookie })), false);
  assert.equal(run(fakeReq({ method: 'POST', cookie })).status, 403);
});
