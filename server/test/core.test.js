// Core behaviour that has broken silently before: the access PIN, couples
// swipe matching, and keeping one server's titles from being mistaken for
// another's. Runs against a throwaway data folder, never the real one.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'heldover-test-'));
process.env.DATA_DIR = dataDir;
delete process.env.PLEX_TOKEN;

// Imported only after DATA_DIR is set: the database opens on import.
const config = await import('../src/config.js');
const { accessGate } = await import('../src/setup-routes.js');
const auth = await import('../src/auth.js');
const swipe = await import('../src/swipe.js');
const { ratingsKeyFor } = await import('../src/ratings.js');
const { titleMatcher } = await import('../src/feedback.js');
const { normalizeTitle } = await import('../src/corpus-index.js');

test('a fresh install starts unconfigured, with downloads off and its own Plex device id', () => {
  assert.equal(config.isSetupComplete(), false);
  assert.equal(config.downloadsEnabled(), false);
  assert.match(config.getClientId(), /^heldover-[0-9a-f-]{36}$/);
  const mode = fs.statSync(path.join(dataDir, 'config.json')).mode & 0o777;
  assert.equal(mode, 0o600);
});

test('the PIN must be 6 to 12 digits and accepts only itself', () => {
  assert.throws(() => config.setPin('1234'), /6 to 12 digits/);
  config.setPin('246810');
  assert.equal(config.checkPin('246810'), true);
  assert.equal(config.checkPin('246811'), false);
  config.setPin(null);
  assert.equal(config.pinEnabled(), false);
});

test('the settings code is required to claim ownership, in any case and spacing', () => {
  const code = config.getOwnerCode();
  assert.match(code, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  assert.equal(config.checkOwnerCode(code.toLowerCase()), true);
  assert.equal(config.checkOwnerCode(code.replace('-', ' ')), true);
  assert.equal(config.checkOwnerCode('AAAA-AAAA'), code === 'AAAA-AAAA');
  assert.equal(config.checkOwnerCode({}), false);
});

// A stand-in for an Express request from a given address.
function fakeReq({ path: reqPath = '/profiles', address = '192.168.1.50', cookie, method = 'GET', host = '192.168.1.10:3001', origin } = {}) {
  return {
    path: reqPath,
    method,
    ip: address,
    socket: { remoteAddress: address },
    app: { get: () => false },
    headers: { cookie, host, ...(origin ? { origin } : {}) },
  };
}

function runMiddleware(fn, req) {
  let status = 200;
  let passed = false;
  const res = { status(code) { status = code; return this; }, json() { return this; }, setHeader() {} };
  fn(req, res, () => { passed = true; });
  return passed ? 'next' : status;
}

test('with a PIN set, other devices need a session; the computer running the app and ticketed routes do not', () => {
  config.setPin('135790');
  assert.equal(runMiddleware(accessGate, fakeReq()), 401);
  assert.equal(runMiddleware(accessGate, fakeReq({ path: '/image' })), 401);
  assert.equal(runMiddleware(accessGate, fakeReq({ address: '127.0.0.1' })), 'next');
  for (const open of ['/auth/status', '/tv/stream/a/1', '/tv/file/a/1', '/download/file/a/1/0', '/health/memory']) {
    assert.equal(runMiddleware(accessGate, fakeReq({ path: open })), 'next', open);
  }
  config.setPin(null);
  assert.equal(runMiddleware(accessGate, fakeReq()), 'next');
});

test('only the local computer or an owner session counts as the owner', () => {
  assert.equal(auth.isOwner(fakeReq({ address: '127.0.0.1' })), true);
  assert.equal(auth.isOwner(fakeReq({ address: '192.168.1.50' })), false);
  let cookieHeader = null;
  const res = { setHeader: (name, value) => { cookieHeader = value; } };
  auth.grantSession(fakeReq(), res, 'owner');
  const cookie = cookieHeader.split(';')[0];
  assert.equal(auth.isOwner(fakeReq({ cookie })), true);
  auth.grantSession(fakeReq(), res, 'viewer');
  const viewerCookie = cookieHeader.split(';')[0];
  assert.equal(auth.isOwner(fakeReq({ cookie: viewerCookie })), false);
  assert.notEqual(cookie, viewerCookie, 'every device gets its own session');
});

test('requests for foreign domains and cross-site state changes are refused', () => {
  const guard = auth.requestGuard;
  assert.equal(runMiddleware(guard, fakeReq({ host: 'heldover.local:3001' })), 'next');
  assert.equal(runMiddleware(guard, fakeReq({ host: 'nas:3001' })), 'next');
  assert.equal(runMiddleware(guard, fakeReq({ host: 'rebind.attacker.example:3001' })), 421);
  assert.equal(runMiddleware(guard, fakeReq({ method: 'POST', origin: 'http://192.168.1.10:3001' })), 'next');
  assert.equal(runMiddleware(guard, fakeReq({ method: 'POST', origin: 'http://192.168.1.10:9999' })), 403);
  assert.equal(runMiddleware(guard, fakeReq({ method: 'POST' })), 'next', 'no Origin header: not a browser page');
});

test('wrong guesses lock one address out without locking out the local computer', () => {
  const guesser = fakeReq({ address: '192.168.1.77' });
  for (let i = 0; i < 5; i++) auth.recordWrongGuess(guesser);
  assert.ok(auth.guessWait(guesser) > 0);
  assert.equal(auth.guessWait(fakeReq({ address: '127.0.0.1' })), 0);
});

test('two phones on the same profile still match, and only on the same card', () => {
  const pool = [
    { ratingKey: '5', serverKey: 'serverA', title: 'Alpha', year: 2001 },
    { ratingKey: '5', serverKey: 'serverB', title: 'Bravo', year: 2002 },
  ];
  const { code, deck } = swipe.createSession(pool, 2);
  const [first, second] = deck;
  assert.notEqual(first.cardKey, second.cardKey);

  swipe.recordVote({ code, voter: 'phone-one-aaaa', cardKey: first.cardKey, vote: 'yes' });
  let result = swipe.recordVote({ code, voter: 'phone-two-bbbb', cardKey: second.cardKey, vote: 'yes' });
  assert.equal(result.voters, 2);
  assert.equal(result.matches.length, 0, 'yes to different films with the same number is not a match');

  result = swipe.recordVote({ code, voter: 'phone-two-bbbb', cardKey: first.cardKey, vote: 'yes' });
  assert.equal(result.matches.length, 1);
  assert.equal(result.matches[0].title, first.title);

  assert.throws(() => swipe.recordVote({ code, voter: 'phone-one-aaaa', cardKey: 'nope:1', vote: 'yes' }), /not in this deck/);
});

test('a new round is linked from the old one', () => {
  const pool = [{ ratingKey: '1', serverKey: 's', title: 'One', year: 2000 }];
  const first = swipe.createSession(pool, 1);
  const next = swipe.createSession(pool, 1, first.code);
  assert.equal(swipe.getSession(first.code).nextCode, next.code);
});

test('ratings are filed per film, not per server number', () => {
  assert.notEqual(ratingsKeyFor('12345', 'Extraction II', 2023), ratingsKeyFor('12345', 'Million Dollar Island', 2023));
  assert.equal(ratingsKeyFor('7', 'Heat', 1995), '7|Heat|1995');
});

test('hiding a film does not hide a different film with the same number', () => {
  const hidden = titleMatcher([{ plex_key: '5', title: 'Alpha', year: 2001 }]);
  assert.equal(hidden.has({ ratingKey: '5', title: 'Alpha', year: 2001 }), true);
  assert.equal(hidden.has({ ratingKey: '5', title: 'Bravo', year: 2002 }), false);
  const legacy = titleMatcher([{ plex_key: '9', title: null, year: null }]);
  assert.equal(legacy.has({ ratingKey: '9', title: 'Anything', year: 1999 }), true);
});

test('title normalisation drops articles and punctuation', () => {
  assert.equal(normalizeTitle('The Lord of the Rings: The Two Towers'), 'lordofringstwotowers');
  assert.equal(normalizeTitle('互换真心'), '');
});
