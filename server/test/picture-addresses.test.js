// The picture route serves only a picture address the app itself issued.
//
// GET /api/image used to fetch the picture of any item number on a known Plex
// server, with that server's token. A device that may only look could count
// through the numbers and be sent pictures of items the app never lists: the
// thumbnails of a friend's personal photos, say. Every address the app hands
// out now carries a signature made with this install's own key, and the route
// refuses anything else before it looks at a stored poster or asks plex.tv or
// a Plex server.
//
// Stand-in Plex servers on this computer, a stand-in for plex.tv, throwaway
// data folders and dummy tokens. Nothing leaves 127.0.0.1.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';

const newDataDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'heldover-test-'));
process.env.DATA_DIR = newDataDir();
process.env.PLEX_TOKEN = 'dummy-account-token';
process.env.DISABLE_MDNS = '1';
// The stand-in servers here are plain http on this computer. A listed plain
// http address is used only when the owner has asked for that.
process.env.PLEX_ALLOW_HTTP = '1';
for (const key of ['TMDB_API_KEY', 'OMDB_API_KEY', 'MDBLIST_API_KEY', 'FANART_API_KEY', 'TRUST_PROXY']) delete process.env[key];

const SERVER_TOKEN = 'dummy-server-token';
const FILMS = [
  { ratingKey: '11', type: 'movie', title: 'Dummy Film', year: 1999, thumb: '/library/metadata/11/thumb/1700000011' },
  { ratingKey: '12', type: 'movie', title: 'Dummy Film Two', year: 2001, thumb: '/library/metadata/12/thumb/1700000012' },
];
const open = [];

/** A stand-in Plex server on this computer that remembers what it was asked. */
function standInPlex(serverKey) {
  return new Promise((resolve) => {
    const plex = {
      serverKey,
      seen: [],
      /** Requests for a picture: the resizer, or the picture itself. */
      pictures: () => plex.seen.filter((r) => r.path === '/photo/:/transcode' || /\/thumb(\/\d+)?$/.test(r.path)),
    };
    const json = (res, body) => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(body));
    };
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://stand-in');
      if (url.pathname === '/identity') return json(res, { MediaContainer: { machineIdentifier: serverKey } });
      plex.seen.push({ path: url.pathname, token: req.headers['x-plex-token'] || null });
      if (req.headers['x-plex-token'] !== SERVER_TOKEN) {
        res.statusCode = 401;
        return json(res, { error: 'unauthorized' });
      }
      if (url.pathname === '/library/sections') {
        return json(res, {
          MediaContainer: {
            Directory: [
              { key: '1', type: 'movie', title: 'Films' },
              { key: '2', type: 'show', title: 'Series' },
            ],
          },
        });
      }
      if (url.pathname === '/library/sections/1/all') {
        const start = Number(url.searchParams.get('X-Plex-Container-Start') || 0);
        const slice = FILMS.slice(start);
        return json(res, { MediaContainer: { size: slice.length, totalSize: FILMS.length, Metadata: slice } });
      }
      // The shows a device follows in the episode-alert case (items 21 to 29),
      // all in listed section 2.
      const show = url.pathname.match(/^\/library\/metadata\/(2\d)(\/allLeaves)?$/);
      if (show) {
        return json(res, {
          MediaContainer: { size: 3, librarySectionID: 2, Metadata: [{ ratingKey: show[1], type: 'show', title: 'Dummy Series', librarySectionID: 2 }] },
        });
      }
      if (url.pathname === '/photo/:/transcode') {
        // The resizer is told which picture in its `url` value.
        const wanted = (url.searchParams.get('url') || '').split('?')[0];
        res.setHeader('Content-Type', 'image/jpeg');
        return res.end(`PICTURE ${serverKey} ${wanted}`);
      }
      res.statusCode = 404;
      json(res, { error: 'not found' });
    });
    open.push(server);
    server.listen(0, '127.0.0.1', () => {
      plex.base = `http://127.0.0.1:${server.address().port}`;
      resolve(plex);
    });
  });
}

const friend = await standInPlex('stand-in-friend');
const other = await standInPlex('stand-in-other');

// A third listed server, on the default https port, the way Plex writes one:
// with the port spelled out. Played by the stand-in for fetch below.
const DEFAULT_PORT_ORIGIN = 'https://default-port.example';
const DEFAULT_PORT_AS_PLEX_WRITES_IT = `${DEFAULT_PORT_ORIGIN}:443`;
const defaultPort = { seen: [] };

// plex.tv is played by a stand-in that counts how often it is asked.
const plexTv = { asked: 0 };
const realFetch = globalThis.fetch;
const reply = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
globalThis.fetch = async (input, init) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  if (url.hostname === '127.0.0.1') return realFetch(input, init);
  if (url.hostname === 'plex.tv') {
    plexTv.asked += 1;
    const listed = (plex) => ({
      name: plex.serverKey,
      provides: 'server',
      owned: true,
      presence: true,
      clientIdentifier: plex.serverKey,
      accessToken: SERVER_TOKEN,
      connections: [{ uri: plex.base, local: true, protocol: 'http' }],
    });
    return reply([
      listed(friend),
      listed(other),
      {
        name: 'Default port server',
        provides: 'server',
        owned: false,
        presence: true,
        clientIdentifier: 'default-port',
        accessToken: SERVER_TOKEN,
        connections: [{ uri: DEFAULT_PORT_AS_PLEX_WRITES_IT, local: false, protocol: 'https' }],
      },
    ]);
  }
  if (url.origin === DEFAULT_PORT_ORIGIN) {
    if (url.pathname === '/identity') return reply({ MediaContainer: { machineIdentifier: 'default-port' } });
    defaultPort.seen.push(url.pathname);
    return new Response('PICTURE fetched again', { status: 200, headers: { 'Content-Type': 'image/jpeg' } });
  }
  throw new TypeError('fetch failed');
};

const { app } = await import('../src/app.js');
const { warmPostersFor } = await import('../src/routes/servers-posters.js');
await import('../src/routes/library.js');
await import('../src/routes/watchlist.js');
await import('../src/routes/lists.js');
await import('../src/routes/subscriptions.js');
const images = await import('../src/plex-images.js');
const posterCache = await import('../src/poster-cache.js');
const libraryCache = await import('../src/library-cache.js');
const corpus = await import('../src/corpus-index.js');
const monitor = await import('../src/monitor.js');
const watchLater = await import('../src/watch-later.js');
const watchlist = await import('../src/watchlist.js');
const subscriptions = await import('../src/subscriptions.js');
const swipe = await import('../src/swipe.js');
const { openRatingsDb } = await import('../src/db.js');
// Loaded this way so that a version of the app without the one-time signing
// still runs every case here and reports each one, instead of failing to load.
const pictureAddresses = await import('../src/picture-addresses.js').catch(() => null);

const listener = await new Promise((resolve) => {
  const l = app.listen(0, '127.0.0.1', () => resolve(l));
});
open.push(listener);
const appBase = `http://127.0.0.1:${listener.address().port}`;
const db = openRatingsDb();

after(() => {
  globalThis.fetch = realFetch;
  db.close();
  for (const server of open) server.close();
});

const get = (address) => realFetch(`${appBase}${address}`);
const getJson = async (address) => (await get(address)).json();
const post = async (address, body) => {
  const res = await realFetch(`${appBase}${address}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The parts of a picture address, as a browser would send them. */
const partsOf = (address) => new URLSearchParams(String(address).split('?')[1] || '');
/** A picture address written by hand, as a device that makes one up would. */
const madeUp = (server, imagePath, sig) =>
  `/api/image?${new URLSearchParams(sig === undefined ? { server, path: imagePath } : { server, path: imagePath, sig })}`;
/** Did the app issue this address? Asked of the app's own check. */
const issued = (address) => {
  const parts = images.readPictureAddress(address);
  return Boolean(parts) && images.isIssuedPicture(parts.server, parts.path, parts.sig);
};

test('a made-up picture address is refused before the stored posters are looked at and before plex.tv or a Plex server is asked', async () => {
  // A poster of item 12 is on disk from earlier. The app has just started and
  // holds no server list yet, so anything that needed one would ask plex.tv.
  const stored = '/library/metadata/12/thumb/1700000012';
  await posterCache.getPoster(friend.base, stored, async () => Buffer.from('STORED POSTER'), 'w400');

  const attempts = [
    madeUp(friend.base, stored),
    madeUp(friend.base, '/library/metadata/987654/thumb'),
    madeUp(friend.base, stored, ''),
    madeUp(friend.base, stored, 'AAAAAAAAAAAAAAAAAAAAAA'),
    `${madeUp(friend.base, stored)}&sig=a&sig=b`,
  ];
  for (const address of attempts) {
    const res = await get(address);
    assert.equal(res.status, 403, address);
    assert.equal(res.headers.get('x-poster-cache'), null, 'nothing came off the disk');
    assert.notEqual(await res.text(), 'STORED POSTER');
  }
  assert.equal(plexTv.asked, 0, 'plex.tv was not asked');
  assert.equal(friend.seen.length, 0, 'the Plex server was not asked');
});

let filmAddress;

test('a picture address the app issued is served, and comes off the disk the second time', async () => {
  const library = await getJson(`/api/library/${friend.serverKey}/1`);
  assert.equal(library.items.length, 2);
  filmAddress = library.items.find((item) => item.ratingKey === '11').thumb;
  const parts = partsOf(filmAddress);
  assert.equal(parts.get('server'), friend.base);
  assert.equal(parts.get('path'), '/library/metadata/11/thumb/1700000011');
  assert.match(parts.get('sig') || '', /^[A-Za-z0-9_-]{22}$/, 'the address carries a signature');

  const first = await get(filmAddress);
  assert.equal(first.status, 200);
  assert.equal(first.headers.get('x-poster-cache'), 'miss');
  assert.equal(await first.text(), `PICTURE ${friend.serverKey} /library/metadata/11/thumb/1700000011`);
  assert.equal(friend.pictures().length, 1);
  assert.equal(friend.pictures()[0].token, SERVER_TOKEN);

  const second = await get(filmAddress);
  assert.equal(second.status, 200);
  assert.equal(second.headers.get('x-poster-cache'), 'hit');
  assert.equal(friend.pictures().length, 1, 'not fetched a second time');

  // However the server is written, it is the same picture and the same signature.
  const respelled = partsOf(filmAddress);
  respelled.set('server', `${friend.base}/any/spelling?x=1`);
  assert.equal((await get(`/api/image?${respelled}`)).headers.get('x-poster-cache'), 'hit');
});

test('the same address with its signature removed or changed, or moved to another item or another server, is refused and no Plex server hears of it', async () => {
  const sig = partsOf(filmAddress).get('sig') || '';
  const change = (edit) => {
    const parts = partsOf(filmAddress);
    edit(parts);
    return `/api/image?${parts}`;
  };
  const attempts = {
    'signature removed': change((p) => p.delete('sig')),
    'signature emptied': change((p) => p.set('sig', '')),
    'one letter of the signature changed': change((p) => p.set('sig', (sig.startsWith('A') ? 'B' : 'A') + sig.slice(1))),
    'signature cut short': change((p) => p.set('sig', sig.slice(0, 21))),
    'signature with more added': change((p) => p.set('sig', `${sig}A`)),
    'another item number': change((p) => p.set('path', '/library/metadata/10/thumb/1700000011')),
    'the next item, whose poster is on disk': change((p) => p.set('path', '/library/metadata/12/thumb/1700000012')),
    'another part of the same item': change((p) => p.set('path', '/library/metadata/11/art/1700000011')),
    'another listed server': change((p) => p.set('server', other.base)),
  };
  const before = { friend: friend.seen.length, other: other.seen.length, plexTv: plexTv.asked };
  for (const [what, address] of Object.entries(attempts)) {
    const res = await get(address);
    assert.equal(res.status, 403, what);
    assert.equal(res.headers.get('x-poster-cache'), null, what);
  }
  assert.equal(friend.seen.length, before.friend, 'the Plex server the address named was not asked');
  assert.equal(other.seen.length, before.other, 'and neither was the other one');
  assert.equal(plexTv.asked, before.plexTv);

  // The untouched address still works.
  assert.equal((await get(filmAddress)).status, 200);
});

test('posters are fetched ahead of time only for addresses the app issued', async () => {
  const asked = friend.pictures().length;
  warmPostersFor([{ thumb: madeUp(friend.base, '/library/metadata/555/thumb') }]);
  await pause(300);
  assert.equal(friend.pictures().length, asked, 'nothing was fetched for a made-up address');

  warmPostersFor([{ thumb: images.proxiedImageUrl(friend.base, '/library/metadata/556/thumb') }]);
  for (let i = 0; i < 200 && friend.pictures().length === asked; i += 1) await pause(10);
  assert.equal(friend.pictures().length, asked + 1, 'an issued one is');
});

test('a poster stored before the update under the server address with its default port written out is served from disk, with no request to the Plex server', async () => {
  // How the poster folder looks on an install from before the update: the
  // poster was stored under the address as Plex writes it, ":443" included.
  const imagePath = '/library/metadata/40/thumb/1690000040';
  await posterCache.getPoster(DEFAULT_PORT_AS_PLEX_WRITES_IT, imagePath, async () => Buffer.from('STORED BEFORE THE UPDATE'), 'w400');

  const address = images.proxiedImageUrl(DEFAULT_PORT_AS_PLEX_WRITES_IT, imagePath);
  const res = await get(address);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-poster-cache'), 'hit');
  assert.equal(await res.text(), 'STORED BEFORE THE UPDATE');
  // The address the app issues for it names the server by its origin.
  assert.equal(partsOf(address).get('server'), DEFAULT_PORT_ORIGIN);

  // Fetching ahead of time leaves it alone as well.
  warmPostersFor([{ thumb: address }]);
  await pause(300);
  assert.deepEqual(defaultPort.seen, [], 'the Plex server received no request');

  // The older spelling is worked out from the origin, never taken from the
  // request: an address that spells the server some other way finds the same
  // one stored poster, and stores nothing new.
  const respelled = partsOf(address);
  respelled.set('server', `${DEFAULT_PORT_AS_PLEX_WRITES_IT}/x?y=1`);
  assert.equal((await get(`/api/image?${respelled}`)).headers.get('x-poster-cache'), 'hit');
  assert.equal(posterCache.readCached(DEFAULT_PORT_ORIGIN, imagePath, 'w400'), null, 'no second copy was stored');
  assert.deepEqual(defaultPort.seen, []);
});

// ---------- The key ----------

const configModule = fileURLToPath(new URL('../src/config.js', import.meta.url));
const imagesModule = fileURLToPath(new URL('../src/plex-images.js', import.meta.url));
const addressesModule = fileURLToPath(new URL('../src/picture-addresses.js', import.meta.url));
const watchLaterModule = fileURLToPath(new URL('../src/watch-later.js', import.meta.url));
const dbModule = fileURLToPath(new URL('../src/db.js', import.meta.url));

/** Runs a script in its own process against a data folder, as a real start does, and returns what it reports. */
function start(dataDir, body, env = {}) {
  const script = `
    const config = await import(${JSON.stringify(configModule)});
    const images = await import(${JSON.stringify(imagesModule)});
    const result = {};
    ${body}
    console.log('RESULT ' + JSON.stringify(result));
  `;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { PATH: process.env.PATH, DATA_DIR: dataDir, DISABLE_MDNS: '1', ...env },
    encoding: 'utf8',
  });
  assert.equal(r.status, 0, r.stderr);
  return { ...JSON.parse(r.stdout.split('\n').find((l) => l.startsWith('RESULT ')).slice(7)), log: r.stdout + r.stderr };
}

const ISSUE = "result.address = images.proxiedImageUrl('https://friend-plex.example:32400', '/library/metadata/1/thumb/1700000001');";
const savedSettings = (dataDir) => JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8'));

test('two installs sign the same picture differently, and an address from one is refused by the other', () => {
  const [one, two] = [newDataDir(), newDataDir()];
  const first = start(one, ISSUE);
  const second = start(two, ISSUE);
  assert.match(partsOf(first.address).get('sig') || '', /^[A-Za-z0-9_-]{22}$/);
  assert.match(partsOf(second.address).get('sig') || '', /^[A-Za-z0-9_-]{22}$/);
  assert.notEqual(partsOf(first.address).get('sig'), partsOf(second.address).get('sig'));

  const judged = start(two, `
    const parts = images.readPictureAddress(${JSON.stringify(first.address)});
    result.fromTheOtherInstall = images.isIssuedPicture(parts.server, parts.path, parts.sig);
    const own = images.readPictureAddress(${JSON.stringify(second.address)});
    result.own = images.isIssuedPicture(own.server, own.path, own.sig);
  `);
  assert.deepEqual({ fromTheOtherInstall: judged.fromTheOtherInstall, own: judged.own }, { fromTheOtherInstall: false, own: true });
});

test('the key is kept in the settings file, survives a restart, does not depend on the PIN, and is in no address and no log line', () => {
  const dataDir = newDataDir();
  const first = start(dataDir, ISSUE);
  const key = savedSettings(dataDir).pictureKey;
  assert.match(key, /^[0-9a-f]{64}$/);
  assert.equal(fs.statSync(path.join(dataDir, 'config.json')).mode & 0o777, 0o600, 'readable only by this user');

  const again = start(dataDir, ISSUE);
  assert.equal(again.address, first.address, 'the same address after a restart');
  assert.equal(savedSettings(dataDir).pictureKey, key);

  const withPin = start(dataDir, `config.setPin('246810'); ${ISSUE}`);
  assert.equal(withPin.address, first.address, 'setting a PIN changes nothing');
  const pinCleared = start(dataDir, ISSUE, { RESET_PIN: '1' });
  assert.equal(pinCleared.address, first.address, 'clearing it changes nothing');
  assert.equal(savedSettings(dataDir).pictureKey, key);

  for (const run of [first, again, withPin, pinCleared]) {
    assert.equal(run.log.includes(key), false, 'the key is not printed');
    assert.equal(run.address.includes(key), false);
  }
});

// ---------- Addresses stored before the update ----------

// Addresses the way older versions stored them: unsigned, the server as Plex
// wrote it, and from longer ago with the Plex token in them.
const OLD_SERVER = DEFAULT_PORT_AS_PLEX_WRITES_IT;
const oldAddress = (id) => `/api/image?${new URLSearchParams({ server: OLD_SERVER, path: `/library/metadata/${id}/thumb/1690000000` })}`;
const oldTokenAddress = (id) => `${OLD_SERVER}/library/metadata/${id}/thumb/1690000000?X-Plex-Token=dummy-old-token`;
const TMDB_POSTER = 'https://image.tmdb.org/t/p/w500/dummy.jpg';

/** What a stored address should have become: ours, signed, for that item, with no token. */
function assertSigned(address, id, where) {
  assert.equal(typeof address, 'string', where);
  assert.equal(address.includes('X-Plex-Token'), false, where);
  const parts = partsOf(address);
  assert.equal(parts.get('server'), DEFAULT_PORT_ORIGIN, where);
  assert.equal(parts.get('path'), `/library/metadata/${id}/thumb/1690000000`, where);
  assert.equal(issued(address), true, where);
}

test('addresses stored before the update are signed once in every table, and nothing signs an address after that', async () => {
  assert.ok(pictureAddresses, 'the one-time signing exists');

  // Written straight into the database, as an older version left them.
  libraryCache.setCachedItems('default-port', '1', [
    { ratingKey: '101', title: 'Cached Film', thumb: oldAddress(101) },
    { ratingKey: '102', title: 'Cached Film From Longer Ago', thumb: oldTokenAddress(102) },
    { ratingKey: '103', title: 'Cached Film Without A Poster', thumb: null },
  ]);
  const corpusRow = db.prepare(
    "INSERT INTO corpus_index (server_key, rating_key, library_key, title, title_norm, year, type, thumb, tmdb_id) VALUES ('default-port', ?, '1', ?, ?, 2000, 'movie', ?, ?)"
  );
  corpusRow.run('201', 'Indexed Film', 'indexed film', oldAddress(201), '9201');
  corpusRow.run('202', 'Indexed Film From Longer Ago', 'indexed film from longer ago', oldTokenAddress(202), '9202');
  const snapshot = db.prepare(
    "INSERT INTO library_snapshots (server_key, library_key, library_title, item_key, title, year, type, thumb, added_at) VALUES ('default-port', '1', 'Films', ?, ?, 2000, 'movie', ?, datetime('now'))"
  );
  snapshot.run('301', 'New Film', oldAddress(301));
  snapshot.run('302', 'New Film From Longer Ago', oldTokenAddress(302));
  const queued = db.prepare("INSERT INTO watch_later (title, plex_key, thumb, position, profile_id) VALUES (?, ?, ?, ?, 1)");
  queued.run('Queued Film', '401', oldAddress(401), 0);
  queued.run('Queued Film From Longer Ago', '402', oldTokenAddress(402), 1);
  queued.run('Queued Film With A TMDB Poster', '403', TMDB_POSTER, 2);
  db.prepare("INSERT INTO watchlist (title, plex_key, thumb, profile_id) VALUES ('Listed Film', '501', ?, 1)").run(oldAddress(501));
  db.prepare("INSERT INTO show_subscriptions (title, plex_key, server_key, thumb) VALUES ('Followed Show', '601', 'default-port', ?)").run(oldAddress(601));
  db.prepare('INSERT INTO swipe_sessions (code, deck) VALUES (?, ?)').run(
    'TEST',
    JSON.stringify([{ ratingKey: '701', serverKey: 'default-port', title: 'Dealt Film', thumb: oldAddress(701) }])
  );

  const signed = pictureAddresses.signStoredPictureAddresses();
  assert.equal(signed, 11, 'every stored address of our own, and nothing else');

  // Each one read back the way the app reads it.
  const cached = libraryCache.getCachedItems('default-port', '1').items;
  assertSigned(cached[0].thumb, 101, 'library cache');
  assertSigned(cached[1].thumb, 102, 'library cache, token address');
  assert.equal(cached[2].thumb, null);
  const found = corpus.matchExternal([
    { tmdbId: '9201', type: 'movie', title: 'Indexed Film', year: 2000 },
    { tmdbId: '9202', type: 'movie', title: 'Indexed Film From Longer Ago', year: 2000 },
  ]);
  assertSigned(found.get('movie:9201').thumb, 201, 'search index');
  assertSigned(found.get('movie:9202').thumb, 202, 'search index, token address');
  const additions = Object.fromEntries(monitor.getNewAdditions(7).map((row) => [row.item_key, row.thumb]));
  assertSigned(additions['301'], 301, 'new additions');
  assertSigned(additions['302'], 302, 'new additions, token address');
  const queue = Object.fromEntries(watchLater.getQueue(1).map((row) => [row.plex_key, row.thumb]));
  assertSigned(queue['401'], 401, 'queue');
  assertSigned(queue['402'], 402, 'queue, token address');
  assert.equal(queue['403'], TMDB_POSTER, 'a TMDB poster is left as it was');
  assertSigned(watchlist.getWatchlist('all', 1).find((row) => row.plex_key === '501').thumb, 501, 'watchlist');
  assertSigned(subscriptions.getSubscriptions().find((row) => row.plex_key === '601').thumb, 601, 'episode alerts');
  assertSigned(swipe.getSession('TEST').deck[0].thumb, 701, 'swipe deck');

  // The stored text itself changed: nothing is being signed on the way out.
  assert.equal(db.prepare("SELECT thumb FROM watch_later WHERE plex_key = '401'").get().thumb, queue['401']);
  assert.equal(db.prepare('SELECT data FROM library_items_cache WHERE cache_key = ?').get('default-port:1').data.includes('X-Plex-Token'), false);

  // Once. An unsigned address that turns up later is not signed: not by a
  // second start, and not when the row is read.
  queued.run('Queued Later', '404', oldAddress(404), 3);
  assert.equal(pictureAddresses.signStoredPictureAddresses(), null, 'a second start does nothing');
  const later = (await getJson('/api/queue')).items.find((row) => row.plex_key === '404');
  assert.equal(later.thumb, oldAddress(404), 'it comes back as it was stored');
  assert.equal(issued(later.thumb), false);
  assert.equal((await get(later.thumb)).status, 403, 'and it is refused');
});

test('when the settings file is moved away and a new key is made, the stored addresses are signed again with it', () => {
  // Starting again from the setup screen is done by moving the settings file
  // away. The database stays, and its addresses were signed with the old key.
  const dataDir = newDataDir();
  const body = `
    await import(${JSON.stringify(watchLaterModule)});
    const { openRatingsDb } = await import(${JSON.stringify(dbModule)});
    const { signStoredPictureAddresses } = await import(${JSON.stringify(addressesModule)});
    const db = openRatingsDb();
    if (!db.prepare('SELECT COUNT(*) AS n FROM watch_later').get().n) {
      db.prepare("INSERT INTO watch_later (title, plex_key, thumb, position, profile_id) VALUES ('Queued Film', '401', ?, 0, 1)").run(${JSON.stringify(oldAddress(401))});
    }
    result.signed = signStoredPictureAddresses();
    result.thumb = db.prepare('SELECT thumb FROM watch_later').get().thumb;
    const parts = images.readPictureAddress(result.thumb);
    result.valid = images.isIssuedPicture(parts.server, parts.path, parts.sig);
  `;
  const first = start(dataDir, body);
  assert.deepEqual({ signed: first.signed, valid: first.valid }, { signed: 1, valid: true });
  const restart = start(dataDir, body);
  assert.deepEqual({ signed: restart.signed, valid: restart.valid, thumb: restart.thumb }, { signed: null, valid: true, thumb: first.thumb });

  fs.renameSync(path.join(dataDir, 'config.json'), path.join(dataDir, 'config.json.moved-away'));
  const newKey = start(dataDir, body);
  assert.deepEqual({ signed: newKey.signed, valid: newKey.valid }, { signed: 1, valid: true });
  assert.notEqual(newKey.thumb, first.thumb);
  assert.equal(start(dataDir, body).signed, null, 'and that is done once as well');
});

// ---------- What a browser sends ----------

test('a picture address sent by a browser is kept only when the app issued it, and never comes back signed', async () => {
  // Every route that stores a title together with a picture address from the
  // request. The device asks for item 999, which no answer ever named.
  const unsigned = madeUp(friend.base, '/library/metadata/999/thumb');
  const routes = {
    queue: {
      add: (thumb, n) => post('/api/queue', { title: `Queue ${n}`, plexKey: `q${n}`, thumb }),
      added: (answer) => answer.body.item,
      list: async () => (await getJson('/api/queue')).items,
    },
    watchlist: {
      add: (thumb, n) => post('/api/watchlist', { title: `Watchlist ${n}`, plexKey: `w${n}`, thumb }),
      added: (answer) => answer.body.item,
      list: async () => (await getJson('/api/watchlist')).items,
    },
    'episode alerts': {
      // Each a show in a listed library of the stand-in server (items 21 to 29).
      add: (thumb, n) =>
        post('/api/subscriptions', { title: `Show ${n}`, plexKey: String(n < 90 ? 20 + n : n - 62), serverKey: friend.serverKey, libraryKey: '2', thumb }),
      added: (answer) => answer.body.subscription,
      list: async () => (await getJson('/api/subscriptions')).subscriptions,
    },
  };
  const notKept = [
    unsigned,
    `${unsigned}&sig=AAAAAAAAAAAAAAAAAAAAAA`,
    `${friend.base}/library/metadata/999/thumb?X-Plex-Token=dummy-token`,
    'https://elsewhere.example/tracker.gif',
    'https://image.tmdb.org.elsewhere.example/t/p/w500/x.jpg',
  ];

  for (const [name, route] of Object.entries(routes)) {
    let n = 0;
    for (const thumb of notKept) {
      n += 1;
      const answer = await route.add(thumb, n);
      assert.equal(answer.status, 201, `${name}: the title is still added`);
      assert.equal(route.added(answer).thumb, null, `${name}: answered without a picture for ${thumb.slice(0, 40)}`);
    }
    // The app's own address for a listed film, and a TMDB poster, are kept.
    assert.equal(route.added(await route.add(filmAddress, 90)).thumb, filmAddress, name);
    assert.equal(route.added(await route.add(TMDB_POSTER, 91)).thumb, TMDB_POSTER, name);

    // The rows this case added (the earlier case left its own in these tables).
    const mine = (await route.list()).filter((row) => /^(Queue|Watchlist|Show) \d+$/.test(row.title));
    assert.equal(mine.length, notKept.length + 2, name);
    const kept = mine.map((row) => row.thumb).filter((thumb) => thumb !== null);
    assert.equal(kept.length, 2, `${name}: the other titles are stored without a picture`);
    for (const thumb of kept) {
      assert.equal(String(thumb).includes('/library/metadata/999/'), false, `${name}: nothing for item 999 is stored`);
      assert.ok(thumb === TMDB_POSTER || issued(thumb), `${name}: only issued addresses and TMDB posters are stored`);
    }
    assert.ok(kept.includes(filmAddress) && kept.includes(TMDB_POSTER), name);
  }

  // And the picture of item 999 is still not to be had.
  const before = friend.pictures().length;
  assert.equal((await get(unsigned)).status, 403);
  assert.equal(friend.pictures().length, before);
});
