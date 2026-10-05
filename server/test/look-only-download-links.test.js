// A look-only device gets no download link, however it spells the address.
//
// Asked of the real app over this computer's own loopback, because the hole
// was a disagreement between two readers of the same path: the look-only rule
// compared it as the device spelled it, and Express routed /DOWNLOAD-URL/...
// to the download-link route all the same. plex.tv and the Plex servers are
// stand-ins inside this process; nothing outside it is contacted and no link
// that comes back is opened. Runs against a throwaway data folder.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'heldover-test-'));
process.env.PLEX_TOKEN = 'dummy-account-token';
// The stand-in servers here are plain http on this computer. A listed plain
// http address is used only when the owner has asked for that.
process.env.PLEX_ALLOW_HTTP = '1';
delete process.env.TRUST_PROXY;

// ---------- Stand-ins for plex.tv and two Plex servers ----------

const FIXTURES = {
  SHARED: { uri: 'http://shared.fixture.invalid:32400', owned: false },
  OWNED: { uri: 'http://owned.fixture.invalid:32400', owned: true },
};
const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

globalThis.fetch = async (input) => {
  const bare = String(typeof input === 'string' ? input : input?.url || input).split('?')[0];
  if (bare === 'https://plex.tv/api/v2/resources') {
    return json(
      Object.entries(FIXTURES).map(([id, f]) => ({
        name: `Fixture ${id}`,
        clientIdentifier: id,
        provides: 'server',
        owned: f.owned,
        presence: true,
        accessToken: f.owned ? undefined : `dummy-share-token-${id}`,
        connections: [{ uri: f.uri, local: false, protocol: 'http' }],
      }))
    );
  }
  for (const [id, f] of Object.entries(FIXTURES)) {
    if (!bare.startsWith(`${f.uri}/`)) continue;
    const container = { machineIdentifier: id, allowSync: true };
    // One movie library, and the title says it is in it: the app makes links
    // only for titles from the libraries a server lists.
    if (bare === `${f.uri}/library/sections`) container.Directory = [{ key: '1', type: 'movie', title: 'Films' }];
    if (bare === `${f.uri}/library/metadata/12`) {
      container.Metadata = [
        {
          title: `Dummy Film on ${id}`,
          year: 2020,
          librarySectionID: 1,
          Media: [{ videoResolution: '1080', Part: [{ key: '/library/parts/1/file.mkv', file: '/media/Dummy Film.mkv', size: 1234 }] }],
        },
      ];
    }
    return json({ MediaContainer: container });
  }
  throw new Error('fetch failed (the tests use no network)');
};

// Imported only after DATA_DIR is set: the database opens on import.
const config = await import('../src/config.js');
const { app } = await import('../src/app.js');
await import('../src/routes/downloads.js');

const listener = await new Promise((resolve) => {
  const s = app.listen(0, '127.0.0.1', () => resolve(s));
});
after(() => listener.close());
const { port } = listener.address();

function request(method, reqPath, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: reqPath, headers }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        let body = {};
        try { body = JSON.parse(data); } catch { /* not JSON: Express's own "not found" page */ }
        resolve({ status: res.statusCode, body });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// A request that says it was forwarded is never "this computer" to auth.js,
// so the app handles this loopback request like any other device on the Wi-Fi.
const GUEST = { forwarded: 'for=192.168.1.44' };
const guest = (method, reqPath) => request(method, reqPath, GUEST);
const owner = (method, reqPath) => request(method, reqPath);

const ROUTE_SPELLINGS = ['download-url', 'DOWNLOAD-URL', 'Download-Url', 'download-URL'];

test('with downloads off, nobody gets a link in any spelling, the owner included', async () => {
  assert.equal(config.downloadsEnabled(), false);
  for (const address of ['/api/download-url/SHARED/12', '/api/DOWNLOAD-URL/SHARED/12', '/api/Download-Url/SHARED/12/']) {
    const stranger = await guest('GET', address);
    assert.equal(stranger.status, 403, address);
    assert.equal(stranger.body.lookOnly, true, address);
    const self = await owner('GET', address);
    assert.equal(self.status, 403, address);
    assert.equal(self.body.downloadsDisabled, true, address);
  }
});

test('with downloads on and no PIN, a look-only device is refused a link in any letter case, with or without a slash at the end', async () => {
  config.updateConfig({ downloadsEnabled: true });
  const who = (await guest('GET', '/api/auth/status')).body;
  assert.deepEqual(
    { pinEnabled: who.pinEnabled, canChange: who.canChange, isOwner: who.isOwner, downloadsEnabled: who.downloadsEnabled },
    { pinEnabled: false, canChange: false, isOwner: false, downloadsEnabled: true }
  );

  for (const serverKey of ['SHARED', 'OWNED']) {
    for (const route of ROUTE_SPELLINGS) {
      for (const end of ['', '/']) {
        for (const mount of ['api', 'API']) {
          const address = `/${mount}/${route}/${serverKey}/12${end}`;
          const r = await guest('GET', address);
          assert.equal(r.status, 403, address);
          assert.equal(r.body.lookOnly, true, address);
          assert.equal(r.body.downloads, undefined, address);
        }
      }
    }
  }
});

test('the owner still gets a link, and Express does deliver the other spellings to the same route', async () => {
  for (const address of ['/api/download-url/SHARED/12', '/api/DOWNLOAD-URL/SHARED/12/', '/api/Download-Url/OWNED/12']) {
    const r = await owner('GET', address);
    assert.equal(r.status, 200, address);
    assert.equal(r.body.downloads.length, 1, address);
    assert.match(r.body.downloads[0].url, /^\/api\/download\/file\/(SHARED|OWNED)\/12\/0\?t=[0-9a-f]{32}$/, address);
  }
});

test('sending a link to the downloader is refused the same way', async () => {
  for (const address of ['/api/download/gopeed', '/api/DOWNLOAD/GOPEED', '/api/Download/Gopeed/']) {
    const r = await guest('POST', address);
    assert.equal(r.status, 403, address);
    assert.equal(r.body.lookOnly, true, address);
  }
});

test('sign-in and setup, spelled any way, still reach their own rules and not the look-only one', async () => {
  // Setup is owner-only by its own, stricter, rule.
  for (const address of ['/api/setup/downloads', '/api/SETUP/Downloads', '/api/Setup/DOWNLOADS/']) {
    const r = await guest('POST', address);
    assert.equal(r.status, 403, address);
    assert.equal(r.body.ownerRequired, true, address);
    assert.equal(r.body.lookOnly, undefined, address);
  }
  // Entering a PIN has to stay open, or nobody could ever prove themselves.
  for (const address of ['/api/auth/pin', '/api/AUTH/PIN/']) {
    const r = await guest('POST', address);
    assert.equal(r.status, 401, address);
    assert.equal(r.body.lookOnly, undefined, address);
  }
  // An ordinary change stays refused in every spelling.
  for (const address of ['/api/queue', '/api/QUEUE', '/api/Queue/']) {
    const r = await guest('POST', address);
    assert.equal(r.status, 403, address);
    assert.equal(r.body.lookOnly, true, address);
  }
});

// The check on the routes themselves, asked directly, so it is still proven
// when the path lists in change-gate.js are edited: whatever brought a request
// to these routes, a look-only device stops at the first step.
function firstStepOf(method, routePath) {
  const layer = app._router.stack.find((l) => l.route?.path === routePath && l.route.methods[method]);
  assert.ok(layer, `${method} ${routePath} is registered`);
  assert.ok(layer.route.stack.length >= 2, `${routePath} has a check before its handler`);
  return layer.route.stack[0].handle;
}

function ask(step, address) {
  const req = {
    method: 'GET',
    path: '/somewhere-else',
    ip: address,
    socket: { remoteAddress: address },
    app: { get: () => false },
    headers: { host: '192.168.1.10:3001' },
  };
  const answer = { status: 200, body: null, passed: false };
  const res = { status(code) { answer.status = code; return this; }, json(body) { answer.body = body; return this; }, setHeader() {} };
  step(req, res, () => { answer.passed = true; });
  return answer;
}

test('the download-link and send-to-downloader routes ask who is calling before anything else', () => {
  for (const [method, routePath] of [
    ['get', '/api/download-url/:serverKey/:ratingKey'],
    ['post', '/api/download/gopeed'],
  ]) {
    const step = firstStepOf(method, routePath);
    const stranger = ask(step, '192.168.1.50');
    assert.equal(stranger.passed, false, routePath);
    assert.equal(stranger.status, 403, routePath);
    assert.equal(stranger.body.lookOnly, true, routePath);
    assert.equal(ask(step, '127.0.0.1').passed, true, `${routePath}: the computer the app runs on`);
  }
});
