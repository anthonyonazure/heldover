// A published view can be locked with an edit PIN, so that only someone who
// knows it can change or delete the view. The PIN could be guessed without
// limit (a four-digit one in seconds), was accepted in the address, where logs
// and history keep it, and was stored as typed.
//
// Asked of the real app over this computer's loopback, as a second device that
// has entered the access PIN: the kind of device the edit PIN is meant to hold
// back. Dummy views and dummy PINs, throwaway data folder, no network.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'heldover-test-'));
process.env.DATA_DIR = dataDir;
delete process.env.PLEX_TOKEN;
delete process.env.TRUST_PROXY;
globalThis.fetch = async () => { throw new Error('fetch failed (the tests use no network)'); };

// Imported only after DATA_DIR is set: the database opens on import.
const config = await import('../src/config.js');
const { app } = await import('../src/app.js');
await import('../src/routes/moods-curated.js');

const listener = await new Promise((resolve) => {
  const s = app.listen(0, '127.0.0.1', () => resolve(s));
});
const peek = new Database(path.join(dataDir, 'ratings.db'));
after(() => {
  listener.close();
  peek.close();
});
const { port } = listener.address();

function call(method, reqPath, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method,
        path: reqPath,
        headers: { ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}), ...headers },
      },
      (res) => {
        let text = '';
        res.on('data', (chunk) => { text += chunk; });
        res.on('end', () => {
          let json = null;
          try { json = JSON.parse(text); } catch { /* not JSON */ }
          resolve({ status: res.statusCode, body: json, text, headers: res.headers });
        });
      }
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// A request that says it was forwarded is never "this computer" to auth.js,
// so these are handled like requests from another device on the Wi-Fi. It
// enters the access PIN once, which is what lets it change anything at all.
const APP_PIN = '135790';
config.setPin(APP_PIN);
const OTHER_DEVICE = { forwarded: 'for=192.168.1.77' };
const signIn = await call('POST', '/api/auth/pin', { pin: APP_PIN }, OTHER_DEVICE);
const cookie = String((signIn.headers['set-cookie'] || [''])[0]).split(';')[0];
const device = (method, reqPath, body) => call(method, reqPath, body, { ...OTHER_DEVICE, Cookie: cookie });

const EDIT_PIN = '7305';
const storedPin = (slug) => peek.prepare('SELECT edit_pin FROM curated_views WHERE slug = ?').get(slug)?.edit_pin;
const nameOf = async (slug) => (await device('GET', `/api/views/${slug}`)).body?.view?.name;

async function publish(name, editPin) {
  const made = await device('POST', '/api/views', { name, filters: { genres: ['Drama'] }, serverKey: 'srvA', libraryKey: '1', editPin });
  assert.equal(made.status, 201);
  return made;
}

test('the second device may change things but is not the owner', async () => {
  const who = (await device('GET', '/api/auth/status')).body;
  assert.deepEqual({ signedIn: who.signedIn, canChange: who.canChange, isOwner: who.isOwner }, { signedIn: true, canChange: true, isOwner: false });
});

test('a new edit PIN needs four or more characters, and is stored hashed, never as typed', async () => {
  for (const short of ['1', '123', 'abc', 7, false]) {
    const refused = await device('POST', '/api/views', { name: 'Too short', editPin: short });
    assert.equal(refused.status, 400, JSON.stringify(short));
    assert.match(refused.body.error, /4 or more characters/);
  }
  assert.equal(peek.prepare("SELECT COUNT(*) AS n FROM curated_views WHERE name = 'Too short'").get().n, 0);

  const made = await publish('Locked view', EDIT_PIN);
  assert.equal(made.body.view.has_pin, true);
  assert.equal(made.text.includes(EDIT_PIN), false, 'the answer does not repeat the PIN');
  const stored = storedPin(made.body.view.slug);
  assert.match(stored, /^scrypt\$[0-9a-f]{32}\$[0-9a-f]{64}$/);
  assert.equal(stored.includes(EDIT_PIN), false);

  // Two views with the same PIN do not share a stored value.
  const twin = await publish('Locked twin', EDIT_PIN);
  assert.notEqual(storedPin(twin.body.view.slug), stored);

  // No PIN is still allowed, and such a view is open to edit.
  const open = await publish('Open view');
  assert.equal(open.body.view.has_pin, false);
  assert.equal(storedPin(open.body.view.slug), null);
  assert.equal((await device('PUT', `/api/views/${open.body.view.slug}`, { name: 'Open view, renamed' })).status, 200);
});

test('the edit PIN is read from the body only: in the address it is refused, right or wrong', async () => {
  const { slug } = (await publish('Body only', EDIT_PIN)).body.view;
  for (const [method, address] of [
    ['DELETE', `/api/views/${slug}?editPin=${EDIT_PIN}`],
    ['DELETE', `/api/views/${slug}?editPin=0000`],
    ['PUT', `/api/views/${slug}?editPin=${EDIT_PIN}`],
  ]) {
    const refused = await device(method, address, method === 'PUT' ? { name: 'tampered' } : undefined);
    assert.equal(refused.status, 400, `${method} with the PIN in the address`);
    assert.match(refused.body.error, /in the body/);
  }
  assert.equal(await nameOf(slug), 'Body only', 'still there, unchanged');

  // Even with the right PIN in the body as well, the address form is not accepted.
  assert.equal((await device('DELETE', `/api/views/${slug}?editPin=${EDIT_PIN}`, { editPin: EDIT_PIN })).status, 400);
  // In the body alone, it works.
  assert.equal((await device('DELETE', `/api/views/${slug}`, { editPin: EDIT_PIN })).status, 200);
  assert.equal((await device('GET', `/api/views/${slug}`)).status, 404);
});

test('a locked view cannot be changed or deleted without its PIN, and can with it', async () => {
  const { slug } = (await publish('Family picks', EDIT_PIN)).body.view;
  for (const attempt of [() => device('PUT', `/api/views/${slug}`, { name: 'x' }), () => device('DELETE', `/api/views/${slug}`)]) {
    const refused = await attempt();
    assert.equal(refused.status, 403);
    assert.equal(refused.body.editPinRequired, true);
  }
  assert.equal(await nameOf(slug), 'Family picks');

  const renamed = await device('PUT', `/api/views/${slug}`, { name: 'Family picks, renamed', editPin: EDIT_PIN });
  assert.equal(renamed.status, 200);
  assert.equal(renamed.body.view.name, 'Family picks, renamed');
  assert.equal(renamed.text.includes('scrypt'), false, 'the stored PIN is never sent out');
});

test('a view locked before PINs were hashed still opens with its PIN, which is then stored hashed', async () => {
  // As the table held it before: the PIN as typed, and shorter than a new one may be.
  peek.prepare(
    "INSERT INTO curated_views (slug, name, filters_json, server_key, library_key, edit_pin) VALUES ('legacy01', 'Old view', '{}', 'srvA', '1', '42')"
  ).run();

  assert.equal((await device('PUT', '/api/views/legacy01', { name: 'tampered', editPin: '43' })).status, 403);
  assert.equal(storedPin('legacy01'), '42', 'a wrong guess changes nothing');

  const first = await device('PUT', '/api/views/legacy01', { name: 'Old view, renamed', editPin: '42' });
  assert.equal(first.status, 200);
  assert.match(storedPin('legacy01'), /^scrypt\$[0-9a-f]{32}\$[0-9a-f]{64}$/);

  assert.equal((await device('PUT', '/api/views/legacy01', { name: 'tampered', editPin: '43' })).status, 403);
  assert.equal((await device('DELETE', '/api/views/legacy01', { editPin: '42' })).status, 200);
});

test('the computer the app runs on is never locked out, so the owner always has a way in', async () => {
  const { slug } = (await publish('At the computer', EDIT_PIN)).body.view;
  // No forwarding header: this is the computer itself. It still needs the PIN.
  const statuses = [];
  for (const guess of ['0000', '0001', '1111', '2222', '3333', '4444', '5555']) {
    statuses.push((await call('PUT', `/api/views/${slug}`, { name: 'tampered', editPin: guess })).status);
  }
  assert.deepEqual(statuses, [403, 403, 403, 403, 403, 403, 403]);
  assert.equal((await call('PUT', `/api/views/${slug}`, { name: 'Renamed at the computer', editPin: EDIT_PIN })).status, 200);
});

// Last, because it leaves this address locked out until its right guess.
test('wrong guesses are limited: after five the device must wait, and then the right PIN works again', async () => {
  const { slug } = (await publish('Guess me', EDIT_PIN)).body.view;
  const open = (await publish('Not locked')).body.view.slug;

  const statuses = [];
  for (const guess of ['0000', '0001', '1111', '2222', '3333']) {
    statuses.push((await device('PUT', `/api/views/${slug}`, { name: 'tampered', editPin: guess })).status);
  }
  assert.deepEqual(statuses, [403, 403, 403, 403, 403]);

  // Locked out: more guesses are turned away unread, and so is the right PIN.
  const sixth = await device('PUT', `/api/views/${slug}`, { name: 'tampered', editPin: '4444' });
  assert.equal(sixth.status, 429);
  assert.match(sixth.body.error, /Too many wrong tries\. Try again in \d+ seconds\./);
  assert.equal((await device('PUT', `/api/views/${slug}`, { name: 'tampered', editPin: EDIT_PIN })).status, 429);
  assert.equal((await device('DELETE', `/api/views/${slug}`, { editPin: EDIT_PIN })).status, 429);
  assert.equal(await nameOf(slug), 'Guess me', 'nothing was changed while locked out');

  // The wait is for guessing only: a view with no PIN is not held up by it.
  assert.equal((await device('PUT', `/api/views/${open}`, { name: 'Not locked, renamed' })).status, 200);
  assert.equal((await device('PUT', `/api/views/${slug}`, { name: 'tampered', editPin: EDIT_PIN })).status, 429, 'still waiting');

  // Five minutes later the right PIN is accepted.
  const realNow = Date.now;
  Date.now = () => realNow() + 5 * 60 * 1000 + 1000;
  try {
    const renamed = await device('PUT', `/api/views/${slug}`, { name: 'Renamed after the wait', editPin: EDIT_PIN });
    assert.equal(renamed.status, 200);
    assert.equal(renamed.body.view.name, 'Renamed after the wait');
    assert.equal((await device('DELETE', `/api/views/${slug}`, { editPin: EDIT_PIN })).status, 200);
    assert.equal((await device('GET', `/api/views/${slug}`)).status, 404);
  } finally {
    Date.now = realNow;
  }
});
