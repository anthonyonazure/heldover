// A device can read only the libraries the app lists: a server's movie and
// show libraries. The list used to shape what was shown and nothing more, so a
// request could name any section number and the server's token fetched it, a
// photo or music section included. Runs against a throwaway data folder and a
// stand-in Plex server.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { DUMMY_TOKEN, listenForTest, startStandInPlex, stubPlexTv, until } from './helpers/stand-in-plex.js';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'heldover-test-'));
process.env.PLEX_TOKEN = DUMMY_TOKEN;
// The stand-in servers here are plain http on this computer. A listed plain
// http address is used only when the owner has asked for that.
process.env.PLEX_ALLOW_HTTP = '1';
for (const key of ['TMDB_API_KEY', 'OMDB_API_KEY', 'MDBLIST_API_KEY', 'FANART_API_KEY', 'TRUST_PROXY']) delete process.env[key];

const SERVER = 'stand-in-listed';
const plex = await startStandInPlex({
  serverKey: SERVER,
  sections: [
    { key: '1', type: 'movie', title: 'Films' },
    { key: '2', type: 'show', title: 'Series' },
    { key: '5', type: 'photo', title: 'Dummy Photos' },
    { key: '6', type: 'artist', title: 'Dummy Music' },
    { key: '7', type: 'movie', title: 'More Films' },
  ],
  items: {
    1: [{ ratingKey: '11', type: 'movie', title: 'Dummy Film', year: 1999, Role: [{ tag: 'Dummy Actor' }], Director: [{ tag: 'Dummy Director' }] }],
    2: [{ ratingKey: '21', type: 'show', title: 'Dummy Series', year: 2005 }],
    5: [{ ratingKey: '501', type: 'photo', title: 'DUMMY album one', year: 2021, summary: 'dummy caption' }],
    6: [{ ratingKey: '601', type: 'artist', title: 'DUMMY artist', Role: [{ tag: 'Dummy Performer' }] }],
    7: [{ ratingKey: '71', type: 'movie', title: 'Dummy Film Seven', year: 2010 }],
  },
});
const refused = stubPlexTv([plex]);

const { app } = await import('../src/app.js');
await import('../src/routes/library.js');
await import('../src/routes/search.js');
await import('../src/routes/streaming-stats.js');
await import('../src/routes/discovery.js');
const cache = await import('../src/library-cache.js');
const { call, close } = await listenForTest(app);

// A copy of the photo section, stored the way the old code stored one when a
// device named it.
cache.setCachedItems(SERVER, '5', [{ ratingKey: '501', type: 'photo', title: 'DUMMY album one' }]);

after(async () => {
  await close();
  await plex.stop();
});

/** Every route in this group that takes a library from the request, for one section. */
const routesFor = (section) => [
  `/api/library/${SERVER}/${section}`,
  `/api/library/${SERVER}/${section}?refresh=true`,
  `/api/stats/${SERVER}/${section}`,
  `/api/random/${SERVER}/${section}`,
  `/api/actors?serverKey=${SERVER}&libraryKey=${section}`,
  `/api/directors?serverKey=${SERVER}&libraryKey=${section}`,
  `/api/discovery/recently-added?serverKey=${SERVER}&libraryKey=${section}`,
];

test('the app lists the movie and show libraries and nothing else', async () => {
  const res = await call('GET', '/api/libraries');
  assert.deepEqual(res.body.libraries.map((lib) => `${lib.key}:${lib.type}`).sort(), ['1:movie', '2:show', '7:movie']);
});

test('a listed library is served', async () => {
  const res = await call('GET', `/api/library/${SERVER}/1`, { lookOnly: true });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.items.map((item) => item.title), ['Dummy Film']);
  assert.equal(plex.readsOf(1), 1);

  const actors = await call('GET', `/api/actors?serverKey=${SERVER}&libraryKey=1`, { lookOnly: true });
  assert.deepEqual(actors.body.actors, ['Dummy Actor']);
  const stats = await call('GET', `/api/stats/${SERVER}/2`, { lookOnly: true });
  assert.equal(stats.status, 200);
});

test('a section the app does not list is refused on every route, and Plex is never asked for it', async () => {
  for (const section of ['5', '6']) {
    for (const route of routesFor(section)) {
      for (const lookOnly of [true, false]) {
        const res = await call('GET', route, { lookOnly });
        assert.equal(res.status, 404, route);
        assert.equal(res.body.error, 'Library not found', route);
        assert.equal(JSON.stringify(res.body).includes('DUMMY'), false, route);
      }
    }
    assert.equal(plex.pagesOf(section), 0, `the stand-in server heard nothing about section ${section}`);
    assert.equal(cache.getCachedItems(SERVER, section), null, `nothing is stored for section ${section}`);
  }
});

test('a copy of an unlisted section stored before this rule is not served, and is cleared away', async () => {
  const res = await call('GET', `/api/discovery/hidden-gems?serverKey=${SERVER}&libraryKey=5`, { lookOnly: true });
  assert.equal(res.status, 404);
  assert.equal(cache.getCachedItems(SERVER, '5'), null);
  assert.notEqual(cache.getCachedItems(SERVER, '1'), null, 'the stored copy of a listed library stays');
});

test('"07" does not pass for library 7, and neither does anything that is not its exact key', async () => {
  for (const lookAlike of ['07', '7.0', ' 7', '7 ', '+7', '0x7', '7%2F..%2F5', '7,5']) {
    const res = await call('GET', `/api/library/${SERVER}/${encodeURIComponent(lookAlike)}`);
    assert.equal(res.status, 404, lookAlike);
    assert.equal(res.body.error, 'Library not found', lookAlike);
  }
  const twice = await call('GET', `/api/actors?serverKey=${SERVER}&libraryKey=7&libraryKey=5`);
  assert.equal(twice.status, 404);
  const askedForSeven = plex.seen.filter((r) => r.section !== null && Number(r.section) === 7);
  assert.deepEqual(askedForSeven, [], 'the stand-in server was not asked for library 7 under any of those names');

  const exact = await call('GET', `/api/library/${SERVER}/7`);
  assert.equal(exact.status, 200);
  assert.deepEqual(exact.body.items.map((item) => item.title), ['Dummy Film Seven']);
});

test('an unknown server has no listed libraries', async () => {
  const res = await call('GET', '/api/library/no-such-server/1');
  assert.equal(res.status, 404);
  assert.equal(res.body.error, 'Library not found');
});

test('asking again and again for unlisted sections does not make Plex list its sections each time', async () => {
  const listsBefore = plex.seen.filter((r) => r.path === '/library/sections').length;
  for (let i = 0; i < 5; i += 1) await call('GET', `/api/library/${SERVER}/${50 + i}`, { lookOnly: true });
  const listsAfter = plex.seen.filter((r) => r.path === '/library/sections').length;
  assert.equal(listsAfter, listsBefore, 'the list read a moment ago decides');
});

test('a listed library keeps working from the stored copy while its server cannot list its sections', async () => {
  await until(() => cache.getCachedItems(SERVER, '1'), 'library 1 to be stored');
  plex.sectionListDown = true;
  const pagesBefore = plex.pagesOf(1);
  const res = await call('GET', `/api/library/${SERVER}/1`, { lookOnly: true });
  assert.equal(res.status, 200);
  assert.equal(res.body.fromCache, true);
  assert.equal(plex.pagesOf(1), pagesBefore, 'served from the stored copy');
});

test('a listed library keeps working from the stored copy while its server is unreachable', async () => {
  await plex.stop();
  const res = await call('GET', `/api/library/${SERVER}/1`, { lookOnly: true });
  assert.equal(res.status, 200);
  assert.equal(res.body.fromCache, true);
  assert.deepEqual(res.body.items.map((item) => item.title), ['Dummy Film']);

  const rows = await call('GET', `/api/discovery/recently-added?serverKey=${SERVER}&libraryKey=1`, { lookOnly: true });
  assert.equal(rows.status, 200);

  const unlisted = await call('GET', `/api/library/${SERVER}/5`, { lookOnly: true });
  assert.equal(unlisted.status, 404, 'and an unlisted section is still refused');
});

test('the list is written down: after a restart, with the server still unreachable, it still decides', () => {
  // A fresh process on the same data folder is what a restart is.
  const plexLibrary = fileURLToPath(new URL('../src/plex-library.js', import.meta.url));
  const server = { clientIdentifier: SERVER, uri: plex.uri, reachable: true, connections: [{ uri: plex.uri, local: true, protocol: 'http' }] };
  const script = `
    console.log = () => {}; console.warn = () => {};
    const { isListedLibrary, isListedItem } = await import(${JSON.stringify(plexLibrary)});
    const server = ${JSON.stringify(server)};
    const answers = {};
    for (const key of ['1', '2', '7', '5', '6', '01', '']) answers[key] = await isListedLibrary(server, key, 'dummy-server-token');
    answers.itemInListed = await isListedItem(server, { MediaContainer: { librarySectionID: 1, Metadata: [{ ratingKey: '11' }] } }, 'dummy-server-token');
    answers.itemInUnlisted = await isListedItem(server, { MediaContainer: { Metadata: [{ ratingKey: '501', librarySectionID: 5 }] } }, 'dummy-server-token');
    answers.itemWithNoSection = await isListedItem(server, { MediaContainer: { Metadata: [{ ratingKey: '9' }] } }, 'dummy-server-token');
    process.stdout.write(JSON.stringify(answers));
    process.exit(0);
  `;
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { PATH: process.env.PATH, DATA_DIR: process.env.DATA_DIR },
    encoding: 'utf8',
  });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout), {
    1: true, 2: true, 7: true, 5: false, 6: false, '01': false, '': false,
    itemInListed: true, itemInUnlisted: false, itemWithNoSection: false,
  });
});

test('nothing in these checks left this computer', () => {
  assert.deepEqual(refused, []);
});
