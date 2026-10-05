// A poster answer is never read into memory past the poster limit, whatever
// the Plex server says about its own answer.
//
// The limit (8 MiB) used to be compared with the length the server declared,
// and then the whole body was read. A Plex server on the list may be someone
// else's, and two ordinary kinds of answer got past that test: one sent in
// pieces declares no length at all, and a compressed one declares its small
// packed size. Measured, 16 KB on the wire was read as 16 MB. The bytes are
// now counted as they are read, and the read stops at the limit.
//
// One stand-in Plex server on this computer, a stand-in for plex.tv, a
// throwaway data folder and dummy tokens. Nothing leaves 127.0.0.1.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import zlib from 'zlib';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'heldover-test-'));
process.env.PLEX_TOKEN = 'dummy-account-token';
process.env.DISABLE_MDNS = '1';
// The stand-in server here is plain http on this computer. A listed plain
// http address is used only when the owner has asked for that.
process.env.PLEX_ALLOW_HTTP = '1';
for (const key of ['TMDB_API_KEY', 'OMDB_API_KEY', 'MDBLIST_API_KEY', 'FANART_API_KEY', 'TRUST_PROXY']) delete process.env[key];

const SERVER_KEY = 'stand-in-shared';
const SERVER_TOKEN = 'dummy-share-token';
const KIB = 1024;
const MIB = 1024 * KIB;
// The stand-in sends a body with no declared length in pieces of this size.
const PIECE = 16 * KIB;

// Set once the app is loaded (below): the limit in use and the answers sized to it.
let LIMIT = 0;
let OVER = 0;
let packedOver = null;

// What the stand-in answers for the poster of each item, at the resized
// address and at the original one alike.
const ORDINARY = '1';
const DECLARED_OVER = '2';
const PIECES_OVER = '3';
const PACKED_OVER = '4';
const PIECES_AT_LIMIT = '5';
const thumbOf = (item) => `/library/metadata/${item}/thumb/170000000${item}`;

// One record per poster request the stand-in answered. `handed` is how many
// bytes of the answer were handed to the app (counted in the stand-in for
// fetch below, after any unpacking).
const records = [];
const recordsOf = (item) => records.filter((r) => r.item === item);

const json = (res, body, code = 200) => {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};

function sendInPieces(res, total) {
  // No Content-Length is set, so Node sends the body in chunks.
  const piece = Buffer.alloc(PIECE, 0x42);
  for (let sent = 0; sent < total; sent += PIECE) res.write(piece.subarray(0, Math.min(PIECE, total - sent)));
  res.end();
}

const plex = http.createServer((req, res) => {
  // The app hangs up on an answer that runs past the limit.
  res.on('error', () => {});
  const url = new URL(req.url, 'http://stand-in');
  if (url.pathname === '/identity') return json(res, { MediaContainer: { machineIdentifier: SERVER_KEY } });
  if (req.headers['x-plex-token'] !== SERVER_TOKEN) return json(res, { error: 'unauthorized' }, 401);
  // The resizer is told which picture in its `url` value.
  const resized = url.pathname === '/photo/:/transcode';
  const wanted = resized ? (url.searchParams.get('url') || '').split('?')[0] : url.pathname;
  const picture = /^\/library\/metadata\/(\d+)\/thumb\/\d+$/.exec(wanted);
  if (!picture) return json(res, { error: 'not found' }, 404);

  const item = picture[1];
  records.push({ item, asked: resized ? 'resized' : 'original', handed: 0 });
  res.setHeader('Content-Type', 'image/jpeg');
  res.setHeader('X-Record', String(records.length - 1));
  if (item === ORDINARY) {
    const body = Buffer.from('AN ORDINARY POSTER');
    res.setHeader('Content-Length', String(body.length));
    return res.end(body);
  }
  if (item === DECLARED_OVER) {
    res.setHeader('Content-Length', String(OVER));
    return res.end(Buffer.alloc(OVER, 0x43));
  }
  if (item === PIECES_OVER) return sendInPieces(res, OVER);
  if (item === PACKED_OVER) {
    // The declared length is the packed size, a small fraction of the limit.
    res.setHeader('Content-Encoding', 'gzip');
    res.setHeader('Content-Length', String(packedOver.length));
    return res.end(packedOver);
  }
  return sendInPieces(res, LIMIT);
});
await new Promise((resolve) => plex.listen(0, '127.0.0.1', resolve));
const plexBase = `http://127.0.0.1:${plex.address().port}`;

// plex.tv is a stand-in that lists the server as one shared with the account.
// Requests to this computer go through, and every poster answer is passed on
// through a counter, so the test knows how much of it the app took.
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  if (url.hostname === 'plex.tv') {
    return new Response(
      JSON.stringify([
        {
          name: 'Stand-in shared server',
          provides: 'server',
          owned: false,
          presence: true,
          clientIdentifier: SERVER_KEY,
          accessToken: SERVER_TOKEN,
          connections: [{ uri: plexBase, local: false, protocol: 'http' }],
        },
      ]),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  }
  if (url.hostname !== '127.0.0.1') throw new TypeError('fetch failed');
  const res = await realFetch(input, init);
  const index = res.headers.get('x-record');
  if (index === null || !res.body) return res;
  const record = records[Number(index)];
  const counted = res.body.pipeThrough(
    new TransformStream({
      transform(chunk, controller) {
        record.handed += chunk.byteLength;
        controller.enqueue(chunk);
      },
    })
  );
  return new Response(counted, { status: res.status, headers: res.headers });
};

const { app } = await import('../src/app.js');
const posters = await import('../src/routes/servers-posters.js');
const posterCache = await import('../src/poster-cache.js');
const { proxiedImageUrl } = await import('../src/plex-images.js');

// The limit is brought down so that the answers here are kilobytes, not
// megabytes. A version of the app that cannot have its limit changed keeps
// the real 8 MiB, and the answers are sized to that instead, so that every
// case below still runs against it and shows what it does with them.
const adjustable = typeof posters.setPosterLimitForTests === 'function';
LIMIT = adjustable ? 64 * KIB : 8 * MIB;
if (adjustable) posters.setPosterLimitForTests(LIMIT);
OVER = LIMIT + MIB;
packedOver = zlib.gzipSync(Buffer.alloc(OVER, 0x41));
// A read stops at the first piece that takes it past the limit, so a little
// more than the limit is handed over: one piece as the network delivers it,
// which is at most 64 KiB. Twice that is allowed here.
const SLACK = 128 * KIB;

const listener = await new Promise((resolve) => {
  const l = app.listen(0, '127.0.0.1', () => resolve(l));
});
const appBase = `http://127.0.0.1:${listener.address().port}`;

after(() => {
  globalThis.fetch = realFetch;
  listener.close();
  plex.closeAllConnections();
  plex.close();
});

/** Ask the app for the poster of an item, at the address the app issues for it. */
const poster = (item) => realFetch(`${appBase}${proxiedImageUrl(plexBase, thumbOf(item))}`);
const stored = (item) => posterCache.readCached(plexBase, thumbOf(item), 'w400');

test('a poster of ordinary size is fetched, shown and stored', async () => {
  const res = await poster(ORDINARY);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-poster-cache'), 'miss');
  assert.equal(await res.text(), 'AN ORDINARY POSTER');
  assert.equal(String(stored(ORDINARY)), 'AN ORDINARY POSTER');
  assert.deepEqual(recordsOf(ORDINARY).map((r) => r.asked), ['resized'], 'one request, to the resizer');
});

test('an answer that declares a length over the limit is refused without being read', async () => {
  const res = await poster(DECLARED_OVER);
  assert.equal(res.status, 404);
  assert.equal(stored(DECLARED_OVER), null, 'nothing was stored');
  assert.ok(recordsOf(DECLARED_OVER).length > 0, 'the server was asked');
  for (const r of recordsOf(DECLARED_OVER)) assert.equal(r.handed, 0, `${r.asked}: nothing was read`);
});

test('an answer with no declared length is not read past the limit, and no picture is shown', async () => {
  const res = await poster(PIECES_OVER);
  assert.equal(res.status, 404);
  assert.equal(stored(PIECES_OVER), null, 'nothing was stored');
  assert.ok(recordsOf(PIECES_OVER).length > 0, 'the server was asked');
  for (const r of recordsOf(PIECES_OVER)) {
    assert.ok(r.handed > 0, `${r.asked}: the answer was read, not refused by its headers`);
    assert.ok(r.handed <= LIMIT + SLACK, `${r.asked}: ${r.handed} bytes of ${OVER} were read, with a limit of ${LIMIT}`);
  }
});

test('a compressed answer that declares a small length is not read past the limit once unpacked', async () => {
  assert.ok(packedOver.length < LIMIT / 4, `the packed answer is ${packedOver.length} bytes, far under the limit`);
  const res = await poster(PACKED_OVER);
  assert.equal(res.status, 404);
  assert.equal(stored(PACKED_OVER), null, 'nothing was stored');
  assert.ok(recordsOf(PACKED_OVER).length > 0, 'the server was asked');
  for (const r of recordsOf(PACKED_OVER)) {
    assert.ok(r.handed > 0, `${r.asked}: the answer was read, not refused by its headers`);
    assert.ok(r.handed <= LIMIT + SLACK, `${r.asked}: ${r.handed} bytes of ${OVER} unpacked were read, with a limit of ${LIMIT}`);
  }
});

test('a poster of exactly the limit, sent with no declared length, is still shown and stored', async () => {
  const res = await poster(PIECES_AT_LIMIT);
  assert.equal(res.status, 200);
  assert.equal((await res.arrayBuffer()).byteLength, LIMIT);
  assert.equal(stored(PIECES_AT_LIMIT)?.length, LIMIT, 'and it is stored');
  assert.deepEqual(recordsOf(PIECES_AT_LIMIT).map((r) => r.handed), [LIMIT]);
});
