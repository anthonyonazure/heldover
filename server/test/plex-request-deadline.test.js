// A request to a Plex server has one time limit, and it covers the whole
// answer.
//
// The limit used to end when the headers arrived. A server (often someone
// else's) that sent its headers and then stalled or trickled the body kept the
// read waiting with no limit, and a library read kept one of the two places
// the app has for reads: two such answers stopped every fresh library read,
// and one stopped the background warm-up. A device that hung up did not end
// the request either. These checks pin the rule that replaced that, against a
// stand-in server on this computer whose answers can be held back, with the
// limits lowered so that they are reached in a fraction of a second.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import { listenForTest, until } from './helpers/stand-in-plex.js';

const TOKEN = 'dummy-server-token';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'heldover-test-'));
process.env.PLEX_TOKEN = TOKEN;
process.env.DISABLE_MDNS = '1';
// The stand-in server here is plain http on this computer. A listed plain
// http address is used only when the owner has asked for that.
process.env.PLEX_ALLOW_HTTP = '1';
for (const key of ['TMDB_API_KEY', 'OMDB_API_KEY', 'MDBLIST_API_KEY', 'FANART_API_KEY', 'TRUST_PROXY']) delete process.env[key];

const SERVER = 'stand-in-deadline';
const PAGE_SIZE = 500; // as in plex-library.js
const films = (section, count) =>
  Array.from({ length: count }, (_, n) => ({ ratingKey: String(section * 100000 + n), type: 'movie', title: `Dummy Film ${section}-${n}`, year: 2000 }));

// What the stand-in does with each library:
//   'stall'   headers and one byte at once, then nothing more
//   'trickle' headers at once, then one byte every 30 ms, without end
//   a list    an ordinary library, each page answered after `pageDelayMs`
const libraries = {
  1: 'stall',
  2: 'stall',
  3: films(3, 3),
  4: 'trickle',
  5: films(5, 5600), // twelve pages
  6: 'stall',
  7: films(7, 2),
  // Three pages: the first is ordinary, the second is not JSON, the third stalls.
  8: 'breaks on its second page',
};
const plex = {
  pageDelayMs: 0,
  sectionList: 'ok', // or 'stall'
  held: new Set(),
  // Answers the app hung up on before they had ended.
  closedEarly: 0,
  pages: [],
  pagesOf: (section) => plex.pages.filter((p) => p === String(section)).length,
  /** Let every answer that is being held back end, as valid JSON. */
  release() {
    for (const hold of plex.held) hold.end();
    plex.held.clear();
  },
};
const EMPTY_PAGE = JSON.stringify({ MediaContainer: { size: 0, totalSize: 0, Metadata: [] } });

/** Send the headers and one byte now; the rest when released (or never). */
function holdBack(res, rest, trickle) {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.write(' ');
  const timer = trickle ? setInterval(() => res.write(' '), 30) : null;
  const hold = {
    end() {
      clearInterval(timer);
      if (!res.writableEnded) res.end(rest);
    },
  };
  plex.held.add(hold);
  res.on('close', () => {
    clearInterval(timer);
    plex.held.delete(hold);
  });
}

const server = http.createServer((req, res) => {
  res.on('close', () => {
    if (!res.writableFinished) plex.closedEarly += 1;
  });
  const url = new URL(req.url, 'http://stand-in');
  const json = (body) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  if (url.pathname === '/identity') return json({ MediaContainer: { machineIdentifier: SERVER } });
  if (url.pathname === '/library/sections') {
    const list = { MediaContainer: { Directory: Object.keys(libraries).map((key) => ({ key, type: 'movie', title: `Films ${key}` })) } };
    if (plex.sectionList === 'stall') return holdBack(res, JSON.stringify(list), false);
    return json(list);
  }
  const page = url.pathname.match(/^\/library\/sections\/(\d+)\/all$/);
  if (!page) {
    res.writeHead(404);
    return res.end();
  }
  plex.pages.push(page[1]);
  const library = libraries[page[1]];
  const start = Number(url.searchParams.get('X-Plex-Container-Start') || 0);
  if (page[1] === '8') {
    if (start === 0) return json({ MediaContainer: { size: PAGE_SIZE, totalSize: 3 * PAGE_SIZE, Metadata: films(8, PAGE_SIZE) } });
    if (start === 2 * PAGE_SIZE) return holdBack(res, EMPTY_PAGE, false);
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end('this is not JSON');
  }
  if (typeof library === 'string') return holdBack(res, EMPTY_PAGE, library === 'trickle');
  const slice = library.slice(start, start + PAGE_SIZE);
  setTimeout(() => json({ MediaContainer: { size: slice.length, totalSize: library.length, Metadata: slice } }), plex.pageDelayMs);
  return undefined;
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
plex.uri = `http://127.0.0.1:${server.address().port}`;

// plex.tv is played inside this process: it names the one stand-in server.
const realFetch = globalThis.fetch;
const refused = [];
globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
  if (url.hostname === '127.0.0.1') return realFetch(input, init);
  if (url.hostname === 'plex.tv' && url.pathname === '/api/v2/resources') {
    const resource = {
      name: 'Stand-in', provides: 'server', owned: true, presence: true, clientIdentifier: SERVER, accessToken: TOKEN,
      connections: [{ uri: plex.uri, local: true, protocol: 'http' }],
    };
    return new Response(JSON.stringify([resource]), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  refused.push(`${url.hostname}${url.pathname}`);
  return new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } });
};

const { app } = await import('../src/app.js');
await import('../src/routes/library.js');
const plexLibrary = await import('../src/plex-library.js');
const plexConnections = await import('../src/plex-connections.js');
const { getLibraryItems, getLibraries } = plexLibrary;
const { call, close } = await listenForTest(app);

after(async () => {
  plexLibrary.setReadLimitsForTests?.();
  plex.release();
  await close();
  server.closeAllConnections();
  server.close();
});

// Both ways a page is asked for: through the server's list of connections,
// and straight at one address.
const forms = [
  ['through the list of connections', [{ uri: plex.uri, local: true, protocol: 'http' }]],
  ['straight at one address', null],
];
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** `promise`, or a failure when it has not settled in `ms`: no check here waits on a stalled answer for good. */
function within(promise, ms, what) {
  let timer;
  const late = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} was still waiting after ${ms} ms`)), ms);
  });
  promise.catch(() => {});
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

const outOfTime = (err) => {
  assert.equal(err.name, 'TimeoutError');
  assert.equal(err.message, 'No answer in time');
  return true;
};

test('the real limits: two minutes for one page, headers and body together', () => {
  assert.equal(plexConnections.PLEX_REQUEST_TIMEOUT_MS, 120_000);
});

test('a page whose body stalls after its headers is given up on at the deadline', async () => {
  plexLibrary.setReadLimitsForTests?.({ pageTimeoutMs: 300 });
  try {
    for (const [form, connections] of forms) {
      const closedBefore = plex.closedEarly;
      const started = Date.now();
      await assert.rejects(within(getLibraryItems(plex.uri, '1', TOKEN, connections), 2000, `the read ${form}`), outOfTime, form);
      assert.ok(Date.now() - started >= 250, `${form}: not before the deadline`);
      await until(() => plex.closedEarly === closedBefore + 1, `the request ${form} to be closed`, 1000);
    }
  } finally {
    plex.release();
  }
});

test('a body that trickles in, a byte at a time, is ended by the same deadline', async () => {
  plexLibrary.setReadLimitsForTests?.({ pageTimeoutMs: 300 });
  try {
    for (const [form, connections] of forms) {
      await assert.rejects(within(getLibraryItems(plex.uri, '4', TOKEN, connections), 2000, `the read ${form}`), outOfTime, form);
    }
  } finally {
    plex.release();
  }
});

test('two stalled answers do not keep both places for reads: another library is read once they run out of time', async () => {
  plexLibrary.setReadLimitsForTests?.({ pageTimeoutMs: 300 });
  assert.equal(plexLibrary.MAX_LIBRARY_READS, 2);
  const connections = forms[0][1];
  try {
    // Background reads (no device waiting), as the warm-up and the six-hour scan make them.
    const first = getLibraryItems(plex.uri, '1', TOKEN, connections);
    const second = getLibraryItems(plex.uri, '2', TOKEN, connections);
    const third = getLibraryItems(plex.uri, '3', TOKEN, connections);
    // Looked at below; until then a failure of theirs is not an unhandled one.
    for (const read of [first, second]) read.catch(() => {});
    await pause(100);
    assert.equal(plex.pagesOf(3), 0, 'both places are taken, so library 3 waits');
    const items = await within(third, 2000, 'the read of library 3');
    assert.equal(items.length, 3);
    await assert.rejects(first, outOfTime);
    await assert.rejects(second, outOfTime);
  } finally {
    plex.release();
  }
});

test('a healthy read of many pages is not ended by the deadline: the limit is for one page, not for the library', async () => {
  plexLibrary.setReadLimitsForTests?.({ pageTimeoutMs: 300 });
  plex.pageDelayMs = 100;
  try {
    for (const [form, connections] of forms) {
      const started = Date.now();
      const items = await getLibraryItems(plex.uri, '5', TOKEN, connections);
      assert.equal(items.length, 5600, form);
      assert.ok(Date.now() - started > 300, `${form}: the whole read took longer than the limit for one page`);
    }
  } finally {
    plex.pageDelayMs = 0;
  }
});

test('when the only one waiting leaves while a page body is on its way, that request ends at once and the place is free', async () => {
  // A long limit, so that it is the leaving that ends the request.
  plexLibrary.setReadLimitsForTests?.({ pageTimeoutMs: 5000 });
  try {
    for (const [form, connections] of forms) {
      const closedBefore = plex.closedEarly;
      const waiting = new AbortController();
      const read = getLibraryItems(plex.uri, '6', TOKEN, connections, { signal: waiting.signal });
      setTimeout(() => waiting.abort(), 100);
      await assert.rejects(read);
      await until(() => plex.closedEarly === closedBefore + 1, `the request ${form} to be closed when its waiter left`, 1000);
    }
    // Both places are free again.
    const [a, b] = await within(
      Promise.all([getLibraryItems(plex.uri, '3', TOKEN, forms[0][1]), getLibraryItems(plex.uri, '7', TOKEN, forms[0][1])]),
      1000,
      'two reads after the stalled ones were left'
    );
    assert.deepEqual([a.length, b.length], [3, 2]);
  } finally {
    plex.release();
  }
});

test('a device that hangs up on a library whose page has stalled frees the place for the next device', async () => {
  plexLibrary.setReadLimitsForTests?.({ pageTimeoutMs: 5000 });
  try {
    const listed = await call('GET', '/api/libraries');
    assert.equal(listed.body.libraries.length, Object.keys(libraries).length);

    const closedBefore = plex.closedEarly;
    const hangUps = ['1', '2'].map((section) => {
      const hangUp = new AbortController();
      const request = call('GET', `/api/library/${SERVER}/${section}`, { lookOnly: true, signal: hangUp.signal });
      setTimeout(() => hangUp.abort(), 150);
      return request;
    });
    for (const request of hangUps) await assert.rejects(request);
    await until(() => plex.closedEarly === closedBefore + 2, 'both stalled requests to be closed', 1000);

    const next = await within(call('GET', `/api/library/${SERVER}/7`, { lookOnly: true }), 1000, 'the next device');
    assert.equal(next.status, 200);
    assert.equal(next.body.items.length, 2);
  } finally {
    plex.release();
  }
});

test('when one page of a read fails, the pages asked for alongside it are given up on too', async () => {
  plexLibrary.setReadLimitsForTests?.({ pageTimeoutMs: 5000 });
  try {
    for (const [form, connections] of forms) {
      const closedBefore = plex.closedEarly;
      await assert.rejects(within(getLibraryItems(plex.uri, '8', TOKEN, connections), 1000, `the read ${form}`), SyntaxError, form);
      await until(() => plex.closedEarly === closedBefore + 1, `the stalled page ${form} to be closed once the read had failed`, 1000);
    }
  } finally {
    plex.release();
  }
});

test("a server's list of sections has a shorter limit of its own, which also covers the body", async () => {
  plexLibrary.setReadLimitsForTests?.({ sectionListTimeoutMs: 200 });
  plex.sectionList = 'stall';
  try {
    for (const [form, connections] of forms) {
      const closedBefore = plex.closedEarly;
      await assert.rejects(within(getLibraries(plex.uri, TOKEN, connections), 1500, `the list ${form}`), /TimeoutError|aborted due to timeout/, form);
      await until(() => plex.closedEarly === closedBefore + 1, `the request ${form} to be closed`, 1000);
    }
  } finally {
    plex.sectionList = 'ok';
    plex.release();
  }
  assert.equal((await getLibraries(plex.uri, TOKEN, forms[0][1])).length, Object.keys(libraries).length, 'an ordinary list is read as before');
});

test('nothing in these checks left this computer', () => {
  assert.deepEqual(refused, []);
});
