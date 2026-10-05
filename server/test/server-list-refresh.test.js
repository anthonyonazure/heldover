// Asking for the server list to be read again (refresh=true) starts a new
// discovery at most once in a while, and when plex.tv cannot be reached each
// request decides for itself whether it gets the last known list.
//
// GET /api/servers and GET /api/libraries take refresh=true from any device
// that may look. Each such request used to start a discovery of its own: one
// plex.tv call with the owner's account token and a question to every address
// of every Plex server, shared ones included. And because requests that arrive
// during a discovery share it, the request that started it decided what all
// of them got when plex.tv failed. One forced request in flight turned the
// library list into an error for every other device and the owner, and made
// the picture route hand out a stored poster of a server that was no longer
// on the list.
//
// Two stand-in Plex servers on this computer, a stand-in for plex.tv, a
// throwaway data folder and dummy tokens. Nothing leaves 127.0.0.1. Time is
// moved forward by hand, so nothing here waits for a real interval.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'heldover-test-'));
process.env.PLEX_TOKEN = 'dummy-account-token';
process.env.DISABLE_MDNS = '1';
// The stand-in servers here are plain http on this computer. A listed plain
// http address is used only when the owner has asked for that.
process.env.PLEX_ALLOW_HTTP = '1';
for (const key of ['TMDB_API_KEY', 'OMDB_API_KEY', 'MDBLIST_API_KEY', 'FANART_API_KEY', 'TRUST_PROXY', 'ALLOWED_HOSTS']) delete process.env[key];

// The app's own numbers (app.js): a forced discovery is honored once in 20
// seconds, and the list counts as fresh for 60.
const INTERVAL_MS = 20_000;
const LIST_FRESH_MS = 60_000;

const realNow = Date.now;
let skewMs = 0;
Date.now = () => realNow() + skewMs;
const laterBy = (ms) => {
  skewMs += ms;
};

const POSTER = Buffer.from('dummy-poster-bytes-not-a-real-picture');
const PICTURE_PATH = '/library/metadata/1/thumb/1';
const open = [];

/** A stand-in Plex server that counts how often it is asked who it is. */
async function standIn(serverKey, token) {
  const plex = { serverKey, token, identityAsked: 0 };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://stand-in');
    const send = (code, body, type = 'application/json') => {
      const data = Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
      res.writeHead(code, { 'Content-Type': type, 'Content-Length': data.length });
      res.end(data);
    };
    if (url.pathname === '/identity') {
      plex.identityAsked += 1;
      return send(200, { MediaContainer: { machineIdentifier: serverKey } });
    }
    if (req.headers['x-plex-token'] !== token) return send(401, { error: 'unauthorized' });
    if (url.pathname === '/library/sections') {
      return send(200, { MediaContainer: { Directory: [{ key: '1', type: 'movie', title: `Dummy Films ${serverKey}` }] } });
    }
    if (url.pathname === '/photo/:/transcode' || url.pathname === PICTURE_PATH) return send(200, POSTER, 'image/jpeg');
    return send(404, { error: 'not found' });
  });
  open.push(server);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  plex.uri = `http://127.0.0.1:${server.address().port}`;
  return plex;
}

// A is the owner's own server, B is one a friend shares.
const A = await standIn('srv-a-owned', 'dummy-token-a');
const B = await standIn('srv-b-shared', 'dummy-token-b');
const resourceA = { name: 'Stand-in A', provides: 'server', owned: true, presence: true, clientIdentifier: A.serverKey, accessToken: A.token, connections: [{ uri: A.uri, local: true, protocol: 'http' }] };
const resourceB = { name: 'Stand-in B', sourceTitle: 'dummy-friend', provides: 'server', owned: false, presence: true, clientIdentifier: B.serverKey, accessToken: B.token, connections: [{ uri: B.uri, local: false, protocol: 'http' }] };

// plex.tv is played by a stand-in that counts how often it is asked. It can
// answer, fail at once, or keep a call open until the test lets it fail.
const plexTv = {
  asked: 0,
  listed: [resourceA, resourceB],
  state: 'up', // up | down | held
  held: [],
  /** Every call that is being kept open fails now, as when plex.tv cannot be found. */
  letGo() {
    plexTv.held.splice(0).forEach((fail) => fail());
  },
};
const cannotReach = () => Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } });
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  if (url.hostname === '127.0.0.1') return realFetch(input, init);
  if (url.hostname === 'plex.tv' && url.pathname === '/api/v2/resources') {
    plexTv.asked += 1;
    if (plexTv.state === 'up') {
      return new Response(JSON.stringify(plexTv.listed), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (plexTv.state === 'down') throw cannotReach();
    return new Promise((_, reject) => plexTv.held.push(() => reject(cannotReach())));
  }
  throw new TypeError('fetch failed');
};

const { app } = await import('../src/app.js');
await import('../src/routes/servers-posters.js');
await import('../src/routes/library.js');
const { proxiedImageUrl } = await import('../src/plex-images.js');

const listener = await new Promise((resolve) => {
  const l = app.listen(0, '127.0.0.1', () => resolve(l));
});
open.push(listener);
const appBase = `http://127.0.0.1:${listener.address().port}`;

after(() => {
  globalThis.fetch = realFetch;
  Date.now = realNow;
  for (const server of open) {
    server.closeAllConnections();
    server.close();
  }
});

// A loopback connection that says it was forwarded for another device is not
// this computer (auth.js isLocal), so the app treats it as a device that may
// look and change nothing. With no `device`, the request is the owner's.
const DEVICE_1 = '192.168.1.50';
const DEVICE_2 = '192.168.1.60';
async function call(address, device = null, method = 'GET') {
  const res = await realFetch(`${appBase}${address}`, { method, headers: device ? { 'X-Forwarded-For': device } : {} });
  if ((res.headers.get('content-type') || '').includes('application/json')) {
    const body = await res.json().catch(() => null);
    return {
      status: res.status,
      error: body?.error,
      lookOnly: body?.lookOnly,
      servers: body?.servers?.map((s) => s.clientIdentifier),
      libraries: body?.libraries?.map((l) => `${l.serverKey}:${l.key}`).sort(),
    };
  }
  const bytes = Buffer.from(await res.arrayBuffer());
  return { status: res.status, posterCache: res.headers.get('x-poster-cache'), isTheStoredPoster: bytes.equals(POSTER) };
}
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const posterOfB = proxiedImageUrl(B.uri, PICTURE_PATH);

/**
 * One request starts a discovery and plex.tv keeps it waiting. While it
 * waits, three plain requests arrive: the library list for another device,
 * the stored poster of B for that device, and the library list for the owner.
 * Then plex.tv fails. `plexTvAsked` is 1 when all four shared one discovery.
 */
async function whilePlexTvKeepsADiscoveryWaiting(starterAddress) {
  const before = plexTv.asked;
  plexTv.state = 'held';
  const starter = call(starterAddress, DEVICE_1);
  for (let i = 0; i < 300 && plexTv.held.length === 0; i += 1) await pause(10);
  assert.equal(plexTv.held.length, 1, 'the request started a discovery, and plex.tv is keeping it waiting');
  const joiners = [call('/api/libraries', DEVICE_2), call(posterOfB, DEVICE_2), call('/api/libraries')];
  // Time for the three to arrive and join the discovery in flight.
  await pause(200);
  let answered = false;
  const all = Promise.all([starter, ...joiners]).finally(() => {
    answered = true;
  });
  // Let go until every request has its answer. A request that had not joined
  // would have asked plex.tv itself, and the count below would show it.
  while (!answered) {
    plexTv.letGo();
    await pause(10);
  }
  const [starterAnswer, librariesForDevice2, posterForDevice2, librariesForOwner] = await all;
  return { plexTvAsked: plexTv.asked - before, starterAnswer, librariesForDevice2, posterForDevice2, librariesForOwner };
}

test('the list is read once for the owner, and a device on the network is one that may only look', async () => {
  const first = await call('/api/libraries');
  assert.equal(first.status, 200);
  assert.deepEqual(first.libraries, ['srv-a-owned:1', 'srv-b-shared:1']);
  assert.equal(plexTv.asked, 1);

  const change = await call('/api/cache/clear', DEVICE_1, 'POST');
  assert.equal(change.status, 403);
  assert.equal(change.lookOnly, true, 'the app sees this device as look-only');

  // A poster of the friend's server is stored while that server is listed.
  const poster = await call(posterOfB, DEVICE_2);
  assert.equal(poster.status, 200);
  assert.equal(poster.posterCache, 'miss');
  assert.equal(poster.isTheStoredPoster, true);
});

test('five refresh requests in a row from a look-only device start one discovery, not five', async () => {
  const before = { plexTv: plexTv.asked, friend: B.identityAsked };
  for (let i = 0; i < 5; i += 1) {
    const res = await call('/api/servers?refresh=true', DEVICE_1);
    assert.equal(res.status, 200);
    assert.deepEqual(res.servers, ['srv-a-owned', 'srv-b-shared']);
  }
  assert.equal(plexTv.asked - before.plexTv, 1, 'plex.tv was asked once for the five requests');
  assert.equal(B.identityAsked - before.friend, 1, 'and so was the server a friend shares');

  // The other route that takes refresh=true counts against the same interval.
  for (let i = 0; i < 5; i += 1) {
    const res = await call('/api/libraries?refresh=true', DEVICE_1);
    assert.equal(res.status, 200);
    assert.deepEqual(res.libraries, ['srv-a-owned:1', 'srv-b-shared:1']);
  }
  assert.equal(plexTv.asked - before.plexTv, 1, 'no further discovery for the library list');
  assert.equal(B.identityAsked - before.friend, 1);
});

test('a refresh inside the interval gets the list on hand at once, and the owner gets a fresh list once the interval has passed', async () => {
  // The friend stops sharing. plex.tv no longer lists server B.
  plexTv.listed = [resourceA];
  const before = plexTv.asked;

  const inside = await call('/api/servers?refresh=true');
  assert.equal(inside.status, 200, 'no error for a refresh that is skipped');
  assert.deepEqual(inside.servers, ['srv-a-owned', 'srv-b-shared'], 'the list on hand');
  assert.equal(plexTv.asked - before, 0, 'plex.tv was not asked');

  // Past the interval, and well before the list would have been read again
  // anyway: the refresh is what makes it fresh.
  laterBy(INTERVAL_MS + 1000);
  assert.ok(INTERVAL_MS + 1000 < LIST_FRESH_MS);
  const later = await call('/api/servers?refresh=true');
  assert.equal(later.status, 200);
  assert.deepEqual(later.servers, ['srv-a-owned'], 'the fresh list');
  assert.equal(plexTv.asked - before, 1);

  // The stored poster of the server that left the list is refused from here on.
  const poster = await call(posterOfB, DEVICE_2);
  assert.equal(poster.status, 403);
});

// The answers of the next case, kept for the one after it.
let duringForcedDiscovery = null;

test('when plex.tv cannot be reached, requests that did not ask for a refresh get the last known list, even if the discovery they share was forced by another device', async () => {
  // The list is older than a minute, so every request needs a discovery, and
  // the interval has passed, so a forced one is honored.
  laterBy(LIST_FRESH_MS + 1000);
  const r = await whilePlexTvKeepsADiscoveryWaiting('/api/servers?refresh=true');
  duringForcedDiscovery = r;
  assert.equal(r.plexTvAsked, 1, 'the four requests shared one discovery');

  // The device that asked for a fresh list is told there is none, as before.
  assert.equal(r.starterAnswer.status, 500);
  assert.match(r.starterAnswer.error, /plex\.tv/);

  // Everyone else gets what they would have had without that device.
  assert.equal(r.librariesForDevice2.status, 200);
  assert.deepEqual(r.librariesForDevice2.libraries, ['srv-a-owned:1']);
  assert.equal(r.librariesForOwner.status, 200);
  assert.deepEqual(r.librariesForOwner.libraries, ['srv-a-owned:1']);
});

test('and in that state a stored poster of a server that left the list stays refused', () => {
  // The picture request of the case above. The picture route reads "no list
  // can be had" as "show what is stored", which is right only when no list
  // was ever known. Here one is known, and server B is not on it.
  const poster = duringForcedDiscovery?.posterForDevice2;
  assert.ok(poster, 'the case above ran');
  assert.equal(poster.status, 403);
  assert.equal(poster.isTheStoredPoster, false);
});

test('when the discovery was started by a plain request, every request that shares it gets the last known list', async () => {
  const r = await whilePlexTvKeepsADiscoveryWaiting('/api/servers');
  assert.equal(r.plexTvAsked, 1, 'the four requests shared one discovery');
  assert.equal(r.starterAnswer.status, 200);
  assert.deepEqual(r.starterAnswer.servers, ['srv-a-owned']);
  assert.equal(r.librariesForDevice2.status, 200);
  assert.deepEqual(r.librariesForDevice2.libraries, ['srv-a-owned:1']);
  assert.equal(r.librariesForOwner.status, 200);
  assert.deepEqual(r.librariesForOwner.libraries, ['srv-a-owned:1']);
  assert.equal(r.posterForDevice2.status, 403);
});

test('with plex.tv still out of reach, a refresh inside the interval gets the last known list and no error; one that is honored says plex.tv cannot be reached', async () => {
  plexTv.state = 'down';

  // The forced discovery three cases back ended moments ago.
  const inside = await call('/api/servers?refresh=true', DEVICE_1);
  assert.equal(inside.status, 200);
  assert.deepEqual(inside.servers, ['srv-a-owned']);

  laterBy(INTERVAL_MS + 1000);
  const honored = await call('/api/servers?refresh=true');
  assert.equal(honored.status, 500);
  assert.match(honored.error, /plex\.tv/);

  const insideAgain = await call('/api/libraries?refresh=true');
  assert.equal(insideAgain.status, 200);
  assert.deepEqual(insideAgain.libraries, ['srv-a-owned:1']);
});
