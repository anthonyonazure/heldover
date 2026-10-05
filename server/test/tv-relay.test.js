// The TV relay keeps the Plex token to itself. ffmpeg used to be started with
// the token among its arguments, which every account on the computer can
// read, and with a file address built from whatever the Plex server said, so
// a hostile shared server could send ffmpeg, token included, to another
// machine. Now ffmpeg reads through this app's own ticketed address, and the
// app fetches the file itself, only ever from the server it belongs to.
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
  ACCOUNT_TOKEN, SHARE_TOKEN, SERVER_KEY,
  listen, standInPlex, standInTv, standInNetwork, standInDiscovery,
} from './tv-stand-ins.js';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'heldover-test-'));
process.env.PLEX_TOKEN = ACCOUNT_TOKEN;
// The stand-in servers here are plain http on this computer. A listed plain
// http address is used only when the owner has asked for that.
process.env.PLEX_ALLOW_HTTP = '1';
process.env.TMDB_API_KEY = 'DUMMY-TMDB-KEY-2222';
delete process.env.BIND_HOST;

const FILM = Buffer.from('dummy-film-bytes-'.repeat(600));
const TV_HOST = '10.20.30.40';

// "Another machine": whatever a hostile server would like the request, and
// the token, to reach. Every test ends by checking it heard nothing.
const other = await listen((req, res) => res.end('should never be asked'));

// Titles the stand-in Plex server reports. The "key" is the part a hostile
// server controls. 5x are honest; 6x would play as they are, 7x need the
// relay (DTS sound), and each pair tries one way of pointing elsewhere.
const away = (suffix) => `127.0.0.1:${other.port}/steal.${suffix}`;
const relayed = { container: 'mkv', audioCodec: 'dts' };
const titles = {
  50: { ...relayed, key: '/library/parts/50/file.mkv' },
  51: { key: '/library/parts/51/file.mp4' },
  52: { ...relayed, key: '/library/parts/52/file.mkv' },
  61: () => ({ key: `http://${away('mp4')}` }),
  62: () => ({ key: `//${away('mp4')}` }),
  63: () => ({ key: `@${away('mp4')}` }),
  64: { key: '/bounce/64.mp4' },
  71: () => ({ ...relayed, key: `http://${away('mkv')}` }),
  72: () => ({ ...relayed, key: `//${away('mkv')}` }),
  73: () => ({ ...relayed, key: `@${away('mkv')}` }),
  74: { ...relayed, key: '/bounce/74.mkv' },
  80: { ...relayed, key: '/library/parts/80/file.mkv', ratingKey: '80/../../../setup/status' },
  // One per way of naming the kind of file: 9x are for the converter's input
  // format. Title 99 names a container the app has no format for.
  96: { container: 'mpegts', key: '/library/parts/96/file.ts' },
  97: { container: 'm4v', audioCodec: 'dts', key: '/library/parts/97/file.m4v' },
  98: { ...relayed, key: '/library/parts/98/file.mkv' },
  99: { container: 'dummykind', key: '/library/parts/99/file.bin' },
};
const bounce = () => `${other.base}/steal`;
const plex = await standInPlex({ titles, file: FILM, redirects: { '/bounce/64.mp4': bounce, '/bounce/74.mkv': bounce } });
const tv = await standInTv();
const realFetch = standInNetwork({ plexBase: plex.base });
standInDiscovery(() => [{ location: `http://${TV_HOST}:${tv.port}/desc.xml`, address: TV_HOST }]);

// ffmpeg is replaced by a small program that reads its input address the way
// ffmpeg does. What the app tried to start it with is kept for the checks.
const STAND_IN_FFMPEG = fileURLToPath(new URL('./stand-in-ffmpeg.mjs', import.meta.url));
const realSpawn = cp.spawn;
const started = [];
const holdOpen = new Set();
cp.spawn = (command, args, options) => {
  started.push({ command, args: [...args], env: options?.env });
  const input = args[args.indexOf('-i') + 1] || '';
  const hold = [...holdOpen].some((key) => input.includes(`/${key}?`));
  return realSpawn(process.execPath, [STAND_IN_FFMPEG, ...args, ...(hold ? ['--hold'] : [])], options);
};
syncBuiltinESMExports();

// Everything the app writes to its log, for the check that no ticket is in it.
const logged = [];
for (const level of ['log', 'error']) {
  const real = console[level];
  console[level] = (...parts) => {
    logged.push(parts.join(' '));
    real(...parts);
  };
}

// Imported only after DATA_DIR is set and the stand-ins are in place.
const { discoverRenderers } = await import('../src/tv.js');
const { app } = await import('../src/app.js');
const routes = await import('../src/routes/tv.js');
const listener = await new Promise((resolve) => {
  const l = app.listen(0, '127.0.0.1', () => resolve(l));
});
const base = `http://127.0.0.1:${listener.address().port}`;
const controlUrl = `http://${TV_HOST}:${tv.port}/ctl`;
await discoverRenderers(20);

after(() => {
  cp.spawn = realSpawn;
  syncBuiltinESMExports();
  for (const server of [listener, plex.server, tv.server, other.server]) server.close();
});

/** Sends a title to the TV as the owner (this computer) and reports what the TV was handed. */
async function cast(ratingKey) {
  tv.commands.length = 0;
  const res = await realFetch(`${base}/api/tv/play`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ serverKey: SERVER_KEY, ratingKey: String(ratingKey), controlUrl }),
  });
  const handed = tv.commands.find((c) => c.action === 'SetAVTransportURI' && c.uri);
  const url = handed ? new URL(handed.uri) : null;
  // The TV is told the port from PORT; this test listens on another one.
  return { status: res.status, body: await res.json(), text: null, path: url ? `${url.pathname}${url.search}` : null };
}

const tokenIn = (text) => [ACCOUNT_TOKEN, SHARE_TOKEN].some((token) => String(text).includes(token));

test('ffmpeg is started with no Plex token and no API key, in its arguments or its environment', async () => {
  const { status, body, path: handedPath } = await cast(50);
  assert.equal(status, 200);
  assert.equal(body.relayed, true);
  assert.match(handedPath, /^\/api\/tv\/stream\//);

  plex.seen.length = 0;
  const stream = await realFetch(`${base}${handedPath}`);
  assert.equal(stream.status, 200);
  const bytes = Buffer.from(await stream.arrayBuffer());
  assert.equal(bytes.equals(FILM), true, 'the TV still receives the film');

  assert.equal(started.length, 1);
  const { args, env } = started[0];
  for (const arg of args) {
    assert.equal(tokenIn(arg), false, 'a token among the arguments');
    assert.doesNotMatch(arg, /X-Plex-Token/i);
  }
  assert.equal(args.includes('-headers'), false);
  assert.ok(env, 'ffmpeg is given its own environment, not a copy of the server\'s');
  for (const [name, value] of Object.entries(env)) {
    assert.doesNotMatch(name, /TOKEN|API_KEY/i, name);
    assert.equal(tokenIn(value), false, name);
    assert.notEqual(value, 'DUMMY-TMDB-KEY-2222', name);
  }
  assert.ok(env.PATH, 'the rest of the environment is kept');

  // Its input is this app, and the app is what asked the Plex server, with
  // the token as a header.
  const input = new URL(args[args.indexOf('-i') + 1]);
  assert.equal(input.origin, base);
  assert.equal(input.pathname, `/api/tv/file/${SERVER_KEY}/50`);
  const fileRequests = plex.seen.filter((r) => r.url.startsWith('/library/parts/50/'));
  assert.ok(fileRequests.length >= 1);
  for (const r of fileRequests) {
    assert.equal(r.token, SHARE_TOKEN);
    assert.equal(tokenIn(r.url), false, 'no token in the address either');
  }
  assert.equal(other.seen.length, 0);
});

test('the address ffmpeg reads from works only while its relay runs, and never with a wrong or expired ticket', async () => {
  // The relay for title 50 has ended: the address it was given is dead.
  const ended = started[0].args[started[0].args.indexOf('-i') + 1];
  assert.equal((await realFetch(ended)).status, 403);

  // A relay that stays open, as an encoder does in the middle of a film.
  holdOpen.add(52);
  const { path: handedPath } = await cast(52);
  const controller = new AbortController();
  const stream = await realFetch(`${base}${handedPath}`, { signal: controller.signal });
  assert.equal(stream.status, 200);
  const input = new URL(started.at(-1).args[started.at(-1).args.indexOf('-i') + 1]);
  assert.equal(input.pathname, `/api/tv/file/${SERVER_KEY}/52`);

  const during = await realFetch(input, { headers: { Range: 'bytes=0-15' } });
  assert.equal(during.status, 206);
  assert.equal(Buffer.from(await during.arrayBuffer()).equals(FILM.subarray(0, 16)), true);

  // Made up, for another title, or used to start a second relay: refused.
  const wrong = new URL(input);
  wrong.searchParams.set('t', '0'.repeat(32));
  assert.equal((await realFetch(wrong)).status, 403);
  assert.equal((await realFetch(`${base}/api/tv/file/${SERVER_KEY}/50${input.search}`)).status, 403);
  assert.equal((await realFetch(`${base}/api/tv/stream/${SERVER_KEY}/52${input.search}`)).status, 403);
  assert.equal((await realFetch(`${base}/api/tv/stream/${SERVER_KEY}/52?t=${'0'.repeat(32)}`)).status, 403);

  // Twelve hours and a second later it has expired.
  const realNow = Date.now;
  Date.now = () => realNow() + 12 * 60 * 60 * 1000 + 1000;
  try {
    assert.equal((await realFetch(input)).status, 403);
  } finally {
    Date.now = realNow;
  }
  assert.equal((await realFetch(input, { method: 'HEAD' })).status, 200, 'and works again at the real time');

  // The TV hangs up: the encoder is stopped and its ticket goes with it.
  controller.abort();
  await stream.body?.cancel().catch(() => {});
  let after = 200;
  for (let i = 0; i < 100 && after !== 403; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    after = (await realFetch(input, { method: 'HEAD' })).status;
  }
  assert.equal(after, 403);
});

test('a file address that points away from the Plex server reaches no other machine', async () => {
  const outcomes = {};
  for (const key of [61, 62, 63, 64, 71, 72, 73, 74]) {
    const { status, path: handedPath } = await cast(key);
    let tvStatus = null;
    if (handedPath) {
      const res = await realFetch(`${base}${handedPath}`);
      tvStatus = res.status;
      await res.arrayBuffer();
    }
    outcomes[key] = { cast: status, tv: tvStatus };
    assert.equal(other.seen.length, 0, `title ${key}: the other machine was asked for ${other.seen[0]?.url}`);
  }
  // A full address, or one that starts with //, names another machine
  // outright: the cast is refused and the TV is sent nothing.
  for (const key of [61, 62, 71, 72]) assert.deepEqual(outcomes[key], { cast: 500, tv: null }, String(key));
  // "@host/..." is only a path on the same server once it is read properly,
  // and a redirect is not followed: the TV gets an error instead of a film.
  for (const key of [63, 64, 73, 74]) {
    assert.equal(outcomes[key].cast, 200, String(key));
    assert.ok(outcomes[key].tv >= 400, `${key}: ${outcomes[key].tv}`);
  }
  // Every address ffmpeg was given is this app's own.
  for (const { args } of started) assert.equal(new URL(args[args.indexOf('-i') + 1]).origin, base);
  assert.equal(other.seen.length, 0);

  // ffmpeg names its input address when it fails; the log masks the ticket.
  assert.ok(logged.some((line) => line.startsWith('[tv relay]') && line.includes('t=***')), 'a relay failure was logged');
  for (const line of logged) {
    assert.doesNotMatch(line, /[?&]t=[0-9a-f]{32}/, 'a ticket in the log');
    assert.equal(tokenIn(line), false, 'a token in the log');
  }
});

test('a title id from the server is a plain number before it goes into an address', async () => {
  const before = started.length;
  const { status, path: handedPath } = await cast(80);
  assert.equal(status, 500);
  assert.equal(handedPath, null, 'the TV is sent nothing');
  assert.equal(started.length, before);
});

test('ffmpeg is pointed at the address the server listens on', () => {
  const at = (host) => {
    if (host) process.env.BIND_HOST = host;
    else delete process.env.BIND_HOST;
    try {
      return routes.ownOrigin(3001);
    } finally {
      delete process.env.BIND_HOST;
    }
  };
  assert.equal(at(null), 'http://127.0.0.1:3001', 'every adapter: this computer');
  assert.equal(at('0.0.0.0'), 'http://127.0.0.1:3001');
  assert.equal(at('::'), 'http://[::1]:3001');
  assert.equal(at('192.168.1.10'), 'http://192.168.1.10:3001', 'one address only: 127.0.0.1 would not answer');
  assert.equal(at('fd00::5'), 'http://[fd00::5]:3001');
});

// ffmpeg used to work out the format of its input from the bytes, and those
// bytes come from a Plex server that may be someone else's: a short text
// playlist in place of the film sent ffmpeg to whatever address it named.
// (tv-converter-real-ffmpeg.test.js shows that with the real ffmpeg.)
const FILM_FORMATS = 'matroska,mov,avi,mpegts,asf,flv,mpeg,ogg';

test('the converter is started with a fixed input format and a protocol list, both before its input', async () => {
  const expected = {
    96: ['-f', 'mpegts'],
    97: ['-f', 'mov'],
    98: ['-f', 'matroska'],
    // No format for this container: ffmpeg may choose, among film formats only.
    99: ['-format_whitelist', FILM_FORMATS],
  };
  // A proxy setting must not reach ffmpeg either: its input is this computer.
  process.env.http_proxy = other.base;
  process.env.HTTPS_PROXY = other.base;
  try {
    for (const [key, [option, value]] of Object.entries(expected)) {
      const before = started.length;
      const { status, body, path: handedPath } = await cast(key);
      assert.equal(status, 200, key);
      assert.equal(body.relayed, true, key);
      const stream = await realFetch(`${base}${handedPath}`);
      assert.equal(Buffer.from(await stream.arrayBuffer()).equals(FILM), true, `${key}: the TV still receives the film`);
      assert.equal(started.length, before + 1, key);

      const { args, env } = started.at(-1);
      const input = args.indexOf('-i');
      const inputOptions = args.slice(0, input);
      const protocols = inputOptions.indexOf('-protocol_whitelist');
      assert.ok(protocols >= 0, `${key}: no protocol list before the input`);
      assert.equal(inputOptions[protocols + 1], 'http,tcp', key);
      const at = inputOptions.indexOf(option);
      assert.ok(at >= 0, `${key}: no ${option} before the input`);
      assert.equal(inputOptions[at + 1], value, key);
      // One or the other, never neither.
      assert.equal(inputOptions.includes('-f'), option === '-f', key);
      assert.equal(inputOptions.includes('-format_whitelist'), option === '-format_whitelist', key);
      // What comes out is unchanged: MPEG-TS, named after the input.
      assert.deepEqual(args.slice(-3), ['-f', 'mpegts', 'pipe:1'], key);
      assert.deepEqual(Object.keys(env).filter((name) => /_proxy$/i.test(name)), [], key);
    }
  } finally {
    delete process.env.http_proxy;
    delete process.env.HTTPS_PROXY;
  }
  // And so was every converter this file started.
  for (const { args } of started) {
    const inputOptions = args.slice(0, args.indexOf('-i'));
    assert.equal(inputOptions[inputOptions.indexOf('-protocol_whitelist') + 1], 'http,tcp');
    assert.equal(inputOptions.includes('-f') || inputOptions.includes('-format_whitelist'), true);
  }
  assert.equal(other.seen.length, 0);
});

test('each container Plex names is read as the ffmpeg format of that name, and an unknown one as a film format only', () => {
  // Left: what Plex calls the file. Right: what ffmpeg calls the format that
  // reads it. ffmpeg has no "mkv", "ts" or "wmv", and its "m4v" is raw
  // MPEG-4 video, which would fail every .m4v cast.
  const formats = {
    mkv: 'matroska', webm: 'matroska',
    mp4: 'mov', m4v: 'mov', mov: 'mov',
    avi: 'avi',
    ts: 'mpegts', m2ts: 'mpegts', mpegts: 'mpegts',
    wmv: 'asf', asf: 'asf',
    flv: 'flv',
    mpeg: 'mpeg',
    ogm: 'ogg',
  };
  for (const [container, format] of Object.entries(formats)) {
    assert.deepEqual(routes.converterInputLimits(container), ['-protocol_whitelist', 'http,tcp', '-f', format], container);
    assert.equal(FILM_FORMATS.split(',').includes(format), true, container);
  }
  assert.deepEqual(routes.converterInputLimits('MKV'), ['-protocol_whitelist', 'http,tcp', '-f', 'matroska']);

  // Missing, unknown, or the name of a format that reads other addresses: a
  // server cannot talk the converter into a playlist by naming one.
  for (const container of ['', undefined, null, 'dummykind', 'hls', 'm3u8', 'applehttp', 'dash', 'concat', 'sdp', 'rtsp', 'constructor', '__proto__', 'mov,mp4,m4a,3gp,3g2,mj2']) {
    assert.deepEqual(routes.converterInputLimits(container), ['-protocol_whitelist', 'http,tcp', '-format_whitelist', FILM_FORMATS], String(container));
  }
  for (const reader of ['hls', 'applehttp', 'dash', 'concat', 'sdp', 'rtsp', 'imf', 'webm_dash_manifest']) {
    assert.equal(FILM_FORMATS.split(',').includes(reader), false, reader);
  }
});
