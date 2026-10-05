// A device can use only items from the libraries the app lists: a server's
// movie and show libraries. The section half of that rule is in
// listed-libraries.test.js. This is the item half: a download, a cast to the
// TV, a play command to a Plex player and a subscription each take an item
// number from the request, and the server's token used to act on whatever
// number was named, a photo or a music track included.
//
// The real routes run on 127.0.0.1 against stand-ins: a Plex server with a
// movie, a show, a photo and a music section, a television and a Plex player.
// Dummy data and dummy tokens only, in a throwaway data folder.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import cp from 'child_process';
import { syncBuiltinESMExports } from 'module';
import { fileURLToPath } from 'url';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  DUMMY_SHORT_TOKEN, DUMMY_TOKEN,
  listenForTest, startStandInPlayer, startStandInPlex, stubPlexTv,
} from './helpers/stand-in-plex.js';
import { standInDiscovery, standInTv } from './tv-stand-ins.js';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'heldover-test-'));
process.env.PLEX_TOKEN = DUMMY_TOKEN;
// The stand-in servers here are plain http on this computer. A listed plain
// http address is used only when the owner has asked for that.
process.env.PLEX_ALLOW_HTTP = '1';
for (const key of ['TMDB_API_KEY', 'OMDB_API_KEY', 'MDBLIST_API_KEY', 'FANART_API_KEY', 'TRUST_PROXY', 'BIND_HOST']) delete process.env[key];

const SERVER = 'stand-in-items';
const FILE = Buffer.from('dummy-file-bytes-'.repeat(300));
const TV_HOST = '192.168.1.60';

/** One file behind an item, in a form the TV plays as it is unless `media` says otherwise. */
const withFile = (id, media = {}) => ({
  duration: 4000,
  Media: [{
    container: 'mp4', videoCodec: 'h264', audioCodec: 'aac', videoResolution: '1080', ...media,
    Part: [{ key: `/library/parts/${id}/file.mp4`, file: `/media/Dummy ${id}.mp4`, size: FILE.length }],
  }],
});
const episode = (id, index, title, viewCount = 0) => ({
  ratingKey: id, type: 'episode', title, grandparentTitle: 'Dummy Series', parentIndex: 1, index, viewCount, ...withFile(id),
});

// What sits under the series, and under the items the app must not touch. The
// series list is changed by the tests, as a server does when an episode arrives.
const seriesEpisodes = [episode('211', 1, 'Dummy Episode One', 1), episode('212', 2, 'Dummy Episode Two')];
const leaves = {
  21: seriesEpisodes,
  12: [{ ratingKey: '121', type: 'episode', title: 'DUMMY leaf of the item with no section', ...withFile('121') }],
  501: [{ ratingKey: '5011', type: 'photo', title: 'DUMMY photo inside the album', ...withFile('5011') }],
  601: [{ ratingKey: '6011', type: 'track', title: 'DUMMY track on the album', ...withFile('6011') }],
  602: [{ ratingKey: '6021', type: 'track', title: 'DUMMY track by the artist', ...withFile('6021') }],
};

const tv = await standInTv();
const player = await startStandInPlayer();
const plex = await startStandInPlex({
  serverKey: SERVER,
  file: FILE,
  leaves,
  players: [player.listing],
  sections: [
    { key: '1', type: 'movie', title: 'Films' },
    { key: '2', type: 'show', title: 'Series' },
    { key: '5', type: 'photo', title: 'Dummy Photos' },
    { key: '6', type: 'artist', title: 'Dummy Music' },
  ],
  items: {
    1: [
      { ratingKey: '11', type: 'movie', title: 'Dummy Film', year: 1999, ...withFile('11') },
      { ratingKey: '12', type: 'movie', title: 'DUMMY item with no section', ...withFile('12') },
      // DTS sound: the TV cannot play it as it is, so it goes through the relay.
      { ratingKey: '13', type: 'movie', title: 'Dummy Film In DTS', year: 2001, ...withFile('13', { container: 'mkv', audioCodec: 'dts' }) },
    ],
    2: [{ ratingKey: '21', type: 'show', title: 'Dummy Series', year: 2005 }],
    5: [{ ratingKey: '501', type: 'photo', title: 'DUMMY photo album', summary: 'DUMMY caption', ...withFile('501') }],
    6: [
      { ratingKey: '601', type: 'track', title: 'DUMMY music track', ...withFile('601') },
      { ratingKey: '602', type: 'artist', title: 'DUMMY music artist' },
    ],
  },
});
// Item 12 is answered the way no real server answers: with no word about
// which section it is in. What cannot be placed is refused.
plex.saysSection.set('12', null);

const refused = stubPlexTv([plex], { homeNetwork: true });
standInDiscovery(() => [{ location: `http://${TV_HOST}:${tv.port}/desc.xml`, address: TV_HOST }]);

// No real ffmpeg is ever started by these tests.
const realSpawn = cp.spawn;
const STAND_IN_FFMPEG = fileURLToPath(new URL('./stand-in-ffmpeg.mjs', import.meta.url));
let relaysStarted = 0;
cp.spawn = (command, args, options) => {
  relaysStarted += 1;
  return realSpawn(process.execPath, [STAND_IN_FFMPEG, ...args], options);
};
syncBuiltinESMExports();

// Imported only after DATA_DIR is set and the stand-ins are in place.
const config = await import('../src/config.js');
const tvs = await import('../src/tv.js');
const { app } = await import('../src/app.js');
await import('../src/routes/downloads.js');
const tvRoutes = await import('../src/routes/tv.js');
await import('../src/routes/discovery.js');
await import('../src/routes/subscriptions.js');
const { openRatingsDb } = await import('../src/db.js');
config.updateConfig({ downloadsEnabled: true });

// Every request below comes from this computer with no forwarding header: the
// owner, who may download, cast and subscribe. The rule is about the item,
// not about who asks.
const { base, call, close } = await listenForTest(app);
await tvs.discoverRenderers(20);
const controlUrl = `http://${TV_HOST}:${tv.port}/ctl`;

after(async () => {
  cp.spawn = realSpawn;
  syncBuiltinESMExports();
  await close();
  await plex.stop();
  await player.stop();
  tv.server.close();
});

const UNLISTED = [
  ['501', 'a photo in section 5'],
  ['601', 'a music track in section 6'],
  ['12', 'an item whose answer does not say which section it is in'],
];
const NOT_FOUND = { error: 'Item not found' };

const downloadLink = (id) => call('GET', `/api/download-url/${SERVER}/${id}`);
const cast = (id) => call('POST', '/api/tv/play', { body: { serverKey: SERVER, ratingKey: id, controlUrl } });
const playOnPlayer = (id) =>
  call('POST', '/api/plex/play', { body: { serverKey: SERVER, clientMachineIdentifier: player.listing.machineIdentifier, ratingKey: id } });
const subscribeTo = (id, title) => call('POST', '/api/subscriptions', { body: { title, plex_key: id, server_key: SERVER } });
const subscriptions = async () => (await call('GET', '/api/subscriptions')).body.subscriptions;
const alerts = async () => (await call('GET', '/api/subscriptions/alerts')).body.alerts;

/** Fetch one of this app's own addresses and return the bytes, not JSON. */
async function fetchBytes(address, headers = {}) {
  const res = await fetch(`${base}${address}`, { headers });
  return { status: res.status, bytes: Buffer.from(await res.arrayBuffer()) };
}

/** The address the TV was handed in its last play command, as a path on this test's port. */
function handedToTv() {
  const command = tv.commands.findLast((c) => c.action === 'SetAVTransportURI' && c.uri);
  const url = new URL(command.uri);
  return `${url.pathname}${url.search}`;
}

/** How often the stand-in Plex server was asked for any file. */
const filesFetched = () => plex.seen.filter((r) => r.path.startsWith('/library/parts/')).length;
/** What the stand-in Plex server was asked about one item: the item itself, and what is under it. */
const askedAbout = (id) => ({
  item: plex.asked(`/library/metadata/${id}`),
  under: plex.asked(`/library/metadata/${id}/allLeaves`),
  file: plex.seen.filter((r) => r.path.startsWith(`/library/parts/${id}/`)).length,
});

// ---------- What the app lists still works ----------

test('a film and an episode from the listed libraries still download', async () => {
  for (const id of ['11', '212']) {
    const made = await downloadLink(id);
    assert.equal(made.status, 200, id);
    assert.equal(made.body.downloads.length, 1, id);
    const whole = await fetchBytes(made.body.downloads[0].url);
    assert.equal(whole.status, 200, id);
    assert.equal(whole.bytes.equals(FILE), true, id);
    const piece = await fetchBytes(made.body.downloads[0].url, { Range: 'bytes=2-9' });
    assert.equal(piece.status, 206, id);
    assert.equal(piece.bytes.equals(FILE.subarray(2, 10)), true, id);
  }
});

test('a film, a series and an episode still cast to the TV', async () => {
  for (const [id, title, playedKey] of [
    ['11', 'Dummy Film', '11'],
    // A series is cast as its first episode nobody has watched.
    ['21', 'Dummy Series · S1E2 · Dummy Episode Two', '212'],
    ['211', 'Dummy Episode One', '211'],
  ]) {
    tv.commands.length = 0;
    const res = await cast(id);
    assert.equal(res.status, 200, id);
    assert.deepEqual({ ok: res.body.ok, title: res.body.title, relayed: res.body.relayed }, { ok: true, title, relayed: false }, id);
    assert.deepEqual(tv.commands.map((c) => c.action), ['SetAVTransportURI', 'Play'], id);
    const link = handedToTv();
    assert.equal(link.startsWith(`/api/tv/file/${SERVER}/${playedKey}?t=`), true, id);
    const file = await fetchBytes(link);
    assert.equal(file.status, 200, id);
    assert.equal(file.bytes.equals(FILE), true, id);
  }
});

test('a film that needs converting still reaches the TV through the relay', async () => {
  tv.commands.length = 0;
  const res = await cast('13');
  assert.equal(res.status, 200);
  assert.equal(res.body.relayed, true);
  const link = handedToTv();
  assert.equal(link.startsWith(`/api/tv/stream/${SERVER}/13?t=`), true);
  const stream = await fetchBytes(link);
  assert.equal(stream.status, 200);
  assert.equal(stream.bytes.equals(FILE), true);
});

test('a film and an episode still play on a Plex player', async () => {
  for (const id of ['11', '212']) {
    player.commands.length = 0;
    const res = await playOnPlayer(id);
    assert.equal(res.status, 200, id);
    assert.deepEqual(res.body, { success: true }, id);
    // The player is told which item, and is handed the short-lived token only.
    assert.deepEqual(player.commands, [{ path: '/player/playback/playMedia', key: `/library/metadata/${id}`, token: DUMMY_SHORT_TOKEN }], id);
  }
});

test('subscribing to a series still works, and a new episode still raises an alert', async () => {
  const made = await subscribeTo('21', 'Dummy Series');
  assert.equal(made.status, 201);
  assert.equal(made.body.subscription.last_known_episodes, 2);

  seriesEpisodes.push(episode('213', 3, 'Dummy Episode Three'));
  const checked = await call('POST', '/api/subscriptions/check-episodes');
  assert.deepEqual(checked.body.newEpisodes.map((s) => [s.title, s.newCount]), [['Dummy Series', 1]]);
  assert.deepEqual((await alerts()).map((a) => a.episode_title), ['Dummy Episode Three']);
});

// ---------- What the app does not list is refused ----------

for (const [id, what] of UNLISTED) {
  test(`${what}: no download link is made, and its file is never fetched`, async () => {
    const before = askedAbout(id);
    const files = filesFetched();
    const res = await downloadLink(id);
    assert.equal(res.status, 404);
    assert.deepEqual(res.body, NOT_FOUND, 'no link, no file name, no title');
    assert.deepEqual(askedAbout(id), { ...before, item: before.item + 1 }, 'the item was read once and nothing else was asked');
    assert.equal(filesFetched(), files);
  });

  test(`${what}: it is not cast to the TV, and no ticket is made`, async () => {
    const before = askedAbout(id);
    const files = filesFetched();
    const tickets = tvRoutes.ticketsOutstanding();
    tv.commands.length = 0;
    const res = await cast(id);
    assert.equal(res.status, 404);
    assert.deepEqual(res.body, NOT_FOUND);
    assert.deepEqual(tv.commands, [], 'no command reaches the TV');
    assert.equal(tvRoutes.ticketsOutstanding(), tickets, 'no ticket is made');
    assert.deepEqual(askedAbout(id), { ...before, item: before.item + 1 }, 'the item was read once: what is under it was not asked for');
    assert.equal(filesFetched(), files);

    // With no ticket the TV addresses for it stay shut, as they did before.
    for (const route of ['file', 'stream']) {
      assert.equal((await fetchBytes(`/api/tv/${route}/${SERVER}/${id}?t=${'0'.repeat(32)}`)).status, 403, route);
    }
    assert.deepEqual(askedAbout(id), { ...before, item: before.item + 1 });
  });

  test(`${what}: no play command goes to a Plex player, and no short-lived token is made for it`, async () => {
    const before = askedAbout(id);
    const tokens = plex.asked('/security/token');
    player.commands.length = 0;
    const res = await playOnPlayer(id);
    assert.equal(res.status, 404);
    assert.deepEqual(res.body, NOT_FOUND);
    assert.deepEqual(player.commands, [], 'no command reaches the player');
    assert.equal(plex.asked('/security/token'), tokens);
    assert.deepEqual(askedAbout(id), { ...before, item: before.item + 1 }, 'the item was read once and nothing else was asked');
  });

  test(`${what}: it cannot be subscribed to, and the hourly check never reads it`, async () => {
    const before = askedAbout(id);
    const res = await subscribeTo(id, 'A name the device made up');
    assert.equal(res.status, 404);
    assert.deepEqual(res.body, NOT_FOUND);
    assert.equal((await subscriptions()).some((s) => s.plex_key === id), false, 'nothing is stored');
    // Subscribing reads what is under the item, and that one answer is what
    // gets checked: there is no second read.
    assert.deepEqual(askedAbout(id), { ...before, under: before.under + 1 });

    await call('POST', '/api/subscriptions/check-episodes');
    assert.deepEqual(askedAbout(id), { ...before, under: before.under + 1 }, 'the check that runs every hour does not ask about it');
    assert.equal(JSON.stringify(await alerts()).includes('DUMMY'), false);
  });
}

// ---------- A link or a TV address made earlier ----------

test('a download link made earlier stops working once Plex places the title outside the listed libraries', async () => {
  const made = await downloadLink('11');
  assert.equal(made.status, 200);
  const link = made.body.downloads[0].url;

  for (const section of ['5', null]) {
    plex.saysSection.set('11', section);
    try {
      const files = filesFetched();
      const res = await call('GET', link);
      assert.equal(res.status, 404, String(section));
      assert.deepEqual(res.body, NOT_FOUND, String(section));
      assert.equal(filesFetched(), files, 'the file is not fetched');
    } finally {
      plex.saysSection.delete('11');
    }
  }
  const back = await fetchBytes(link);
  assert.equal(back.status, 200, 'and works again when the title is back in a listed library');
  assert.equal(back.bytes.equals(FILE), true);
});

test('a relay address handed to the TV earlier starts no encoder once Plex places the title outside the listed libraries', async () => {
  tv.commands.length = 0;
  assert.equal((await cast('13')).status, 200);
  const link = handedToTv();
  assert.equal(link.startsWith(`/api/tv/stream/${SERVER}/13?t=`), true);

  plex.saysSection.set('13', '6');
  try {
    const started = relaysStarted;
    const files = filesFetched();
    const res = await call('GET', link);
    assert.equal(res.status, 404);
    assert.deepEqual(res.body, NOT_FOUND);
    assert.equal(relaysStarted, started, 'no encoder is started');
    assert.equal(filesFetched(), files, 'the file is not fetched');
  } finally {
    plex.saysSection.delete('13');
  }
});

// ---------- Subscriptions that are already on file ----------

/** A subscription stored the way the code before this rule stored one. */
function storedEarlier(id, title) {
  const db = openRatingsDb();
  try {
    db.prepare('INSERT OR IGNORE INTO show_subscriptions (title, plex_key, server_key, last_known_episodes) VALUES (?, ?, ?, 0)').run(title, id, SERVER);
  } finally {
    db.close();
  }
}

test('a subscription made before this rule to an item outside the listed libraries is passed over: nothing from it is stored or shown', async () => {
  storedEarlier('602', 'Stored earlier');
  const checked = await call('POST', '/api/subscriptions/check-episodes');
  assert.equal(checked.status, 200);
  assert.deepEqual(checked.body.newEpisodes, []);
  assert.equal(JSON.stringify(await alerts()).includes('DUMMY'), false, 'the track names are not kept as alerts');
  // It is passed over, not deleted: removing it stays the owner's choice.
  const kept = (await subscriptions()).find((s) => s.plex_key === '602');
  assert.equal(kept.last_known_episodes, 0);
  assert.equal(kept.unseen_count, 0);
});

test('a subscription already on file keeps raising alerts when an answer leaves out the section', async () => {
  // Not refused: a show the household follows must not go quiet because of
  // what one answer left out. Only a named, unlisted section stops it.
  plex.saysSection.set('21', null);
  try {
    seriesEpisodes.push(episode('214', 4, 'Dummy Episode Four'));
    const checked = await call('POST', '/api/subscriptions/check-episodes');
    assert.deepEqual(checked.body.newEpisodes.map((s) => [s.title, s.newCount]), [['Dummy Series', 1]]);
  } finally {
    plex.saysSection.delete('21');
  }
  assert.deepEqual((await alerts()).map((a) => a.episode_title).sort(), ['Dummy Episode Four', 'Dummy Episode Three']);
});

// ---------- While the server cannot list its sections ----------

test('a listed item keeps working while its server cannot list its sections, and an unlisted one stays refused', async () => {
  plex.sectionListDown = true;
  try {
    const lists = plex.asked('/library/sections');
    assert.equal((await downloadLink('11')).status, 200);
    assert.equal((await cast('211')).status, 200);
    assert.equal((await playOnPlayer('11')).status, 200);
    assert.equal(plex.asked('/library/sections'), lists, 'the list on hand decides, with no new question');

    for (const [id] of UNLISTED) assert.equal((await downloadLink(id)).status, 404, id);
    assert.equal((await cast('501')).status, 404);
    assert.equal((await playOnPlayer('601')).status, 404);
  } finally {
    plex.sectionListDown = false;
  }
});

test('nothing in these checks left this computer, and the token only ever travelled as a header', () => {
  assert.deepEqual(refused, []);
  assert.deepEqual(plex.seen.filter((r) => r.tokenIn !== 'header'), []);
});
