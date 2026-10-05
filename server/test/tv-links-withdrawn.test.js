// A link the app hands to a TV used to work for twelve hours whatever
// happened next. The owner could remove a TV from the approved list and the
// removed device kept fetching the films it had already been sent; a TV that
// refused a cast kept a working link; so did a TV that was told to stop. Now
// each link belongs to the TV it was made for and is withdrawn when that TV
// stops being approved, when the TV refuses the cast, and on Stop. What was
// being sent on a withdrawn link stops too: the file transfer is closed and
// the converter is stopped.
//
// The real routes run on 127.0.0.1 against stand-ins. Dummy tokens only. A
// request from this computer stands in for the TV: a withdrawn link answers
// 403 from every address, this one included.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import cp from 'child_process';
import { syncBuiltinESMExports } from 'module';
import { fileURLToPath } from 'url';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  ACCOUNT_TOKEN, SERVER_KEY, DESCRIPTION,
  listen, standInPlex, standInNetwork, standInDiscovery,
} from './tv-stand-ins.js';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'heldover-test-'));
process.env.PLEX_TOKEN = ACCOUNT_TOKEN;
// The stand-in servers here are plain http on this computer. A listed plain
// http address is used only when the owner has asked for that.
process.env.PLEX_ALLOW_HTTP = '1';
delete process.env.BIND_HOST;

const FILM = Buffer.from('dummy-film-bytes-'.repeat(600));
const relayed = { container: 'mkv', audioCodec: 'dts' };
const plex = await standInPlex({
  file: FILM,
  titles: {
    51: { key: '/library/parts/51/file.mp4' },
    50: { ...relayed, key: '/library/parts/50/file.mkv' },
    52: { ...relayed, key: '/library/parts/52/file.mkv' },
    53: { key: '/library/parts/53/file.mp4' },
    54: { key: '/library/parts/54/file.mp4' },
    55: { ...relayed, key: '/library/parts/55/file.mkv' },
  },
});

// Two things the shared stand-in Plex server cannot do, put in front of it: a
// file that never finishes arriving (title 53: a film in the middle of being
// sent), and an answer that waits until the test lets it go.
const [plexAnswers] = plex.server.listeners('request');
plex.server.removeAllListeners('request');
const unfinished = { open: 0, closed: 0 };
const held = [];
plex.server.on('request', (req, res) => {
  if (req.url.startsWith('/library/parts/53/')) {
    unfinished.open += 1;
    res.on('close', () => { unfinished.closed += 1; });
    res.writeHead(200, { 'Content-Type': 'video/mp4' });
    return res.write(FILM.subarray(0, 1024));
  }
  const hold = held.find((h) => req.url.startsWith(h.path));
  if (hold) {
    hold.arrived();
    return hold.released.then(() => plexAnswers(req, res));
  }
  return plexAnswers(req, res);
});

/** Makes the stand-in Plex server wait before it answers `path`, until release() is called. */
function holdAnswer(pathPrefix) {
  const hold = { path: pathPrefix };
  hold.asked = new Promise((resolve) => { hold.arrived = resolve; });
  hold.released = new Promise((resolve) => {
    hold.release = () => {
      held.splice(held.indexOf(hold), 1);
      resolve();
    };
  });
  held.push(hold);
  return hold;
}

/** A television that remembers every command, and refuses the ones named in `refuse`. */
async function standInTv(host, name, udn) {
  const commands = [];
  const refuse = new Set();
  const tv = await listen((req, res) => {
    if (req.method === 'GET') {
      res.setHeader('Content-Type', 'text/xml');
      return res.end(DESCRIPTION(name, udn));
    }
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString();
      const action = (String(req.headers.soapaction || '').match(/#(\w+)/) || [])[1] || null;
      const uri = (body.match(/<CurrentURI>(.*?)<\/CurrentURI>/) || [])[1] || null;
      commands.push({ action, uri: uri ? uri.replace(/&amp;/g, '&') : null });
      res.statusCode = refuse.has(action) ? 500 : 200;
      res.setHeader('Content-Type', 'text/xml');
      res.end('<s:Envelope><s:Body><CurrentTransportState>PLAYING</CurrentTransportState></s:Body></s:Envelope>');
    });
    return undefined;
  });
  return { ...tv, host, name, udn, commands, refuse };
}

const livingRoom = await standInTv('10.20.30.40', 'Living Room TV', 'uuid:living-room');
const bedroom = await standInTv('10.20.30.41', 'Bedroom TV', 'uuid:bedroom');
const kitchen = await standInTv('10.20.30.42', 'Kitchen TV', 'uuid:kitchen');
const controlUrl = (tv) => `http://${tv.host}:${tv.port}/ctl`;

const realFetch = standInNetwork({ plexBase: plex.base });
standInDiscovery(() => [livingRoom, bedroom, kitchen].map((tv) => ({ location: `http://${tv.host}:${tv.port}/desc.xml`, address: tv.host })));

// No real ffmpeg is started. Every converter the app starts is kept, so a
// test can see whether it was stopped. The one for title 52 stays open, the
// way an encoder does in the middle of a film.
const realSpawn = cp.spawn;
const STAND_IN_FFMPEG = fileURLToPath(new URL('./stand-in-ffmpeg.mjs', import.meta.url));
const converters = [];
cp.spawn = (command, args, options) => {
  const input = args[args.indexOf('-i') + 1] || '';
  const hold = input.includes('/52?');
  const child = realSpawn(process.execPath, [STAND_IN_FFMPEG, ...args, ...(hold ? ['--hold'] : [])], options);
  const converter = { input, child, ended: null };
  child.on('exit', (code, signal) => { converter.ended = { code, signal }; });
  converters.push(converter);
  return child;
};
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

// Requests the tests leave open on purpose are closed at the end.
const openRequests = [];
after(() => {
  for (const controller of openRequests) controller.abort();
  for (const { child } of converters) child.kill('SIGKILL');
  cp.spawn = realSpawn;
  syncBuiltinESMExports();
  for (const server of [listener, plex.server, livingRoom.server, bedroom.server, kitchen.server]) {
    server.close();
    server.closeAllConnections();
  }
});

// Who is asking. This computer is the owner; the phone is marked with a
// forwarded address, which is how the app tells that a request did not start
// on this computer (see isLocal in auth.js), and has entered the PIN.
const OWNER = {};
const PHONE = { 'X-Forwarded-For': '10.20.30.20' };

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

assert.equal((await call('POST', '/api/setup/access-pin', { headers: OWNER, body: { pin: '246810' } })).status, 200);
const signIn = await call('POST', '/api/auth/pin', { headers: PHONE, body: { pin: '246810' } });
const VIEWER = { ...PHONE, Cookie: String(signIn.headers.getSetCookie()[0]).split(';')[0] };

const approve = (tv) => call('POST', '/api/setup/tvs/approve', { headers: OWNER, body: { id: tv.udn } });
const remove = (tv) => call('POST', '/api/setup/tvs/remove', { headers: OWNER, body: { id: tv.udn } });
const control = (who, tv, action) => call('POST', '/api/tv/control', { headers: who, body: { controlUrl: controlUrl(tv), action } });
const approvedIds = () => config.approvedTvs().map((tv) => tv.id);

/** Sends a title to a TV and answers with the link the TV was handed, as a path on this test's port. */
async function cast(who, tv, ratingKey) {
  tv.commands.length = 0;
  const answer = await call('POST', '/api/tv/play', { headers: who, body: { serverKey: SERVER_KEY, ratingKey: String(ratingKey), controlUrl: controlUrl(tv) } });
  const handed = tv.commands.find((c) => c.action === 'SetAVTransportURI' && c.uri);
  const url = handed ? new URL(handed.uri) : null;
  return { status: answer.status, json: answer.json, link: url ? `${url.pathname}${url.search}` : null };
}

/** What the link answers to the first 32 bytes of the film, asked from this computer. */
async function ask(link) {
  const res = await realFetch(`${base}${link}`, { headers: { Range: 'bytes=0-31' } });
  await res.arrayBuffer();
  return res.status;
}

/** Opens a link and reads the first bytes, leaving the rest of the answer on its way. */
async function startReceiving(link) {
  const controller = new AbortController();
  openRequests.push(controller);
  const res = await realFetch(`${base}${link}`, { signal: controller.signal });
  const reader = res.body.getReader();
  const first = await reader.read();
  return { status: res.status, firstBytes: first.value?.length || 0, reader };
}

const WAIT_MS = 3000;

/** True once `condition` holds; false when it still does not after a few seconds. */
async function eventually(condition) {
  const deadline = Date.now() + WAIT_MS;
  while (Date.now() < deadline) {
    if (await condition()) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return false;
}

/** Did the rest of an answer stop arriving (ended or cut off) within a few seconds? */
async function stopped(reader) {
  const drained = (async () => {
    try {
      for (;;) {
        const { done } = await reader.read();
        if (done) return true;
      }
    } catch {
      return true;
    }
  })();
  return Promise.race([drained, new Promise((resolve) => setTimeout(() => resolve(false), WAIT_MS))]);
}

test('removing a TV withdraws the links made for it, and another TV keeps its own', async () => {
  assert.equal((await approve(livingRoom)).status, 200);
  assert.equal((await approve(bedroom)).status, 200);

  const film = await cast(VIEWER, livingRoom, 51);
  const converted = await cast(VIEWER, livingRoom, 50);
  const other = await cast(VIEWER, bedroom, 51);
  assert.deepEqual([film.status, converted.status, other.status], [200, 200, 200]);
  // Kept for the tests below.
  livingRoom.oldLinks = [film.link, converted.link];
  bedroom.link = other.link;
  assert.match(film.link, /^\/api\/tv\/file\//);
  assert.match(converted.link, /^\/api\/tv\/stream\//);
  assert.equal(routes.ticketsOutstanding(), 3);
  assert.equal(await ask(film.link), 206, 'works while the TV is approved');

  const removed = await remove(livingRoom);
  assert.equal(removed.status, 200);
  assert.deepEqual(removed.json.approved.map((tv) => tv.id), ['uuid:bedroom']);

  assert.equal(routes.ticketsOutstanding(), 1, 'only the bedroom TV\'s link is left');
  const before = converters.length;
  assert.equal(await ask(film.link), 403, 'the film link of the removed TV');
  assert.equal(await ask(converted.link), 403, 'the converted-film link of the removed TV');
  assert.equal(converters.length, before, 'and no converter is started for it');
  assert.equal(await ask(other.link), 206, 'the bedroom TV is not affected');
  assert.equal((await cast(VIEWER, livingRoom, 51)).status, 403, 'and no new cast to the removed TV');
});

test('approving the TV again does not bring the old links back: a new cast gets a new link', async () => {
  assert.equal((await approve(livingRoom)).status, 200);
  for (const link of livingRoom.oldLinks) assert.equal(await ask(link), 403);

  const again = await cast(VIEWER, livingRoom, 51);
  assert.equal(again.status, 200);
  assert.equal(livingRoom.oldLinks.includes(again.link), false);
  assert.equal(await ask(again.link), 206);
  assert.equal(routes.ticketsOutstanding(), 2);
});

test('a film that is on its way to a TV stops when the owner removes that TV', async () => {
  // Two films being sent to the living room TV: one as the file it is, from a
  // Plex server that is still sending it, and one through the converter.
  const film = await cast(VIEWER, livingRoom, 53);
  const converted = await cast(VIEWER, livingRoom, 52);
  assert.deepEqual([film.status, converted.status], [200, 200]);

  const file = await startReceiving(film.link);
  assert.equal(file.status, 200);
  assert.ok(file.firstBytes > 0);
  const stream = await startReceiving(converted.link);
  assert.equal(stream.status, 200);
  assert.ok(stream.firstBytes > 0);
  const converter = converters.at(-1);
  assert.match(converter.input, /\/api\/tv\/file\/dummyshare1\/52\?t=/);
  assert.equal(converter.ended, null, 'the converter is running');
  assert.deepEqual(unfinished, { open: 1, closed: 0 });

  assert.equal((await remove(livingRoom)).status, 200);

  assert.equal(await stopped(file.reader), true, 'the file transfer was closed');
  assert.equal(await eventually(() => unfinished.closed === 1), true, 'and the Plex server is no longer being read');
  assert.equal(await stopped(stream.reader), true, 'the converted stream was closed');
  assert.equal(await eventually(() => converter.ended !== null), true, 'and its converter was stopped');
  assert.equal(converter.ended.signal, 'SIGKILL');
  // The address the converter read from goes with it.
  const input = new URL(converter.input);
  assert.equal(await eventually(async () => (await ask(`${input.pathname}${input.search}`)) === 403), true);
  assert.equal(await ask(film.link), 403);
  assert.equal(await ask(converted.link), 403);
  assert.equal(await eventually(() => routes.ticketsOutstanding() === 1), true, 'only the bedroom TV\'s link is left');
  assert.equal(await ask(bedroom.link), 206);
});

test('the owner can still cast to a TV that is not approved, and that approves it', async () => {
  assert.deepEqual(approvedIds(), ['uuid:bedroom']);
  const owner = await cast(OWNER, livingRoom, 51);
  assert.equal(owner.status, 200);
  assert.equal(await ask(owner.link), 206, 'the link works although it was made before the TV was approved');
  assert.deepEqual(approvedIds(), ['uuid:bedroom', 'uuid:living-room']);
  assert.equal(await ask(owner.link), 206);
});

test('a TV that refuses the cast is left with no working link', async () => {
  const before = routes.ticketsOutstanding();
  // The kitchen TV takes the address and then refuses to play it.
  kitchen.refuse.add('Play');
  const refused = await cast(OWNER, kitchen, 51);
  assert.equal(refused.status, 500);
  assert.match(refused.json.error, /^Could not start it on the TV/);
  assert.match(refused.link, /^\/api\/tv\/file\//, 'the TV was told an address');
  assert.equal(await ask(refused.link), 403, 'which does not work');
  assert.equal(routes.ticketsOutstanding(), before);
  assert.equal(approvedIds().includes('uuid:kitchen'), false, 'and a failed cast approves nothing');

  // The same when it refuses the address itself.
  kitchen.refuse.add('SetAVTransportURI');
  assert.equal((await cast(OWNER, kitchen, 50)).status, 500);
  assert.equal(routes.ticketsOutstanding(), before);
  kitchen.refuse.clear();
});

test('Stop withdraws that TV\'s links and stops its converter; Pause keeps them', async () => {
  const film = await cast(VIEWER, livingRoom, 51);
  const converted = await cast(VIEWER, livingRoom, 52);
  const stream = await startReceiving(converted.link);
  assert.equal(stream.status, 200);
  const converter = converters.at(-1);
  assert.equal(converter.ended, null);

  assert.equal((await control(VIEWER, livingRoom, 'pause')).status, 200);
  assert.equal(await ask(film.link), 206, 'a paused TV comes back for the same link');
  assert.equal(converter.ended, null);

  assert.equal((await control(VIEWER, livingRoom, 'stop')).status, 200);
  assert.equal(await ask(film.link), 403);
  assert.equal(await ask(converted.link), 403);
  assert.equal(await stopped(stream.reader), true, 'the converted stream was closed');
  assert.equal(await eventually(() => converter.ended !== null), true, 'and its converter was stopped');
  assert.equal(await ask(bedroom.link), 206, 'the bedroom TV is not affected');
  assert.deepEqual(approvedIds(), ['uuid:bedroom', 'uuid:living-room'], 'Stop does not remove the approval');

  // A TV that does not answer Stop (switched off, say) still loses its links.
  const next = await cast(VIEWER, livingRoom, 51);
  assert.equal(await ask(next.link), 206);
  livingRoom.refuse.add('Stop');
  assert.equal((await control(VIEWER, livingRoom, 'stop')).status, 500);
  livingRoom.refuse.clear();
  assert.equal(await ask(next.link), 403);
});

test('a cast that was under way when the owner removed the TV makes no link', async () => {
  const before = routes.ticketsOutstanding();
  // The Plex server is slow to answer about the title, and the owner removes
  // the TV in the meantime.
  const slow = holdAnswer('/library/metadata/54');
  livingRoom.commands.length = 0;
  const underWay = call('POST', '/api/tv/play', { headers: VIEWER, body: { serverKey: SERVER_KEY, ratingKey: '54', controlUrl: controlUrl(livingRoom) } });
  await slow.asked;
  assert.equal((await remove(livingRoom)).status, 200);
  slow.release();

  const answer = await underWay;
  assert.equal(answer.status, 403);
  assert.equal(answer.json.tvNotApproved, true);
  assert.deepEqual(livingRoom.commands, [], 'the TV is sent nothing');
  assert.equal(routes.ticketsOutstanding(), before);
});

test('a link withdrawn while its converter was being prepared starts no converter', async () => {
  assert.equal((await approve(livingRoom)).status, 200);
  const converted = await cast(VIEWER, livingRoom, 55);
  assert.equal(converted.status, 200);

  // The TV asks for the stream, the Plex server is slow to answer about the
  // title, and the owner removes the TV in the meantime.
  const before = converters.length;
  const slow = holdAnswer('/library/metadata/55');
  const asking = realFetch(`${base}${converted.link}`);
  await slow.asked;
  assert.equal((await remove(livingRoom)).status, 200);
  slow.release();

  const answer = await asking;
  await answer.arrayBuffer();
  assert.equal(answer.status, 403);
  assert.equal(converters.length, before);
});

test('a TV that answers from a new address loses the links made for its old one', async () => {
  assert.equal(await ask(bedroom.link), 206);
  // The bedroom TV now answers from another address, and the owner approves
  // it there: one entry per TV, so the old address is no longer approved.
  tvs.approveTv({ id: 'uuid:bedroom', name: 'Bedroom TV', host: '10.20.30.99' });
  assert.deepEqual(config.approvedTvs(), [{ id: 'uuid:bedroom', name: 'Bedroom TV', host: '10.20.30.99' }]);
  assert.equal(await ask(bedroom.link), 403);
  assert.equal(routes.ticketsOutstanding(), 0);
});
