// The owner decides which TVs other devices may cast to. Any program on the
// network can answer as a TV, so a device that had entered the PIN could name
// its own program as "the TV", have any film sent to it and keep the file:
// a download in all but name, with downloads switched off and without the
// shared server owner's permission. Now such a device can only use a TV the
// owner approved, and a TV link only works from that TV's address.
//
// The real routes run on 127.0.0.1 against stand-ins. Dummy tokens only.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import cp from 'child_process';
import { syncBuiltinESMExports } from 'module';
import { fileURLToPath } from 'url';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  ACCOUNT_TOKEN, SERVER_KEY,
  standInPlex, standInTv, standInNetwork, standInDiscovery,
} from './tv-stand-ins.js';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'heldover-test-'));
process.env.DATA_DIR = dataDir;
process.env.PLEX_TOKEN = ACCOUNT_TOKEN;
// The stand-in servers here are plain http on this computer. A listed plain
// http address is used only when the owner has asked for that.
process.env.PLEX_ALLOW_HTTP = '1';
delete process.env.BIND_HOST;

const FILM = Buffer.from('dummy-film-bytes-'.repeat(600));
const plex = await standInPlex({
  file: FILM,
  titles: {
    51: { key: '/library/parts/51/file.mp4' },
    50: { container: 'mkv', audioCodec: 'dts', key: '/library/parts/50/file.mkv' },
  },
});

// Three things that answer as TVs. The household's TV; a second real TV; and
// a program run by a device that only has the PIN. Each lives on this
// computer and is known to the app by a home-network address.
const livingRoom = { host: '10.20.30.40', ...(await standInTv({ name: 'Living Room TV', udn: 'uuid:living-room' })) };
const bedroom = { host: '10.20.30.41', ...(await standInTv({ name: 'Bedroom TV', udn: 'uuid:bedroom' })) };
const program = { host: '10.20.30.66', ...(await standInTv({ name: 'Totally a TV', udn: 'uuid:program' })) };
// The same program again, this time copying the living room TV's id.
const copycat = { host: '10.20.30.67', ...(await standInTv({ name: 'Living Room TV', udn: 'uuid:living-room' })) };
const controlUrl = (tv) => `http://${tv.host}:${tv.port}/ctl`;
const answering = [livingRoom, bedroom, program];

const realFetch = standInNetwork({ plexBase: plex.base });
standInDiscovery(() => answering.map((tv) => ({ location: `http://${tv.host}:${tv.port}/desc.xml`, address: tv.host })));

// No real ffmpeg is ever started by these tests.
const realSpawn = cp.spawn;
const STAND_IN_FFMPEG = fileURLToPath(new URL('./stand-in-ffmpeg.mjs', import.meta.url));
cp.spawn = (command, args, options) => realSpawn(process.execPath, [STAND_IN_FFMPEG, ...args], options);
syncBuiltinESMExports();

// Imported only after DATA_DIR is set and the stand-ins are in place.
const config = await import('../src/config.js');
const tvs = await import('../src/tv.js');
const { app } = await import('../src/app.js');
const routes = await import('../src/routes/tv.js');
const listener = await new Promise((resolve) => {
  const l = app.listen(0, '127.0.0.1', () => resolve(l));
});
const base = `http://127.0.0.1:${listener.address().port}`;
await tvs.discoverRenderers(20);

after(() => {
  cp.spawn = realSpawn;
  syncBuiltinESMExports();
  for (const server of [listener, plex.server, livingRoom.server, bedroom.server, program.server, copycat.server]) server.close();
});

// Who is asking. This computer is the owner. Every other device is marked
// with a forwarded address, which is how the app tells that a request did not
// start on this computer (see isLocal in auth.js).
const OWNER = {};
const PHONE = { 'X-Forwarded-For': '10.20.30.20' };
const STRANGER = { 'X-Forwarded-For': '10.20.30.55' };

async function call(method, route, { headers = {}, body } = {}) {
  const res = await realFetch(`${base}${route}`, {
    method,
    headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // Not JSON: a file, or an empty refusal.
  }
  return { status: res.status, text, json, headers: res.headers };
}

const cast = (who, tv, ratingKey = '51') =>
  call('POST', '/api/tv/play', { headers: who, body: { serverKey: SERVER_KEY, ratingKey, controlUrl: controlUrl(tv) } });

/** The address a TV was handed in its play command, as a path on this test's port. */
function handedTo(tv) {
  const command = tv.commands.findLast((c) => c.action === 'SetAVTransportURI' && c.uri);
  const url = new URL(command.uri);
  return `${url.pathname}${url.search}`;
}

/**
 * A search for TVs normally listens for three seconds. One search runs at a
 * time and callers share it, so starting a short one just before a request
 * that searches keeps these tests quick.
 */
const withQuickSearch = (request) => {
  tvs.discoverRenderers(150);
  return request;
};

const savedTvs = () => JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8')).approvedTvs || [];
const REFUSAL = 'The owner needs to approve this TV first. On the computer that runs Heldover, open Settings, TVs.';

// A household device: the owner sets a PIN, the phone enters it.
assert.equal((await call('POST', '/api/setup/access-pin', { headers: OWNER, body: { pin: '246810' } })).status, 200);
const signIn = await call('POST', '/api/auth/pin', { headers: PHONE, body: { pin: '246810' } });
const VIEWER = { ...PHONE, Cookie: String(signIn.headers.getSetCookie()[0]).split(';')[0] };

test('the phone has the PIN and may change things, but is not the owner, and downloads are off', async () => {
  const status = (await call('GET', '/api/auth/status', { headers: VIEWER })).json;
  assert.deepEqual(
    { signedIn: status.signedIn, canChange: status.canChange, isOwner: status.isOwner, downloadsEnabled: status.downloadsEnabled },
    { signedIn: true, canChange: true, isOwner: false, downloadsEnabled: false }
  );
  assert.deepEqual(config.approvedTvs(), []);
});

test('a device with the PIN cannot send a film to a TV the owner has not approved, its own program included', async () => {
  for (const tv of [program, livingRoom]) {
    plex.seen.length = 0;
    const refused = await cast(VIEWER, tv);
    assert.equal(refused.status, 403, tv.name);
    assert.deepEqual(refused.json, { error: REFUSAL, tvNotApproved: true });
    assert.deepEqual(tv.commands, [], 'no command reaches the device');
    assert.equal(routes.ticketsOutstanding(), 0, 'no ticket is made');
    assert.equal(plex.seen.some((r) => r.url.startsWith('/library/')), false, 'the Plex server is not asked for anything');
  }
  // Nor stop, pause or watch what it is doing.
  const control = await call('POST', '/api/tv/control', { headers: VIEWER, body: { controlUrl: controlUrl(program), action: 'stop' } });
  assert.equal(control.status, 403);
  assert.equal(control.json.error, REFUSAL);
  const state = await call('GET', `/api/tv/state?controlUrl=${encodeURIComponent(controlUrl(program))}`, { headers: VIEWER });
  assert.equal(state.status, 403);
  assert.deepEqual(program.commands, []);
  assert.deepEqual(savedTvs(), [], 'and asking does not approve anything');
});

test('when the owner casts to a TV it is approved and saved, and other devices can then use it with downloads still off', async () => {
  const owner = await cast(OWNER, livingRoom);
  assert.equal(owner.status, 200);
  const approved = [{ id: 'uuid:living-room', name: 'Living Room TV', host: '10.20.30.40' }];
  assert.deepEqual(config.approvedTvs(), approved);
  assert.deepEqual(savedTvs(), approved, 'kept in config.json, so it survives a restart');

  livingRoom.commands.length = 0;
  const viewer = await cast(VIEWER, livingRoom);
  assert.equal(viewer.status, 200);
  assert.deepEqual(livingRoom.commands.map((c) => c.action), ['SetAVTransportURI', 'Play']);
  assert.equal(config.downloadsEnabled(), false);

  assert.equal((await call('POST', '/api/tv/control', { headers: VIEWER, body: { controlUrl: controlUrl(livingRoom), action: 'pause' } })).status, 200);
  const state = await call('GET', `/api/tv/state?controlUrl=${encodeURIComponent(controlUrl(livingRoom))}`, { headers: VIEWER });
  assert.deepEqual(state.json, { state: 'PLAYING' });

  // The TV the owner did not cast to is still closed to the phone.
  assert.equal((await cast(VIEWER, bedroom)).status, 403);
});

test('the answer to a cast never holds the address the TV was given', async () => {
  for (const who of [OWNER, VIEWER]) {
    const answer = await cast(who, livingRoom);
    assert.equal(answer.status, 200);
    assert.doesNotMatch(answer.text, /[0-9a-f]{32}/);
    assert.doesNotMatch(answer.text, /\/api\/tv\//);
    assert.deepEqual(Object.keys(answer.json).sort(), ['ok', 'reason', 'relayed', 'title']);
  }
});

test('a TV link works from that TV and from this computer, and is refused from any other address', async () => {
  livingRoom.commands.length = 0;
  assert.equal((await cast(VIEWER, livingRoom)).status, 200);
  const link = handedTo(livingRoom);
  assert.match(link, /^\/api\/tv\/file\//);

  // Another device that learned the address, with or without the PIN. (Its
  // connection comes through this computer here, and is marked as forwarded;
  // the address check itself is tested with real addresses below.)
  for (const who of [STRANGER, VIEWER]) {
    const elsewhere = await call('GET', link, { headers: { ...who, Range: 'bytes=0-31' } });
    assert.equal(elsewhere.status, 403);
    assert.equal(elsewhere.text, '');
  }
  const here = await realFetch(`${base}${link}`, { headers: { Range: 'bytes=0-31' } });
  assert.equal(here.status, 206);
  assert.equal(Buffer.from(await here.arrayBuffer()).equals(FILM.subarray(0, 32)), true);

  // The relay link is bound the same way.
  livingRoom.commands.length = 0;
  assert.equal((await cast(VIEWER, livingRoom, '50')).status, 200);
  const relayLink = handedTo(livingRoom);
  assert.match(relayLink, /^\/api\/tv\/stream\//);
  assert.equal((await call('GET', relayLink, { headers: STRANGER })).status, 403);

  // The check, with the addresses a connection really reports.
  const from = (remoteAddress, headers = {}) => ({ socket: { remoteAddress }, headers });
  const forLivingRoom = { host: '10.20.30.40' };
  assert.equal(routes.ticketOpenTo(forLivingRoom, from('10.20.30.40')), true, 'the TV itself');
  assert.equal(routes.ticketOpenTo(forLivingRoom, from('::ffff:10.20.30.40')), true, 'the TV, as a server listening on IPv6 reports it');
  assert.equal(routes.ticketOpenTo(forLivingRoom, from('10.20.30.41')), false, 'another TV');
  assert.equal(routes.ticketOpenTo(forLivingRoom, from('::ffff:10.20.30.66')), false, 'another device');
  assert.equal(routes.ticketOpenTo(forLivingRoom, from('10.20.30.66', { 'x-forwarded-for': '10.20.30.40' })), false, 'a header claiming to be the TV');
  assert.equal(routes.ticketOpenTo(forLivingRoom, from('127.0.0.1')), true, 'this computer: the app\'s own ffmpeg');
  assert.equal(routes.ticketOpenTo(forLivingRoom, from('::1')), true);
  assert.equal(routes.ticketOpenTo(forLivingRoom, from('127.0.0.1', { 'x-forwarded-for': '10.20.30.66' })), false, 'a visitor through a proxy on this computer');
  assert.equal(routes.ticketOpenTo({ host: '' }, from('10.20.30.66')), false);
  assert.equal(routes.ticketOpenTo({}, from(undefined)), false);
});

test('only the owner can see, approve or remove TVs', async () => {
  for (const who of [VIEWER, STRANGER]) {
    assert.equal((await call('GET', '/api/setup/tvs', { headers: who })).status >= 401, true);
    const approve = await call('POST', '/api/setup/tvs/approve', { headers: who, body: { id: 'uuid:program' } });
    assert.equal(approve.status === 403 || approve.status === 401, true);
    const remove = await call('POST', '/api/setup/tvs/remove', { headers: who, body: { id: 'uuid:living-room' } });
    assert.equal(remove.status === 403 || remove.status === 401, true);
  }
  assert.equal((await call('POST', '/api/setup/tvs/approve', { headers: VIEWER, body: { id: 'uuid:program' } })).json.ownerRequired, true);
  assert.deepEqual(savedTvs().map((tv) => tv.id), ['uuid:living-room'], 'nothing changed');
  assert.equal((await cast(VIEWER, program)).status, 403);
});

test('the owner sees which TVs are approved, approves one that is on the network, and removes it again', async () => {
  const list = (await withQuickSearch(call('GET', '/api/setup/tvs', { headers: OWNER }))).json;
  assert.deepEqual(list.approved, [{ id: 'uuid:living-room', name: 'Living Room TV', host: '10.20.30.40' }]);
  assert.deepEqual(
    list.discovered.map((tv) => [tv.name, tv.host, tv.approved]),
    [['Living Room TV', '10.20.30.40', true], ['Bedroom TV', '10.20.30.41', false], ['Totally a TV', '10.20.30.66', false]]
  );

  // Input is checked, and only a TV that is on the network can be approved.
  for (const body of [undefined, {}, { id: 7 }, { id: '' }, { id: ['uuid:bedroom'] }, { id: { $ne: null } }, { id: 'x'.repeat(2001) }]) {
    assert.equal((await call('POST', '/api/setup/tvs/approve', { headers: OWNER, body })).status, 400, JSON.stringify(body)?.slice(0, 40));
    assert.equal((await call('POST', '/api/setup/tvs/remove', { headers: OWNER, body })).status, 400, JSON.stringify(body)?.slice(0, 40));
  }
  const unknown = await withQuickSearch(call('POST', '/api/setup/tvs/approve', { headers: OWNER, body: { id: 'uuid:never-seen' } }));
  assert.equal(unknown.status, 400);
  assert.match(unknown.json.error, /not found on your network/);
  assert.equal(savedTvs().length, 1);

  // A name or address in the request is ignored: they come from the TV.
  const approve = await call('POST', '/api/setup/tvs/approve', {
    headers: OWNER,
    body: { id: 'uuid:bedroom', name: 'Anything', host: '10.20.30.66' },
  });
  assert.equal(approve.status, 200);
  assert.deepEqual(savedTvs()[1], { id: 'uuid:bedroom', name: 'Bedroom TV', host: '10.20.30.41' });
  assert.equal((await cast(VIEWER, bedroom)).status, 200);

  const remove = await call('POST', '/api/setup/tvs/remove', { headers: OWNER, body: { id: 'uuid:bedroom' } });
  assert.equal(remove.status, 200);
  assert.deepEqual(remove.json.approved.map((tv) => tv.id), ['uuid:living-room']);
  assert.equal((await cast(VIEWER, bedroom)).status, 403);
});

test('copying an approved TV\'s id from another address does not make a device approved', async () => {
  // The program now answers with the living room TV's own id.
  answering.push(copycat);
  await tvs.discoverRenderers(20);

  copycat.commands.length = 0;
  const refused = await cast(VIEWER, copycat);
  assert.equal(refused.status, 403);
  assert.equal(refused.json.error, REFUSAL);
  assert.deepEqual(copycat.commands, []);
  assert.equal((await cast(VIEWER, livingRoom)).status, 200, 'the real TV still works');

  // The owner is not asked to choose between two devices by an id they share.
  const list = (await withQuickSearch(call('GET', '/api/setup/tvs', { headers: OWNER }))).json;
  assert.deepEqual(
    list.discovered.filter((tv) => tv.id === 'uuid:living-room').map((tv) => [tv.host, tv.approved]),
    [['10.20.30.40', true], ['10.20.30.67', false]]
  );
  const ambiguous = await call('POST', '/api/setup/tvs/approve', { headers: OWNER, body: { id: 'uuid:living-room' } });
  assert.equal(ambiguous.status, 409);
  assert.deepEqual(savedTvs(), [{ id: 'uuid:living-room', name: 'Living Room TV', host: '10.20.30.40' }]);
});

test('a saved list that has been damaged is read as the well-formed entries only', () => {
  config.updateConfig({ approvedTvs: [{ id: 'uuid:a', name: 'A', host: '10.0.0.1' }, null, 'tv', { id: 'uuid:b' }, { host: '10.0.0.2' }, { id: 5, host: '10.0.0.3' }] });
  assert.deepEqual(config.approvedTvs(), [{ id: 'uuid:a', name: 'A', host: '10.0.0.1' }]);
  config.updateConfig({ approvedTvs: 'everything' });
  assert.deepEqual(config.approvedTvs(), []);
});
