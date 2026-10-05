// What the app stored of a library goes when the share ends.
//
// The app keeps a copy of each library it reads, and a written list of the
// libraries each server lists. Both used to stay after a friend stopped
// sharing a server: the server left the app's list, but any device on the
// home network could still read the copy made while the share lasted. The
// copies are now removed when plex.tv, in an answer it really gave, no longer
// names the server. Nothing is removed while plex.tv cannot be reached or a
// server is only switched off, slow or without a usable address.
//
// Two stand-in Plex servers on this computer ("mine", the owner's, and
// "friend", a shared one), a plex.tv played inside this process, dummy data,
// and a throwaway data folder.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';
import { DUMMY_TOKEN, listenForTest, startStandInPlex, until } from './helpers/stand-in-plex.js';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'heldover-test-'));
process.env.PLEX_TOKEN = DUMMY_TOKEN;
process.env.DISABLE_MDNS = '1';
// The stand-in servers here are plain http on this computer. A listed plain
// http address is used only when the owner has asked for that.
process.env.PLEX_ALLOW_HTTP = '1';
for (const key of ['TMDB_API_KEY', 'OMDB_API_KEY', 'MDBLIST_API_KEY', 'FANART_API_KEY', 'TRUST_PROXY']) delete process.env[key];

const MINE = 'stand-in-mine';
const FRIEND = 'stand-in-friend';
const film = (key) => ({ ratingKey: String(key), type: 'movie', title: `Dummy Film ${key}`, year: 2000, Role: [{ tag: 'Dummy Actor' }] });

// Kept by name, so a check can change what "mine" lists.
const mineSections = [
  { key: '1', type: 'movie', title: 'Films' },
  { key: '2', type: 'movie', title: 'More Films' },
];
const mine = await startStandInPlex({ serverKey: MINE, sections: mineSections, items: { 1: [film(11)], 2: [film(21), film(22)] } });
const friend = await startStandInPlex({
  serverKey: FRIEND,
  sections: [
    { key: '1', type: 'movie', title: 'Films' },
    { key: '2', type: 'show', title: 'Series' },
  ],
  items: { 1: [film(31)], 2: [{ ...film(41), type: 'show' }] },
});

// What plex.tv says about the friend's server, by the state it is in.
const friendAs = {
  shared: () => ({ ...friend.resource(), owned: false, connections: [{ uri: friend.uri, local: false, protocol: 'http' }] }),
  'no address': () => ({ ...friendAs.shared(), connections: [] }),
  'long offline': () => ({
    ...friendAs.shared(),
    presence: false,
    lastSeenAt: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString(),
  }),
};

// plex.tv, played inside this process. `says` is what it does next.
const plexTv = { says: 'shared' };
const realFetch = globalThis.fetch;
const refused = [];
const answer = (body, status = 200) => new Response(body, { status, headers: { 'content-type': 'application/json' } });
globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
  if (url.hostname === '127.0.0.1') return realFetch(input, init);
  if (url.hostname === 'plex.tv' && url.pathname === '/api/v2/resources') {
    if (plexTv.says === 'unreachable') throw new TypeError('fetch failed');
    if (plexTv.says === 'an error') return answer('{"error":"unavailable"}', 503);
    if (plexTv.says === 'not JSON') return answer('<html>maintenance</html>');
    if (plexTv.says === 'not a list') return answer('{"error":"try again"}');
    if (plexTv.says === 'no servers') return answer('[]');
    if (plexTv.says === 'friend gone') return answer(JSON.stringify([mine.resource()]));
    return answer(JSON.stringify([mine.resource(), friendAs[plexTv.says]()]));
  }
  refused.push(`${url.hostname}${url.pathname}`);
  return answer('{}', 404);
};

const app_ = await import('../src/app.js');
const { app } = app_;

// Each step of this test is a later look at plex.tv. The app honors a forced
// refresh of the server list at most once in 20 seconds and keeps a list for
// 60, so the clock moves on before every look.
const realNow = Date.now;
let skewMs = 0;
Date.now = () => realNow() + skewMs;
after(() => { Date.now = realNow; });
const ensureServers = (force = false) => {
  skewMs += 61_000;
  return app_.ensureServers(force);
};
await import('../src/routes/library.js');
await import('../src/routes/search.js');
await import('../src/routes/streaming-stats.js');
const cache = await import('../src/library-cache.js');
const plexLibrary = await import('../src/plex-library.js');
const corpus = await import('../src/corpus-index.js');
const { warmLibraries } = await import('../src/library-warmer.js');
const { call, close } = await listenForTest(app);

after(async () => {
  await close();
  await mine.stop();
  await friend.stop();
});

/** Ask plex.tv afresh, as the app does at least every few minutes, and return what was logged. */
async function askPlexTv(says) {
  plexTv.says = says;
  const lines = [];
  const realLog = console.log;
  console.log = (...args) => lines.push(args.join(' '));
  try {
    await ensureServers(true);
  } finally {
    console.log = realLog;
  }
  return lines;
}
const removalLines = (lines) => lines.filter((line) => /no longer on the account's list/.test(line));

/** What is on file for a server: its written list and which of libraries 1 and 2 have a stored copy. */
const onFile = (serverKey) => ({
  listed: cache.getListedLibraryKeys(serverKey).sort(),
  stored: ['1', '2'].filter((key) => cache.getCachedItems(serverKey, key) !== null),
});
const EVERYTHING = { listed: ['1', '2'], stored: ['1', '2'] };
const NOTHING = { listed: [], stored: [] };

/** How many titles the search index holds for each library of a server. */
function indexed(serverKey) {
  const db = new Database(path.join(process.env.DATA_DIR, 'ratings.db'), { readonly: true });
  try {
    const rows = db.prepare('SELECT library_key, COUNT(*) AS titles FROM corpus_index WHERE server_key = ? GROUP BY library_key').all(serverKey);
    return Object.fromEntries(rows.map((row) => [row.library_key, row.titles]));
  } finally {
    db.close();
  }
}

test('both servers are listed, and their libraries are read and stored', async () => {
  const listed = await call('GET', '/api/libraries');
  assert.equal(listed.body.libraries.length, 4);
  for (const [serverKey, libraryKey] of [[MINE, '1'], [MINE, '2'], [FRIEND, '1'], [FRIEND, '2']]) {
    const res = await call('GET', `/api/library/${serverKey}/${libraryKey}`, { lookOnly: true });
    assert.equal(res.status, 200);
    await until(() => cache.getCachedItems(serverKey, libraryKey), `library ${serverKey}/${libraryKey} to be stored`);
    // The search index, filled the way the background warm-up fills it.
    corpus.indexLibrary(serverKey, libraryKey, res.body.items);
  }
  assert.deepEqual(onFile(MINE), EVERYTHING);
  assert.deepEqual(onFile(FRIEND), EVERYTHING);
  assert.deepEqual(indexed(MINE), { 1: 1, 2: 2 });
});

test('an answer that still names both servers removes nothing', async () => {
  const lines = await askPlexTv('shared');
  assert.deepEqual(removalLines(lines), []);
  assert.deepEqual(onFile(FRIEND), EVERYTHING);
});

test('when plex.tv cannot be reached or its answer cannot be read, nothing is removed', async () => {
  for (const says of ['unreachable', 'an error', 'not JSON', 'not a list']) {
    plexTv.says = says;
    await assert.rejects(ensureServers(true), undefined, says);
    assert.deepEqual(onFile(FRIEND), EVERYTHING, says);
    assert.deepEqual(onFile(MINE), EVERYTHING, says);
    const res = await call('GET', `/api/library/${FRIEND}/1`, { lookOnly: true });
    assert.equal(res.status, 200, `${says}: the stored library still answers`);
    assert.equal(res.body.fromCache, true);
  }
});

test('an answer that names no server at all is not taken to mean every share has ended', async () => {
  const lines = await askPlexTv('no servers');
  assert.deepEqual(removalLines(lines), []);
  assert.deepEqual(onFile(FRIEND), EVERYTHING);
  assert.deepEqual(onFile(MINE), EVERYTHING);
  assert.deepEqual(plexLibrary.forgetListedLibrariesExcept?.([]), []);
  assert.deepEqual(plexLibrary.forgetListedLibrariesExcept?.(null), []);
  assert.deepEqual(onFile(MINE), EVERYTHING);
});

test('a library a listed server no longer lists loses its stored copy, its place on the list and its titles in the search index', async () => {
  await askPlexTv('shared');
  const servers = () => ensureServers();

  // A server in trouble: nothing is removed.
  mine.sectionListDown = true;
  await warmLibraries(servers, DUMMY_TOKEN);
  mine.sectionListDown = false;
  assert.deepEqual(onFile(MINE), EVERYTHING);
  assert.deepEqual(indexed(MINE), { 1: 1, 2: 2 });
  // A server that lists nothing for a moment, as one that is still starting
  // does: no stored copy and no title is thrown away because of it.
  const all = mineSections.splice(0);
  await warmLibraries(servers, DUMMY_TOKEN);
  assert.deepEqual(onFile(MINE).stored, ['1', '2']);
  assert.deepEqual(indexed(MINE), { 1: 1, 2: 2 });

  // The server now lists library 1 only.
  mineSections.push(all[0]);
  const lines = [];
  const realLog = console.log;
  console.log = (...args) => lines.push(args.join(' '));
  try {
    await warmLibraries(servers, DUMMY_TOKEN);
  } finally {
    console.log = realLog;
  }
  assert.deepEqual(onFile(MINE), { listed: ['1'], stored: ['1'] });
  assert.deepEqual(indexed(MINE), { 1: 1 }, 'the titles of library 2 have left the search index');
  assert.deepEqual(indexed(FRIEND), { 1: 1, 2: 1 }, 'and no other server is touched');
  const said = lines.filter((line) => /no longer lists/.test(line));
  assert.deepEqual(said, [`[corpus] removed 2 titles of libraries that server ${MINE} no longer lists`]);
  const gone = await call('GET', `/api/library/${MINE}/2`, { lookOnly: true });
  assert.equal(gone.status, 404);

  // Again: nothing more to remove, and nothing said.
  assert.equal(corpus.pruneUnlistedLibraries?.(MINE, ['1']), 0);
  assert.deepEqual(indexed(MINE), { 1: 1 });
});

test('a shared server that is switched off but still on the list keeps its stored libraries', async () => {
  await friend.stop();
  const lines = await askPlexTv('shared');
  assert.deepEqual(removalLines(lines), []);
  assert.deepEqual(onFile(FRIEND), EVERYTHING);
  const res = await call('GET', `/api/library/${FRIEND}/1`, { lookOnly: true });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.items.map((item) => item.title), ['Dummy Film 31']);
});

test('a server plex.tv names without a usable address keeps its stored libraries, though the app leaves it off its list', async () => {
  const lines = await askPlexTv('no address');
  assert.deepEqual((await ensureServers()).map((s) => s.clientIdentifier), [MINE]);
  assert.deepEqual(removalLines(lines), []);
  assert.deepEqual(onFile(FRIEND), EVERYTHING);
});

test('a shared server plex.tv has not seen for over a month is still named, and keeps its stored libraries', async () => {
  const lines = await askPlexTv('long offline');
  assert.deepEqual((await ensureServers()).map((s) => s.clientIdentifier), [MINE]);
  assert.deepEqual(removalLines(lines), []);
  assert.deepEqual(onFile(FRIEND), EVERYTHING);
});

test('a server plex.tv no longer names loses its written list and its stored libraries', async () => {
  const lines = await askPlexTv('friend gone');
  assert.deepEqual(onFile(FRIEND), NOTHING);
  assert.deepEqual(onFile(MINE), { listed: ['1'], stored: ['1'] }, 'the other server keeps what it had');

  assert.deepEqual(removalLines(lines), [
    `Server ${FRIEND} is no longer on the account's list at plex.tv: removed its 2 listed libraries and 2 stored copies`,
  ]);
  assert.equal(lines.some((line) => line.includes('Dummy')), false, 'no title is written to the log');

  for (const route of [
    `/api/library/${FRIEND}/1`,
    `/api/library/${FRIEND}/2`,
    `/api/stats/${FRIEND}/1`,
    `/api/random/${FRIEND}/1`,
    `/api/actors?serverKey=${FRIEND}&libraryKey=1`,
  ]) {
    const res = await call('GET', route, { lookOnly: true });
    assert.equal(res.status, 404, route);
    assert.equal(JSON.stringify(res.body).includes('Dummy'), false, route);
  }
  const still = await call('GET', `/api/library/${MINE}/1`, { lookOnly: true });
  assert.equal(still.status, 200);
});

test('it is safe to run again: the next answer removes nothing more and says nothing', async () => {
  const lines = await askPlexTv('friend gone');
  assert.deepEqual(removalLines(lines), []);
  assert.deepEqual(onFile(MINE), { listed: ['1'], stored: ['1'] });
  assert.deepEqual(plexLibrary.forgetListedLibrariesExcept?.([MINE]), []);
  assert.deepEqual(onFile(MINE), { listed: ['1'], stored: ['1'] });
});

test('after a restart the server is still forgotten', () => {
  // A fresh process on the same data folder is what a restart is.
  const file = fileURLToPath(new URL('../src/plex-library.js', import.meta.url));
  const script = `
    console.log = () => {}; console.warn = () => {};
    const { isRememberedLibrary } = await import(${JSON.stringify(file)});
    process.stdout.write(JSON.stringify({
      friend: isRememberedLibrary(${JSON.stringify(FRIEND)}, '1'),
      mine: isRememberedLibrary(${JSON.stringify(MINE)}, '1'),
    }));
    process.exit(0);
  `;
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { PATH: process.env.PATH, DATA_DIR: process.env.DATA_DIR },
    encoding: 'utf8',
  });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout), { friend: false, mine: true });
});

test('nothing in these checks left this computer', () => {
  assert.deepEqual(refused, []);
});
