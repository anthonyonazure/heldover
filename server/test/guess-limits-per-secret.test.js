// Wrong tries at the PIN are limited twice: five from one address and it
// waits five minutes, and twenty from anywhere in fifteen minutes pause PIN
// entry for everyone, so a device that keeps changing its address gains
// nothing. That pause is on purpose and stays.
//
// What was wrong: the settings code shared those counts. Twenty wrong PIN
// tries from two devices also paused the settings code, which is how the
// owner signs in from another device, so a guest mistyping a PIN could keep
// the owner out. And a device that knew the PIN could wipe its own wrong
// tries at the settings code by entering the PIN in between.
//
// Asked of the real app over this computer's loopback. The other devices are
// told apart the way a reverse proxy on this computer would report them
// (TRUST_PROXY=1 and the address it forwards). Waiting is done by moving the
// clock. Dummy PIN, throwaway data folder, no network.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'heldover-test-'));
process.env.DISABLE_MDNS = '1';
process.env.TRUST_PROXY = '1';
delete process.env.PLEX_TOKEN;
globalThis.fetch = async () => { throw new Error('fetch failed (the tests use no network)'); };

const logged = [];
const realLog = console.log;
console.log = (...args) => {
  logged.push(args.join(' '));
};

// Imported only after DATA_DIR is set: the database opens on import.
const config = await import('../src/config.js');
const auth = await import('../src/auth.js');
const { app } = await import('../src/app.js');

const PIN = '135790';
config.setPin(PIN);
const CODE = config.getOwnerCode();

const listener = await new Promise((resolve) => {
  const s = app.listen(0, '127.0.0.1', () => resolve(s));
});
const realNow = Date.now;
after(() => {
  listener.close();
  Date.now = realNow;
  console.log = realLog;
});
const { port } = listener.address();

/** One request from the device at `address`, or from this computer when there is none. */
function call(method, reqPath, body, address, cookie) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method,
        path: reqPath,
        headers: {
          ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
          ...(address ? { 'X-Forwarded-For': address } : {}),
          ...(cookie ? { Cookie: cookie } : {}),
        },
      },
      (res) => {
        let text = '';
        res.on('data', (chunk) => { text += chunk; });
        res.on('end', () => {
          let json = null;
          try { json = JSON.parse(text); } catch { /* not JSON */ }
          resolve({ status: res.statusCode, body: json, cookie: String((res.headers['set-cookie'] || [''])[0]).split(';')[0] });
        });
      }
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

const tryPin = (address, pin) => call('POST', '/api/auth/pin', { pin }, address);
const tryCode = (address, code) => call('POST', '/api/auth/claim', { code }, address);
const status = async (address, cookie) => (await call('GET', '/api/auth/status', undefined, address, cookie)).body;
const device = (n) => `192.168.1.${n}`;

/** Five tries from each of these devices; the statuses seen, each once. */
async function fiveEach(devices, guess) {
  const seen = new Set();
  for (const n of devices) {
    for (let i = 0; i < 5; i++) seen.add((await guess(device(n))).status);
  }
  return [...seen];
}

let skipped = 0;
function wait(minutes) {
  skipped += minutes * 60 * 1000 + 1000;
  Date.now = () => realNow() + skipped;
}

// Signed in before any wrong try, to see what a pause does to devices that
// are already in.
const viewer = await tryPin(device(201), PIN);
const owner = await tryCode(device(202), CODE);

test('before any wrong try, the PIN and the settings code are accepted from other devices', async () => {
  assert.equal(viewer.status, 200);
  assert.equal(owner.status, 200);
  assert.equal((await status(device(202), owner.cookie)).isOwner, true);
});

test('twenty wrong PIN tries from four devices still pause PIN entry for every other device, the right PIN included', async () => {
  assert.deepEqual(await fiveEach([11, 12, 13], (address) => tryPin(address, '000000')), [401]);
  assert.equal((await tryPin(device(20), PIN)).status, 200, 'fifteen wrong tries are not yet a pause');
  assert.deepEqual(await fiveEach([14], (address) => tryPin(address, '000000')), [401]);

  const refused = await tryPin(device(21), PIN);
  assert.equal(refused.status, 429);
  assert.match(refused.body.error, /Too many wrong tries\. Try again in \d+ seconds\./);
  assert.equal((await status(device(21))).signedIn, false);
  // The computer Heldover runs on is never held up.
  assert.equal((await tryPin(undefined, PIN)).status, 200);
  // Devices that were already in stay in.
  assert.equal((await status(device(201), viewer.cookie)).signedIn, true);
  assert.equal((await status(device(202), owner.cookie)).isOwner, true);
});

test('while PIN entry is paused, the owner can still sign in on another device with the settings code', async () => {
  assert.equal((await tryPin(device(22), PIN)).status, 429, 'PIN entry is still paused');
  const claimed = await tryCode(device(23), CODE);
  assert.equal(claimed.status, 200);
  assert.equal((await status(device(23), claimed.cookie)).isOwner, true);
  // A wrong code during the PIN pause is simply wrong, not "wait".
  assert.equal((await tryCode(device(24), 'AAAA-AAAA')).status, 401);
});

test('five wrong settings codes make that device wait five minutes, the right code included, and no other device', async () => {
  assert.deepEqual(await fiveEach([31], (address) => tryCode(address, 'AAAA-AAAA')), [401]);
  const refused = await tryCode(device(31), CODE);
  assert.equal(refused.status, 429);
  assert.match(refused.body.error, /Too many wrong tries\. Try again in \d+ seconds\./);
  assert.equal((await tryCode(device(32), CODE)).status, 200);
  wait(5);
  assert.equal((await tryCode(device(31), CODE)).status, 200);
});

test('fifteen minutes after it began, the PIN pause is over', async () => {
  wait(15);
  assert.equal((await tryPin(device(21), PIN)).status, 200);
});

test('a device that knows the PIN cannot use it to wipe its wrong tries at the settings code', async () => {
  const address = device(41);
  for (let i = 0; i < 4; i++) assert.equal((await tryCode(address, 'AAAA-AAAA')).status, 401);
  assert.equal((await tryPin(address, PIN)).status, 200);
  // The fifth wrong code is still the fifth: the wait starts.
  assert.equal((await tryCode(address, 'AAAA-AAAA')).status, 401);
  assert.equal((await tryCode(address, CODE)).status, 429);
});

test('wrong settings codes from a few devices do not pause PIN entry, or the settings code for other devices', async () => {
  // Twenty-five wrong codes from five devices: more than the twenty that
  // pause PIN entry when they are wrong PINs.
  assert.deepEqual(await fiveEach([51, 52, 53, 54, 55], (address) => tryCode(address, 'AAAA-AAAA')), [401]);
  assert.equal((await tryPin(device(61), PIN)).status, 200);
  assert.equal((await tryCode(device(62), CODE)).status, 200);
});

// A stand-in for an Express request from a given address, for counting many
// wrong tries without sending each one.
const fakeReq = (address) => ({ ip: address, socket: { remoteAddress: address }, headers: {} });

test('the settings code keeps an overall limit, a larger one: 300 wrong tries in fifteen minutes pause it for every other device', async () => {
  wait(15); // an empty count to start from
  // As the route does it: ask whether a guess is allowed, then count it.
  const wrongCode = (address) => {
    assert.equal(auth.guessWait(fakeReq(address), 'code'), 0);
    auth.recordWrongGuess(fakeReq(address), 'code');
  };
  for (let n = 1; n <= 59; n++) {
    for (let i = 0; i < 5; i++) wrongCode(`10.0.0.${n}`);
  }
  assert.equal(auth.guessWait(fakeReq('10.0.1.1'), 'code'), 0, '295 wrong tries are not yet a pause');
  assert.equal((await tryCode(device(71), CODE)).status, 200);

  for (let i = 0; i < 5; i++) wrongCode('10.0.0.60');
  const seconds = auth.guessWait(fakeReq('10.0.1.1'), 'code');
  assert.ok(seconds > 890 && seconds <= 900, `${seconds} seconds`);
  assert.equal((await tryCode(device(72), CODE)).status, 429);
  // Not the PIN, and never the computer Heldover runs on.
  assert.equal(auth.guessWait(fakeReq('10.0.1.1')), 0);
  assert.equal((await tryPin(device(73), PIN)).status, 200);
  assert.equal((await tryCode(undefined, CODE)).status, 200);

  wait(15);
  assert.equal((await tryCode(device(72), CODE)).status, 200);
});

test('a guess helper called the old way, without naming the secret, is counted with the PINs', () => {
  wait(15);
  const guesser = fakeReq('10.0.2.1');
  for (let i = 0; i < 5; i++) auth.recordWrongGuess(guesser);
  assert.ok(auth.guessWait(guesser) > 0);
  assert.ok(auth.guessWait(guesser, 'pin') > 0);
  assert.ok(auth.guessWait(guesser, 'no-such-secret') > 0, 'an unknown name gets the strict counts');
  assert.equal(auth.guessWait(guesser, 'code'), 0);
  auth.recordRightGuess(guesser);
  assert.equal(auth.guessWait(guesser), 0);
});

test('the log says when a pause starts, once for each', () => {
  const pauses = logged.filter((line) => line.startsWith('[access]') && /is paused for 15 minutes/.test(line));
  assert.equal(pauses.length, 2, pauses.join('\n'));
  assert.match(pauses[0], /^\[access\] 20 wrong PIN tries in 15 minutes: entering the PIN is paused/);
  assert.match(pauses[1], /^\[access\] 300 wrong settings code tries in 15 minutes: entering the settings code is paused/);
  // Neither secret is ever written to the log.
  assert.ok(!logged.some((line) => line.includes(PIN) || line.includes(CODE)));
});
