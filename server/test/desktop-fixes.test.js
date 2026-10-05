// The go-public desktop fixes: the server listens where it is told to, the
// desktop app's "let phones connect" switch is owner-only and off by default,
// the settings code is shown only on the computer the app runs on, and a
// container on a Docker bridge network does not advertise its private address.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import fs from 'fs';
import os from 'os';
import path from 'path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'heldover-test-'));
delete process.env.PLEX_TOKEN;
delete process.env.PLEX_PICKER_DESKTOP;
delete process.env.BIND_HOST;

// Imported only after DATA_DIR is set: the database opens on import.
const config = await import('../src/config.js');
const auth = await import('../src/auth.js');
const { registerSetupRoutes } = await import('../src/setup-routes.js');
const listen = await import('../src/listen-address.js');

// ---------- BIND_HOST ----------

const envCheck = fileURLToPath(new URL('../src/env-check.js', import.meta.url));
const listenAddress = fileURLToPath(new URL('../src/listen-address.js', import.meta.url));
/**
 * What a start makes of one BIND_HOST value: whether the check let startup go
 * on, the value it left behind, and the address the server would listen on.
 * `started` is false when the check ended the process.
 */
function bindHostAfterCheck(value) {
  const script = `
    await import(${JSON.stringify(envCheck)});
    const { bindHost } = await import(${JSON.stringify(listenAddress)});
    console.log('RESULT ' + JSON.stringify({ BIND_HOST: process.env.BIND_HOST, listensOn: bindHost() }));
  `;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { PATH: process.env.PATH, BIND_HOST: value },
    encoding: 'utf8',
  });
  const line = r.stdout.split('\n').find((l) => l.startsWith('RESULT '));
  const result = line ? JSON.parse(line.slice(7)) : null;
  return { status: r.status, started: result !== null, value: result?.BIND_HOST, listensOn: result?.listensOn, err: r.stderr };
}

test('BIND_HOST accepts an IP address, with stray spaces removed', () => {
  assert.deepEqual(bindHostAfterCheck('127.0.0.1'), { status: 0, started: true, value: '127.0.0.1', listensOn: '127.0.0.1', err: '' });
  assert.deepEqual(bindHostAfterCheck(' 0.0.0.0 '), { status: 0, started: true, value: '0.0.0.0', listensOn: '0.0.0.0', err: '' });
  assert.deepEqual(bindHostAfterCheck('::1'), { status: 0, started: true, value: '::1', listensOn: '::1', err: '' });
});

test('BIND_HOST=localhost means this computer only, and only spaces means not set', () => {
  for (const spelling of ['localhost', 'LOCALHOST', ' localhost ']) {
    assert.deepEqual(bindHostAfterCheck(spelling), { status: 0, started: true, value: '127.0.0.1', listensOn: '127.0.0.1', err: '' }, spelling);
  }
  for (const blank of ['', '   ']) {
    assert.deepEqual(bindHostAfterCheck(blank), { status: 0, started: true, value: undefined, listensOn: '0.0.0.0', err: '' }, JSON.stringify(blank));
  }
});

test('a BIND_HOST that cannot be used stops startup; it never falls back to every adapter', () => {
  // Each of these is someone trying to keep the app off the network, or a
  // typing mistake. They used to be dropped with a warning, and the server
  // then listened on 0.0.0.0: every device on the network.
  for (const bad of ['127.0.0.1:3001', '"127.0.0.1"', 'yes', '192.168.1', '999.1.1.1', 'localhost:3001', 'my-computer.local', 'http://127.0.0.1']) {
    const r = bindHostAfterCheck(bad);
    assert.equal(r.started, false, `${bad}: startup did not go on`);
    assert.notEqual(r.status, 0, bad);
    assert.equal(r.listensOn, undefined, bad);
    assert.match(r.err, /BIND_HOST=.* is not an IP address/, bad);
    assert.match(r.err, /will not start/, bad);
  }
});

test('with no BIND_HOST the server listens on every adapter; 127.x and ::1 mean this computer only', () => {
  assert.equal(listen.bindHost(), '0.0.0.0');
  assert.equal(listen.isLoopbackHost('127.0.0.1'), true);
  assert.equal(listen.isLoopbackHost('::1'), true);
  assert.equal(listen.isLoopbackHost('0.0.0.0'), false);
  assert.equal(listen.isLoopbackHost('192.168.1.10'), false);
});

// ---------- Docker bridge networks ----------

test('a container on a Docker bridge network is recognized, so its private address is not advertised', () => {
  const bridge = (interfaces, inContainer = true) => listen.onDockerBridge({ inContainer, interfaces });
  // The default bridge, and a network made by docker compose.
  assert.equal(bridge([{ name: 'eth0', address: '172.17.0.2' }]), true);
  assert.equal(bridge([{ name: 'eth0', address: '172.18.0.3' }, { name: 'eth1', address: '172.31.0.4' }]), true);
});

test('host networking, and anything outside a container, still prints real addresses', () => {
  const bridge = (interfaces, inContainer = true) => listen.onDockerBridge({ inContainer, interfaces });
  // Host networking: the host's own adapters are visible, Docker's bridge among them.
  assert.equal(bridge([{ name: 'eth0', address: '192.168.1.20' }, { name: 'docker0', address: '172.17.0.1' }]), false);
  assert.equal(bridge([{ name: 'enp3s0', address: '10.0.0.5' }]), false);
  // A home network that itself uses 172.16 to 172.31, with host networking.
  assert.equal(bridge([{ name: 'eth0', address: '172.20.1.15' }, { name: 'docker0', address: '172.17.0.1' }]), false);
  assert.equal(bridge([{ name: 'eth0', address: '172.20.1.15' }, { name: 'br-3f2a9c1d0b7e', address: '172.19.0.1' }]), false);
  // Just outside the range on either side.
  assert.equal(bridge([{ name: 'eth0', address: '172.15.0.2' }]), false);
  assert.equal(bridge([{ name: 'eth0', address: '172.32.0.2' }]), false);
  // Not a container at all: a laptop on a 172.x network.
  assert.equal(bridge([{ name: 'en0', address: '172.17.0.2' }], false), false);
  // No network yet.
  assert.equal(bridge([]), false);
});

// ---------- Routes ----------
//
// The real handlers, collected from a stand-in for the Express app and run
// against stand-in requests, so nothing has to listen on a port.

const routes = {};
const collect = (method) => (routePath, ...handlers) => { routes[`${method} ${routePath}`] = handlers; };
registerSetupRoutes(
  { get: collect('GET'), post: collect('POST') },
  { onPlexConnected() {}, onKeysChanged() {} }
);

function fakeReq({ address = '192.168.1.50', cookie, body } = {}) {
  return {
    path: '/setup',
    method: 'POST',
    ip: address,
    socket: { remoteAddress: address },
    app: { get: () => false },
    headers: { cookie, host: '192.168.1.10:3001' },
    body,
  };
}

/** Runs a route's handlers in order, as Express would, and reports the answer. */
async function call(route, req) {
  const answer = { status: 200, body: undefined, afterSend: [] };
  const res = {
    status(code) { answer.status = code; return this; },
    json(body) { answer.body = body; return this; },
    setHeader() {},
    on(event, fn) { if (event === 'finish') answer.afterSend.push(fn); },
  };
  for (const handler of routes[route]) {
    let passed = false;
    await handler(req, res, () => { passed = true; });
    if (!passed) break;
  }
  return answer;
}

/** A cookie for a device that has entered the settings code. */
function ownerCookie() {
  let header = null;
  auth.grantSession(fakeReq(), { setHeader: (name, value) => { header = value; } }, 'owner');
  return header.split(';')[0];
}

test('the settings code is shown to the computer the app runs on, and to nobody else', async () => {
  const local = await call('GET /api/setup/status', fakeReq({ address: '127.0.0.1' }));
  assert.equal(local.status, 200);
  assert.equal(local.body.ownerCode, config.getOwnerCode());

  const stranger = await call('GET /api/setup/status', fakeReq());
  assert.equal(stranger.status, 403);
  assert.equal(stranger.body.ownerCode, undefined);

  // An owner on another device may see the settings, but never the code.
  const remoteOwner = await call('GET /api/setup/status', fakeReq({ cookie: ownerCookie() }));
  assert.equal(remoteOwner.status, 200);
  assert.equal(remoteOwner.body.isLocal, false);
  assert.equal('ownerCode' in JSON.parse(JSON.stringify(remoteOwner.body)), false);
  assert.doesNotMatch(JSON.stringify(remoteOwner.body), new RegExp(config.getOwnerCode()));

  // Nor a visitor who arrives through a proxy on this computer.
  const proxied = fakeReq({ address: '127.0.0.1', cookie: ownerCookie() });
  proxied.headers['x-forwarded-for'] = '203.0.113.9';
  const throughProxy = await call('GET /api/setup/status', proxied);
  assert.equal(throughProxy.status, 200);
  assert.equal(JSON.parse(JSON.stringify(throughProxy.body)).ownerCode, undefined);
});

test('the status says whether this is the desktop app and whether other devices may connect', async () => {
  const plain = await call('GET /api/setup/status', fakeReq({ address: '127.0.0.1' }));
  assert.equal(plain.body.desktop, false);
  assert.equal(plain.body.lanAccess, false);
  assert.deepEqual(plain.body.lanUrls, []);

  process.env.PLEX_PICKER_DESKTOP = '1';
  listen.setLanUrls(['http://heldover.local:39847', 'http://192.168.1.10:39847']);
  try {
    const desktop = await call('GET /api/setup/status', fakeReq({ address: '127.0.0.1' }));
    assert.equal(desktop.body.desktop, true);
    assert.deepEqual(desktop.body.lanUrls, ['http://heldover.local:39847', 'http://192.168.1.10:39847']);
  } finally {
    delete process.env.PLEX_PICKER_DESKTOP;
    listen.setLanUrls([]);
  }
});

test('"let other devices connect" is off on a new install and only the owner can change it', async () => {
  assert.equal(config.lanAccessEnabled(), false);
  process.env.PLEX_PICKER_DESKTOP = '1';
  try {
    const stranger = await call('POST /api/setup/lan-access', fakeReq({ body: { enabled: true } }));
    assert.equal(stranger.status, 403);
    assert.equal(config.lanAccessEnabled(), false);
  } finally {
    delete process.env.PLEX_PICKER_DESKTOP;
  }
});

test('the switch takes true or false and nothing else', async () => {
  process.env.PLEX_PICKER_DESKTOP = '1';
  try {
    for (const body of [undefined, {}, { enabled: 'true' }, { enabled: 1 }, { enabled: null }]) {
      const r = await call('POST /api/setup/lan-access', fakeReq({ address: '127.0.0.1', body }));
      assert.equal(r.status, 400, JSON.stringify(body));
      assert.equal(config.lanAccessEnabled(), false);
    }
  } finally {
    delete process.env.PLEX_PICKER_DESKTOP;
  }
});

test('outside the desktop app the switch is refused and points at BIND_HOST', async () => {
  const r = await call('POST /api/setup/lan-access', fakeReq({ address: '127.0.0.1', body: { enabled: true } }));
  assert.equal(r.status, 400);
  assert.match(r.body.error, /BIND_HOST/);
  assert.equal(config.lanAccessEnabled(), false);
});

test('in the desktop app the switch is saved, and the app is asked to restart only after the answer has gone out', async () => {
  const sent = [];
  const realSend = process.send;
  process.env.PLEX_PICKER_DESKTOP = '1';
  process.env.BIND_HOST = '127.0.0.1'; // how the desktop app starts the server while the switch is off
  process.send = (message) => sent.push(message);
  try {
    const on = await call('POST /api/setup/lan-access', fakeReq({ address: '127.0.0.1', body: { enabled: true } }));
    assert.equal(on.status, 200);
    assert.deepEqual(on.body, { ok: true, lanAccess: true, restartRequired: true });
    assert.equal(config.lanAccessEnabled(), true);
    const saved = JSON.parse(fs.readFileSync(path.join(process.env.DATA_DIR, 'config.json'), 'utf8'));
    assert.equal(saved.lanAccess, true, 'the desktop app reads this file before it starts the server');
    assert.deepEqual(sent, [], 'nothing is sent before the answer is flushed');
    on.afterSend.forEach((fn) => fn());
    assert.deepEqual(sent, [{ type: 'restart-server' }]);

    // Already listening the way that was asked for: saved, no restart.
    const off = await call('POST /api/setup/lan-access', fakeReq({ address: '127.0.0.1', body: { enabled: false } }));
    assert.deepEqual(off.body, { ok: true, lanAccess: false, restartRequired: false });
    assert.equal(off.afterSend.length, 0);
    assert.equal(config.lanAccessEnabled(), false);
  } finally {
    process.send = realSend;
    delete process.env.PLEX_PICKER_DESKTOP;
    delete process.env.BIND_HOST;
  }
});
