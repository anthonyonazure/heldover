// How much of an answer from a Plex server is read into memory.
//
// Every answer used to be read whole, whatever its size: the server that
// answered (often someone else's) chose how much memory one read took, in the
// one process every device shares. Answers are now counted as they arrive and
// given up on past a limit the app chooses. A file that is passed on as a
// stream (a download, a cast to the TV) is not an answer held in memory, and
// is not limited. Stand-in servers on this computer, dummy data, and a limit
// lowered for the test so that a few kilobytes are enough to reach it.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import { DUMMY_TOKEN, listenForTest, startStandInPlex, stubPlexTv, until } from './helpers/stand-in-plex.js';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'heldover-test-'));
process.env.PLEX_TOKEN = DUMMY_TOKEN;
process.env.DISABLE_MDNS = '1';
// The stand-in servers here are plain http on this computer. A listed plain
// http address is used only when the owner has asked for that.
process.env.PLEX_ALLOW_HTTP = '1';
for (const key of ['TMDB_API_KEY', 'OMDB_API_KEY', 'MDBLIST_API_KEY', 'FANART_API_KEY', 'TRUST_PROXY']) delete process.env[key];

const plexFetchFile = await import('../src/plex-fetch.js');
const { plexFetch } = plexFetchFile;

const open = [];
/** A stand-in machine on this computer. `closedEarly` counts answers the app hung up on. */
function listen(handler) {
  return new Promise((resolve) => {
    const machine = { closedEarly: 0 };
    const server = http.createServer((req, res) => {
      res.on('close', () => {
        if (!res.writableFinished) machine.closedEarly += 1;
      });
      handler(req, res);
    });
    open.push(server);
    server.listen(0, '127.0.0.1', () => {
      machine.base = `http://127.0.0.1:${server.address().port}`;
      resolve(machine);
    });
  });
}

/** A JSON answer of exactly `bytes` bytes. */
const jsonOf = (bytes) => {
  const empty = JSON.stringify({ MediaContainer: { filler: '' } }).length;
  return JSON.stringify({ MediaContainer: { filler: 'x'.repeat(bytes - empty) } });
};

const LIMIT = 4096;
const sizes = await listen((req, res) => {
  const url = new URL(req.url, 'http://stand-in');
  const body = jsonOf(Number(url.searchParams.get('bytes')));
  if (url.pathname === '/declared') {
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
    return res.end(body);
  }
  // No declared length: sent in pieces, as a server that has not counted does.
  res.writeHead(200, { 'content-type': 'application/json' });
  res.write(body.slice(0, 1000));
  setTimeout(() => res.end(body.slice(1000)), 10);
  return undefined;
});

// A server that goes on sending: a kilobyte every few milliseconds, for far
// longer than the limit allows. (It does end by itself after 300 KB, so a
// reader with no limit finishes too, and the check below fails instead of
// hanging.)
const endless = await listen((req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.write('{"MediaContainer":{"filler":"');
  let sent = 0;
  const more = setInterval(() => {
    res.write('x'.repeat(1024));
    sent += 1;
    if (sent < 300) return;
    clearInterval(more);
    res.end('"}}');
  }, 5);
  res.on('close', () => clearInterval(more));
});

const FILE = Buffer.alloc(200_000, 7);
const SERVER = 'stand-in-sizes';
const film = (key, summary) => ({ ratingKey: String(key), type: 'movie', title: `Dummy Film ${key}`, year: 2000, summary });
const plex = await startStandInPlex({
  serverKey: SERVER,
  sections: [
    { key: '1', type: 'movie', title: 'Oversized' },
    { key: '2', type: 'movie', title: 'Ordinary' },
  ],
  items: {
    1: [film(11, 'x'.repeat(50_000))],
    2: [{ ...film(21, 'a dummy summary'), Media: [{ videoResolution: '1080', Part: [{ key: '/library/parts/21/file.mkv', file: '/media/Dummy Film.mkv', size: FILE.length }] }] }],
  },
  file: FILE,
});
const refused = stubPlexTv([plex]);
// plex.tv can be made to send an oversized list of servers.
const plexTv = { oversized: false };
const stubbed = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const address = String(typeof input === 'string' ? input : input?.href || input?.url || input);
  if (plexTv.oversized && address.startsWith('https://plex.tv/')) {
    const padded = JSON.stringify([{ ...plex.resource(), filler: 'x'.repeat(50_000) }]);
    return new Response(padded, { status: 200, headers: { 'content-type': 'application/json' } });
  }
  return stubbed(input, init);
};

const config = await import('../src/config.js');
const { app } = await import('../src/app.js');
await import('../src/routes/library.js');
await import('../src/routes/downloads.js');
const cache = await import('../src/library-cache.js');
const plexLibrary = await import('../src/plex-library.js');
const plexServers = await import('../src/plex-servers.js');
config.updateConfig({ downloadsEnabled: true });
const { base, call, close } = await listenForTest(app);

after(async () => {
  plexFetchFile.setAnswerLimitForTests?.();
  await close();
  await plex.stop();
  for (const server of open) {
    server.closeAllConnections();
    server.close();
  }
});

const tooLarge = (err) => {
  assert.equal(err.name, 'AnswerTooLargeError');
  assert.equal(err.message, 'The answer from Plex was too large to read');
  return true;
};

test('an answer under the limit is read as before, with a declared length or without one', async () => {
  for (const kind of ['declared', 'pieces']) {
    const res = await plexFetch(`${sizes.base}/${kind}?bytes=${LIMIT}`, { maxAnswerBytes: LIMIT });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(JSON.stringify(data).length, LIMIT, `${kind}: every byte up to the limit itself`);
    const text = await (await plexFetch(`${sizes.base}/${kind}?bytes=3000`, { maxAnswerBytes: LIMIT })).text();
    assert.equal(text.length, 3000, kind);
  }
});

test('an answer over the limit is refused, with a declared length or without one', async () => {
  for (const kind of ['declared', 'pieces']) {
    for (const reader of ['json', 'text', 'arrayBuffer', 'blob']) {
      const res = await plexFetch(`${sizes.base}/${kind}?bytes=${LIMIT + 1}`, { maxAnswerBytes: LIMIT });
      await assert.rejects(res[reader](), tooLarge, `${kind} ${reader}`);
    }
  }
});

test('a server that goes on sending is hung up on as soon as the limit is passed', async () => {
  const started = Date.now();
  const res = await plexFetch(`${endless.base}/library/sections/1/all`, { maxAnswerBytes: LIMIT });
  await assert.rejects(res.json(), tooLarge);
  assert.ok(Date.now() - started < 1000, 'the refusal does not wait for the answer to end');
  await until(() => endless.closedEarly === 1, 'the connection to that server to be closed');
});

test('a body passed on as a stream is not limited: a file is larger than any answer', async () => {
  const res = await plexFetch(`${sizes.base}/declared?bytes=100000`, { maxAnswerBytes: LIMIT });
  let received = 0;
  for await (const chunk of res.body) received += chunk.byteLength;
  assert.equal(received, 100_000);
});

test('a caller that names no limit gets one that is far above a real library page', async () => {
  // One page of 500 titles is a few megabytes.
  assert.equal(plexFetchFile.MAX_ANSWER_BYTES, 64 * 1024 * 1024);
  assert.equal(plexFetchFile.MAX_SMALL_ANSWER_BYTES, 8 * 1024 * 1024);
  const res = await plexFetch(`${sizes.base}/pieces?bytes=300000`);
  assert.equal(JSON.stringify(await res.json()).length, 300_000);
});

test('the limit is not passed on to fetch as an option', async () => {
  const passed = [];
  const spy = async (url, options) => {
    passed.push(Object.keys(options).sort());
    return new Response('{}');
  };
  await plexFetch('http://127.0.0.1:1/x', { maxAnswerBytes: LIMIT, headers: {} }, spy);
  assert.deepEqual(passed, [['headers', 'redirect']]);
});

// From here on every answer in the app is limited to 20 KB, in place of the
// megabytes of the real limits.
test('a library page over the limit ends the read, and nothing of it is stored', async () => {
  plexFetchFile.setAnswerLimitForTests?.(20_000);
  const listed = await call('GET', '/api/libraries');
  assert.equal(listed.body.libraries.length, 2);

  const res = await call('GET', `/api/library/${SERVER}/1`, { lookOnly: true });
  assert.equal(res.status, 500);
  assert.equal(res.body.error, 'The answer from Plex was too large to read');
  assert.equal(cache.getCachedItems(SERVER, '1'), null);
  // One attempt: an answer that is too large is not asked for again.
  assert.equal(plex.pagesOf(1), 1);

  await assert.rejects(plexLibrary.getLibraryItems(plex.uri, '1', DUMMY_TOKEN, null), tooLarge);
});

test('a library with ordinary pages still loads under the same limit', async () => {
  const res = await call('GET', `/api/library/${SERVER}/2`, { lookOnly: true });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.items.map((item) => item.title), ['Dummy Film 21']);
});

test('a file passed through to a download is not cut off by that limit', async () => {
  const made = await call('GET', `/api/download-url/${SERVER}/21`);
  assert.equal(made.status, 200);
  const file = await fetch(base + made.body.downloads[0].url);
  assert.equal(file.status, 200);
  const bytes = Buffer.from(await file.arrayBuffer());
  assert.equal(bytes.length, FILE.length, 'ten times the limit, and every byte arrived');
  assert.equal(bytes.equals(FILE), true);
});

test("a server's list of sections and the account's list of servers are limited too", async () => {
  const sections = await listen((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ MediaContainer: { Directory: [{ key: '1', type: 'movie', title: 'x'.repeat(50_000) }] } }));
  });
  await assert.rejects(plexLibrary.getLibraries(sections.base, DUMMY_TOKEN, null), tooLarge);
  await assert.rejects(
    plexLibrary.getLibraries(sections.base, DUMMY_TOKEN, [{ uri: sections.base, local: true, protocol: 'http' }]),
    tooLarge
  );

  plexTv.oversized = true;
  try {
    await assert.rejects(plexServers.getServers(DUMMY_TOKEN), tooLarge);
  } finally {
    plexTv.oversized = false;
  }
  assert.equal((await plexServers.getServers(DUMMY_TOKEN)).length, 1, 'an ordinary list is read as before');
});

test('nothing in these checks left this computer', () => {
  assert.deepEqual(refused, []);
});
