// A download link moves a file only for a device that is there to take it,
// and only so many at one time.
//
// Three things used to be otherwise. A HEAD on a link (a download manager
// asking for the size before it starts) was sent to the Plex server as a GET,
// so the app read the whole file and threw it away. A device that hung up
// while the app was still asking the Plex server about the title was not
// noticed, so the file was asked for anyway and left open with nobody to
// send it to. And nothing limited how many of these ran at one time on one
// link, which works again and again for a day.
//
// One stand-in Plex server on this computer's loopback. Only plex.tv is faked
// inside the process. Dummy tokens, small files, a throwaway data folder.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'heldover-test-'));
process.env.PLEX_TOKEN = 'dummy-account-token';
// The stand-in server here is plain http on this computer. A listed plain
// http address is used only when the owner has asked for that.
process.env.PLEX_ALLOW_HTTP = '1';
delete process.env.TRUST_PROXY;

const SHARE_TOKEN = 'dummy-share-token';
const FILE_BYTES = '0123456789';
const HELD_BYTES = 'first-half|second-half';
const FILE_HEADERS = {
  'content-type': 'video/x-matroska',
  'accept-ranges': 'bytes',
  etag: '"dummy-etag"',
  'last-modified': 'Thu, 01 Jan 2026 00:00:00 GMT',
};
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------- The stand-in Plex server ----------
//
// A file under /library/parts/good-<n>/ is sent at once, whole or in a range.
// A file under /library/parts/held-<n>/ sends its first half and then waits,
// as a long download does, until letGo() sends the rest.
const partKeys = new Map();
const says = { metadataDelayMs: 0 };
const fileRequests = [];
const held = new Set();

function letGo() {
  for (const res of held) res.end(HELD_BYTES.slice(HELD_BYTES.indexOf('|') + 1));
  held.clear();
}

const sendJson = (res, container) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ MediaContainer: { machineIdentifier: 'friend-id', allowSync: true, ...container } }));
};

const plexServer = http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://plex');
  if (pathname === '/' || pathname === '/identity') return sendJson(res, {});
  if (pathname === '/library/sections') return sendJson(res, { Directory: [{ key: '1', type: 'movie', title: 'Films' }] });
  const title = pathname.match(/^\/library\/metadata\/(\d+)$/);
  if (title) {
    if (says.metadataDelayMs) await wait(says.metadataDelayMs);
    return sendJson(res, {
      Metadata: [
        {
          title: `Dummy Film ${title[1]}`,
          year: 2020,
          librarySectionID: 1,
          Media: [{ videoResolution: '1080', Part: [{ key: partKeys.get(title[1]), file: '/media/Dummy Film.mkv', size: FILE_BYTES.length }] }],
        },
      ],
    });
  }
  const file = pathname.match(/^\/library\/parts\/(good|held)-(\d+)\/file\.mkv$/);
  if (!file) {
    res.writeHead(404);
    return res.end();
  }
  const seen = { title: file[2], method: req.method, range: req.headers.range || null, token: req.headers['x-plex-token'] || null, sentToTheEnd: false, closed: false };
  fileRequests.push(seen);
  res.on('finish', () => { seen.sentToTheEnd = true; });
  res.on('close', () => { seen.closed = true; held.delete(res); });

  if (file[1] === 'held' && req.method !== 'HEAD') {
    res.writeHead(200, { ...FILE_HEADERS, 'content-length': HELD_BYTES.length });
    res.write(HELD_BYTES.slice(0, HELD_BYTES.indexOf('|') + 1));
    held.add(res);
    return undefined;
  }
  const whole = file[1] === 'held' ? HELD_BYTES : FILE_BYTES;
  const range = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range || '');
  if (range) {
    const [from, to] = [Number(range[1]), Number(range[2])];
    res.writeHead(206, { ...FILE_HEADERS, 'content-range': `bytes ${from}-${to}/${whole.length}`, 'content-length': to - from + 1 });
    return res.end(whole.slice(from, to + 1));
  }
  res.writeHead(200, { ...FILE_HEADERS, 'content-length': whole.length });
  return res.end(whole);
});
await new Promise((resolve) => plexServer.listen(0, '127.0.0.1', resolve));
const plexBase = `http://127.0.0.1:${plexServer.address().port}`;
const requestsFor = (title) => fileRequests.filter((r) => r.title === title);

// plex.tv lists that one server as shared with this account. Everything else
// goes out for real, which here means to the stand-in and to the app.
const realFetch = globalThis.fetch;
globalThis.fetch = (input, options) => {
  const address = String(typeof input === 'string' ? input : input?.href || input?.url || input);
  if (address.startsWith('https://plex.tv/')) {
    return Promise.resolve(
      new Response(
        JSON.stringify([
          {
            name: 'Friend',
            provides: 'server',
            clientIdentifier: 'friend-id',
            owned: false,
            presence: true,
            accessToken: SHARE_TOKEN,
            connections: [{ uri: plexBase, local: false, protocol: 'http' }],
          },
        ]),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    );
  }
  return realFetch(input, options);
};

// Imported only after DATA_DIR is set: the database opens on import.
const config = await import('../src/config.js');
const { app } = await import('../src/app.js');
const downloads = await import('../src/routes/downloads.js');
config.updateConfig({ downloadsEnabled: true });

const listener = await new Promise((resolve) => {
  const s = app.listen(0, '127.0.0.1', () => resolve(s));
});
const appPort = listener.address().port;
after(() => {
  letGo();
  listener.close();
  plexServer.close();
});

// ---------- The device ----------
//
// Each request is its own connection, as a download manager's are, and comes
// from this computer with no forwarding header: the owner, who may download.

/** Sends a request and resolves when the headers arrive. The body is read with finish(), or dropped with hangUp(). */
function open(method, address, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: appPort, path: address, method, headers, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('error', () => {});
      const ended = new Promise((done) => res.on('close', done));
      resolve({
        status: res.statusCode,
        headers: res.headers,
        finish: async () => {
          await ended;
          return Buffer.concat(chunks).toString();
        },
        hangUp: () => req.destroy(),
      });
    });
    req.on('error', reject);
    req.end();
  });
}

/** Sends a GET and closes the connection after `ms`, before any answer has come. */
function getAndHangUpAfter(address, ms) {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port: appPort, path: address, method: 'GET', agent: false }, (res) => {
      res.resume();
      resolve('answered');
    });
    req.on('error', () => resolve('hung up'));
    req.end();
    setTimeout(() => req.destroy(), ms);
  });
}

/** A whole request and its answer. */
async function ask(method, address, headers = {}) {
  const answer = await open(method, address, headers);
  const text = await answer.finish();
  let body = null;
  try { body = JSON.parse(text); } catch { /* a file, not JSON */ }
  return { status: answer.status, headers: answer.headers, text, body };
}

/**
 * A request that should be refused. If it is let in instead, the connection
 * is dropped, so a failing test says so at once and does not wait on a file.
 */
async function askForRefusal(address, headers = {}) {
  const answer = await open('GET', address, headers);
  if (answer.status !== 429) answer.hangUp();
  const text = await answer.finish();
  let body = null;
  try { body = JSON.parse(text); } catch { /* a file, not JSON */ }
  return { status: answer.status, headers: answer.headers, text, body };
}

/** A link for a title whose file is sent at once ("good") or held open part way ("held"). */
async function linkFor(title, kind = 'good') {
  partKeys.set(title, `/library/parts/${kind}-${title}/file.mkv`);
  const made = await ask('GET', `/api/download-url/friend-id/${title}`);
  assert.equal(made.status, 200);
  assert.equal(made.body.downloads.length, 1);
  return made.body.downloads[0].url;
}

/** Ceilings small enough to reach, put back to the real ones afterward whatever happens. */
async function withLimits(perLink, inAll, run) {
  downloads.setDownloadLimitsForTests?.(perLink, inAll);
  try {
    await run();
  } finally {
    letGo();
    downloads.setDownloadLimitsForTests?.(20, 100);
  }
}

/** A place comes free a moment after a connection closes, so this asks again for up to a second. */
async function openOnceThereIsRoom(address) {
  for (let tries = 0; ; tries += 1) {
    const answer = await open('GET', address);
    if (answer.status !== 429 || tries >= 50) return answer;
    await answer.finish();
    await wait(20);
  }
}

function assertPlainRefusal(refused, message) {
  assert.equal(refused.status, 429, 'refused, not let in');
  assert.match(refused.body.error, message);
  assert.equal(refused.body.tooManyDownloads, true);
  assert.equal(refused.headers['retry-after'], '30', 'says when to ask again');
  // Nothing about the Plex server: no address, no token, no file path.
  assert.doesNotMatch(refused.text, /127\.0\.0\.1|https?:|\/\/|dummy|library|\.mkv/);
}

test('a HEAD on a download link gets the size, the type and the range support with no body, and the Plex server is asked with HEAD so no file is read', async () => {
  const link = await linkFor('60');

  const head = await ask('HEAD', link);
  assert.equal(head.status, 200);
  assert.equal(head.text, '', 'no body reaches the device');
  assert.equal(head.headers['content-length'], String(FILE_BYTES.length));
  assert.equal(head.headers['content-type'], 'video/x-matroska');
  assert.equal(head.headers['accept-ranges'], 'bytes');
  assert.equal(head.headers.etag, '"dummy-etag"');
  assert.equal(head.headers['last-modified'], 'Thu, 01 Jan 2026 00:00:00 GMT');
  assert.match(head.headers['content-disposition'], /filename="Dummy Film\.mkv"/);
  assert.deepEqual(
    requestsFor('60').map((r) => ({ method: r.method, range: r.range, token: r.token })),
    [{ method: 'HEAD', range: null, token: SHARE_TOKEN }],
    'the Plex server was asked once, with HEAD'
  );

  // A range asked with HEAD is answered as a range, still with no body.
  const piece = await ask('HEAD', link, { Range: 'bytes=2-5' });
  assert.equal(piece.status, 206);
  assert.equal(piece.text, '');
  assert.equal(piece.headers['content-range'], `bytes 2-5/${FILE_BYTES.length}`);
  assert.equal(piece.headers['content-length'], '4');
  assert.deepEqual(requestsFor('60').map((r) => r.method), ['HEAD', 'HEAD']);
  assert.equal(requestsFor('60')[1].range, 'bytes=2-5');
});

test('a GET on a link still downloads the file, whole or in ranges, with the size, the type, the range support and the file name', async () => {
  const link = await linkFor('61');
  const whole = await ask('GET', link);
  assert.equal(whole.status, 200);
  assert.equal(whole.text, FILE_BYTES);
  assert.equal(whole.headers['content-length'], String(FILE_BYTES.length));
  for (const [name, value] of Object.entries(FILE_HEADERS)) assert.equal(whole.headers[name], value, name);
  assert.match(whole.headers['content-disposition'], /filename="Dummy Film\.mkv"/);

  const piece = await ask('GET', link, { Range: 'bytes=2-5' });
  assert.equal(piece.status, 206);
  assert.equal(piece.text, '2345');
  assert.equal(piece.headers['content-range'], `bytes 2-5/${FILE_BYTES.length}`);
  assert.equal(piece.headers['accept-ranges'], 'bytes');
  assert.deepEqual(
    requestsFor('61').map((r) => ({ method: r.method, range: r.range, token: r.token, sentToTheEnd: r.sentToTheEnd })),
    [
      { method: 'GET', range: null, token: SHARE_TOKEN, sentToTheEnd: true },
      { method: 'GET', range: 'bytes=2-5', token: SHARE_TOKEN, sentToTheEnd: true },
    ]
  );
});

test('a device that hangs up while the app is still asking the Plex server about the title: the file is never asked for, and its place is free again', async () => {
  const link = await linkFor('62');
  await withLimits(1, 5, async () => {
    says.metadataDelayMs = 200;
    try {
      // The same thing a closed browser tab or a stopped downloader does.
      assert.equal(await getAndHangUpAfter(link, 60), 'hung up');
      await wait(400);
    } finally {
      says.metadataDelayMs = 0;
    }
    assert.deepEqual(requestsFor('62'), [], 'the Plex server was not asked for the file');

    // One connection per link is allowed here, and the one that left no
    // longer counts.
    const next = await ask('GET', link);
    assert.equal(next.status, 200);
    assert.equal(next.text, FILE_BYTES);
  });
});

test('a device that hangs up part way through a file stops the read from the Plex server, and its place is free again', async () => {
  const link = await linkFor('63', 'held');
  await withLimits(1, 5, async () => {
    const first = await open('GET', link);
    assert.equal(first.status, 200);
    assert.equal((await askForRefusal(link)).status, 429, 'the one place on this link is taken');

    first.hangUp();
    const second = await openOnceThereIsRoom(link);
    assert.equal(second.status, 200, 'the place came free when the device left');
    for (let tries = 0; !requestsFor('63')[0].closed && tries < 50; tries += 1) await wait(20);
    assert.equal(requestsFor('63')[0].closed, true, 'the read from the Plex server was stopped');
    assert.equal(requestsFor('63')[0].sentToTheEnd, false);

    letGo();
    assert.equal(await second.finish(), HELD_BYTES);
    assert.equal(requestsFor('63').length, 2);
  });
});

test('one link carries only so many connections at one time: the next is refused at once with a plain answer, and costs the Plex server nothing', async () => {
  const link = await linkFor('64', 'held');
  await withLimits(2, 10, async () => {
    const running = [await open('GET', link, { Range: 'bytes=0-10' }), await open('GET', link, { Range: 'bytes=11-21' })];
    assert.deepEqual(running.map((r) => r.status), [200, 200]);

    const askedOfPlexBefore = fileRequests.length;
    const refused = await askForRefusal(link, { Range: 'bytes=0-10' });
    assertPlainRefusal(refused, /already has 2 connections open/);
    assert.equal(fileRequests.length, askedOfPlexBefore, 'the Plex server was asked nothing for the refused request');

    // A HEAD moves no file, so it is answered even now.
    const head = await ask('HEAD', link);
    assert.equal(head.status, 200);
    assert.equal(head.headers['content-length'], String(HELD_BYTES.length));

    // The two that were let in finish their files, and then there is room again.
    letGo();
    assert.deepEqual(await Promise.all(running.map((r) => r.finish())), [HELD_BYTES, HELD_BYTES]);
    const afterward = await openOnceThereIsRoom(link);
    assert.equal(afterward.status, 200);
    letGo();
    await afterward.finish();
  });
});

test('every link together carries only so many: one more on any link is refused, and a link with room is not held up by its own count', async () => {
  const linkA = await linkFor('65', 'held');
  const linkB = await linkFor('66', 'held');
  await withLimits(2, 3, async () => {
    const running = [await open('GET', linkA), await open('GET', linkA), await open('GET', linkB)];
    assert.deepEqual(running.map((r) => r.status), [200, 200, 200]);

    // Link B has one of its two, but all three places are taken.
    assertPlainRefusal(await askForRefusal(linkB), /as many downloads as it allows at one time/);
    assertPlainRefusal(await askForRefusal(linkA), /already has 2 connections open/);

    running[0].hangUp();
    const next = await openOnceThereIsRoom(linkB);
    assert.equal(next.status, 200, 'a place freed on one link can be used by another');
    letGo();
    await Promise.all([running[1].finish(), running[2].finish(), next.finish()]);
  });
});

test('with the limits as shipped, a download manager\'s 16 connections on one link all get through, and the 21st at one time is refused', async () => {
  const link = await linkFor('67', 'held');
  try {
    const running = [];
    for (let i = 0; i < 20; i += 1) running.push(await open('GET', link, { Range: `bytes=${i}-${i}` }));
    assert.deepEqual(running.map((r) => r.status), Array(20).fill(200));
    assertPlainRefusal(await askForRefusal(link), /already has 20 connections open/);
    letGo();
    await Promise.all(running.map((r) => r.finish()));
  } finally {
    letGo();
  }
});
