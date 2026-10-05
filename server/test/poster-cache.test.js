// The poster cache holds one copy of each poster and stays under its cap.
//
// The image route checked a server by its origin, but stored posters under
// the `server` value exactly as it was sent. So one poster could be fetched
// and stored again under any number of spellings of the same address, and the
// size cap was only looked at every six hours: any device that may look could
// fill the disk the database lives on. A stored poster was also handed out
// before the server was checked at all. Everything here is a stand-in inside
// this process: no network is used.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'heldover-test-'));
process.env.DATA_DIR = dataDir;
process.env.PLEX_TOKEN = 'dummy-account-token';
process.env.DISABLE_MDNS = '1';

const ORIGIN = 'https://friend-plex.example:32400';
const SHARE_TOKEN = 'dummy-share-token';
const KIB = 1024;

// plex.tv and the friend's Plex server, played by a stand-in for fetch.
const upstream = { posters: 0, tokens: new Set(), unexpected: [] };
let plexTvUp = false;
let shared = true;
const realFetch = globalThis.fetch;
const reply = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
globalThis.fetch = async (input, init) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  if (url.hostname === '127.0.0.1') return realFetch(input, init);
  if (url.hostname === 'plex.tv') {
    if (!plexTvUp) throw new TypeError('fetch failed');
    return reply(
      shared
        ? [
            {
              name: 'Friend server',
              provides: 'server',
              owned: false,
              presence: true,
              clientIdentifier: 'friend',
              accessToken: SHARE_TOKEN,
              connections: [{ uri: ORIGIN, local: false, protocol: 'https' }],
            },
          ]
        : []
    );
  }
  if (url.origin === ORIGIN && url.pathname === '/identity') return reply({ MediaContainer: { machineIdentifier: 'friend' } });
  if (url.origin === ORIGIN && url.pathname === '/photo/:/transcode') {
    upstream.posters += 1;
    upstream.tokens.add(init?.headers?.['X-Plex-Token']);
    return new Response(Buffer.alloc(KIB, 0x41), { status: 200, headers: { 'Content-Type': 'image/jpeg', 'Content-Length': String(KIB) } });
  }
  upstream.unexpected.push(`${url.origin}${url.pathname}`);
  throw new TypeError('fetch failed');
};

const { app } = await import('../src/app.js');
const { warmPostersFor } = await import('../src/routes/servers-posters.js');
const posterCache = await import('../src/poster-cache.js');
const { proxiedImageUrl } = await import('../src/plex-images.js');

const listener = await new Promise((resolve) => {
  const l = app.listen(0, '127.0.0.1', () => resolve(l));
});
const appBase = `http://127.0.0.1:${listener.address().port}`;

after(() => {
  globalThis.fetch = realFetch;
  listener.close();
});

// The picture route serves only an address the app issued, so each request
// carries the signature the app gives that server and path, as an address held
// by a page does. The `server` value is still sent exactly as the case writes
// it. A server the app can issue nothing for is sent without one.
const signatureFor = (server, imagePath) =>
  new URLSearchParams((proxiedImageUrl(server, imagePath) || '').split('?')[1] || '').get('sig');
const poster = (query) => {
  const sig = signatureFor(query.server, query.path);
  return realFetch(`${appBase}/api/image?${new URLSearchParams(sig ? { ...query, sig } : query)}`);
};

/** Files and bytes in the posters folder right now. */
function folder() {
  const root = path.join(dataDir, 'posters');
  let files = 0;
  let bytes = 0;
  for (const bucket of fs.readdirSync(root)) {
    for (const name of fs.readdirSync(path.join(root, bucket))) {
      files += 1;
      bytes += fs.statSync(path.join(root, bucket, name)).size;
    }
  }
  return { files, bytes };
}

test('with no server list at all, a poster already stored is still shown and nothing is fetched', async () => {
  // The app has just started, plex.tv cannot be reached, and one poster is on
  // disk from an earlier run.
  await posterCache.getPoster(ORIGIN, '/library/metadata/50/thumb', async () => Buffer.from('STORED-EARLIER'), 'w400');

  const stored = await poster({ server: ORIGIN, path: '/library/metadata/50/thumb' });
  assert.equal(stored.status, 200);
  assert.equal(stored.headers.get('x-poster-cache'), 'hit');
  assert.equal(await stored.text(), 'STORED-EARLIER');

  const missing = await poster({ server: ORIGIN, path: '/library/metadata/51/thumb' });
  assert.equal(missing.status, 502);
  assert.equal(upstream.posters, 0, 'no server was asked for anything');
});

test('one poster is stored once and fetched once, however its server address is spelled', async () => {
  plexTvUp = true;
  const before = folder().files;
  const spellings = [
    ORIGIN,
    `${ORIGIN}/`,
    `${ORIGIN}/1`,
    `${ORIGIN}?n=2`,
    `${ORIGIN}#3`,
    // A user name in front of the host (built this way so it does not read as an email address).
    `https://u4@${new URL(ORIGIN).host}`,
    'HTTPS://FRIEND-PLEX.EXAMPLE:32400/x5',
    ...Array.from({ length: 23 }, (_, i) => `${ORIGIN}/spelling-${i}?${i}`),
  ];
  const answers = [];
  for (const server of spellings) {
    const res = await poster({ server, path: '/library/metadata/1/thumb' });
    assert.equal(res.status, 200, server);
    assert.equal((await res.arrayBuffer()).byteLength, KIB);
    answers.push(res.headers.get('x-poster-cache'));
  }
  assert.deepEqual(answers, ['miss', ...Array(spellings.length - 1).fill('hit')]);
  assert.equal(upstream.posters, 1, 'the server was asked for the poster once');
  assert.deepEqual([...upstream.tokens], [SHARE_TOKEN]);
  assert.equal(folder().files - before, 1, 'and it is stored once');

  // What is not an http or https address is refused outright, and another
  // server's address is still not on the list.
  assert.equal((await poster({ server: 'ftp://friend-plex.example:32400', path: '/library/metadata/1/thumb' })).status, 400);
  assert.equal((await realFetch(`${appBase}/api/image?server=${encodeURIComponent(ORIGIN)}&server=x&path=/library/metadata/1/thumb`)).status, 400);
  assert.equal((await poster({ server: 'https://other.example:32400', path: '/library/metadata/1/thumb' })).status, 403);
  assert.equal(upstream.posters, 1);
  assert.deepEqual(upstream.unexpected, []);
});

test('a poster fetched ahead of time and the same poster asked for by a page are one entry', async () => {
  const asked = upstream.posters;
  const thumb = `/api/image?${new URLSearchParams({
    server: `${ORIGIN}/`,
    path: '/library/metadata/2/thumb',
    sig: signatureFor(ORIGIN, '/library/metadata/2/thumb'),
  })}`;
  warmPostersFor([{ thumb }]);
  // Warming runs behind whatever asked for it, so give it a moment.
  for (let i = 0; i < 200 && upstream.posters === asked; i += 1) await new Promise((r) => setTimeout(r, 10));
  assert.equal(upstream.posters, asked + 1);
  await new Promise((r) => setTimeout(r, 20));

  const res = await poster({ server: ORIGIN, path: '/library/metadata/2/thumb' });
  assert.equal(res.headers.get('x-poster-cache'), 'hit');
  assert.equal(upstream.posters, asked + 1, 'not fetched a second time');
});

test('a stored poster is not shown once its server is no longer on the list', async () => {
  shared = false;
  const servers = await (await realFetch(`${appBase}/api/servers?refresh=true`)).json();
  assert.deepEqual(servers.servers, []);
  const res = await poster({ server: ORIGIN, path: '/library/metadata/1/thumb' });
  assert.equal(res.status, 403);
});

test('the size cap is checked on every write, so the folder cannot outgrow it', async () => {
  const CAP = 10 * KIB;
  posterCache.setLimitsForTests(CAP, 6 * KIB);
  let last = null;
  for (let i = 0; i < 40; i += 1) {
    last = `/library/metadata/${1000 + i}/thumb`;
    const { buffer } = await posterCache.getPoster(ORIGIN, last, async () => Buffer.alloc(KIB, 0x42), 'w400');
    assert.equal(buffer.length, KIB, 'the poster is shown either way');
    assert.ok(folder().bytes <= CAP, `after ${i + 1} posters the folder holds ${folder().bytes} bytes`);
  }
  // Full means the oldest make way, not that storing stops.
  assert.ok(posterCache.readCached(ORIGIN, last, 'w400'), 'the newest poster is stored');
  assert.ok(folder().bytes > 0);

  // A picture that could never fit is shown and not kept.
  const huge = await posterCache.getPoster(ORIGIN, '/library/metadata/2000/thumb', async () => Buffer.alloc(20 * KIB, 0x43), 'w400');
  assert.equal(huge.buffer.length, 20 * KIB);
  assert.equal(posterCache.readCached(ORIGIN, '/library/metadata/2000/thumb', 'w400'), null);
  assert.ok(folder().bytes <= CAP);
});
