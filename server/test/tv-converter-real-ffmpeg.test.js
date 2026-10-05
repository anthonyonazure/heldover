// The converter is started with a fixed input format and a protocol list.
//
// ffmpeg reads one address, this app's own, but the bytes that arrive there
// are whatever the Plex server sends, and that server may be someone else's.
// Left to work the format out from those bytes, ffmpeg took a short text
// playlist in place of a film and fetched the address the playlist named, on
// this computer or on the home network. Now the format comes from the
// container Plex reports and ffmpeg reads its one input and nothing else.
//
// These checks use the real ffmpeg binary, because a wrong format name would
// break every cast of that kind of file and only ffmpeg can say which names
// it knows. Everything stays on 127.0.0.1: the clips are a few seconds of
// ffmpeg's own test picture and a tone. Where no ffmpeg is installed the
// checks skip themselves and say so. (tv-relay.test.js checks the arguments
// with a stand-in, everywhere.)

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  ACCOUNT_TOKEN, SHARE_TOKEN, SERVER_KEY,
  listen, standInTv, standInNetwork, standInDiscovery,
} from './tv-stand-ins.js';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'heldover-test-'));
process.env.DATA_DIR = dataDir;
process.env.PLEX_TOKEN = ACCOUNT_TOKEN;
// The stand-in servers here are plain http on this computer. A listed plain
// http address is used only when the owner has asked for that.
process.env.PLEX_ALLOW_HTTP = '1';
delete process.env.BIND_HOST;

const { discoverRenderers, getFfmpegPath } = await import('../src/tv.js');

// The clips are four seconds long, so that a TV can resume two seconds in.
const CLIP_SECONDS = 4;
const RESUME_AT = 2;
const CLIP_KINDS = { mkv: 'matroska', mp4: 'mp4', ts: 'mpegts' };

/** The ffmpeg the app itself would start, when there is one that runs. */
function findFfmpeg() {
  const candidate = getFfmpegPath();
  const tried = spawnSync(candidate, ['-version'], { stdio: 'ignore' });
  return tried.status === 0 ? candidate : null;
}

/** One small clip per kind of file, made by ffmpeg itself; null when this build cannot make them. */
function makeClips(ffmpeg) {
  const clips = {};
  for (const [extension, muxer] of Object.entries(CLIP_KINDS)) {
    const file = path.join(dataDir, `clip.${extension}`);
    const made = spawnSync(ffmpeg, [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', `testsrc=duration=${CLIP_SECONDS}:size=160x120:rate=10`,
      '-f', 'lavfi', '-i', `sine=frequency=440:duration=${CLIP_SECONDS}`,
      // Encoders every ffmpeg build has. The video is one a TV plays, so the
      // relay copies it and converts the sound only, as it does for most films.
      '-c:v', 'mpeg4', '-c:a', 'aac', '-shortest',
      '-f', muxer, file,
    ], { stdio: 'ignore' });
    if (made.status !== 0) return null;
    clips[extension] = fs.readFileSync(file);
  }
  return clips;
}

const ffmpeg = findFfmpeg();
const clips = ffmpeg ? makeClips(ffmpeg) : null;
let skip = false;
if (!ffmpeg) {
  skip = 'no ffmpeg binary was found on this computer (install ffmpeg, or set FFMPEG_PATH), so the real converter was not tested';
} else if (!clips) {
  skip = 'this ffmpeg could not make the test clips (it needs the lavfi test sources and the mpeg4 and aac encoders), so the real converter was not tested';
}

// "Another machine": what a playlist from a hostile server points the
// converter at. Every test ends by checking it heard nothing.
const other = await listen((req, res) => res.end('should never be asked'));
const PLAYLIST = Buffer.from(
  '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:4\n#EXT-X-MEDIA-SEQUENCE:0\n#EXTINF:4.0,\n' +
  `http://127.0.0.1:${other.port}/segment.ts\n#EXT-X-ENDLIST\n`
);

// What the stand-in Plex server holds. Titles 1 to 3 are honest. Title 4 is a
// real film whose container Plex does not name (a file it has not analyzed).
// Titles 11 to 14 answer with the playlist in place of the film, under each
// container name. Every title has DTS sound on paper, so every cast is relayed.
const PLAYLIST_TYPE = 'application/vnd.apple.mpegurl';
const titles = clips && {
  1: { container: 'mkv', body: clips.mkv },
  2: { container: 'mp4', body: clips.mp4 },
  3: { container: 'mpegts', body: clips.ts },
  4: { container: undefined, body: clips.mkv },
  11: { container: 'mkv', body: PLAYLIST, type: PLAYLIST_TYPE },
  12: { container: 'mp4', body: PLAYLIST, type: PLAYLIST_TYPE },
  13: { container: 'mpegts', body: PLAYLIST, type: PLAYLIST_TYPE },
  14: { container: undefined, body: PLAYLIST, type: PLAYLIST_TYPE },
};

const plex = await listen((req, res) => {
  const url = new URL(req.url, 'http://x');
  const json = (body) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(body));
  };
  if (url.pathname === '/identity') return json({ MediaContainer: { machineIdentifier: SERVER_KEY } });
  if (url.pathname === '/') return json({ MediaContainer: { allowSync: false, friendlyName: 'Friend' } });
  if (url.pathname === '/library/sections') return json({ MediaContainer: { Directory: [{ key: '1', type: 'movie', title: 'Films' }] } });
  const meta = /^\/library\/metadata\/(\d+)$/.exec(url.pathname);
  if (meta && titles?.[meta[1]]) {
    return json({
      MediaContainer: {
        Metadata: [{
          ratingKey: meta[1],
          librarySectionID: 1,
          type: 'movie',
          title: `Dummy ${meta[1]}`,
          duration: CLIP_SECONDS * 1000,
          Media: [{
            container: titles[meta[1]].container,
            videoCodec: 'mpeg4',
            audioCodec: 'dts',
            Part: [{ key: `/library/parts/${meta[1]}/file` }],
          }],
        }],
      },
    });
  }
  const part = /^\/library\/parts\/(\d+)\/file$/.exec(url.pathname);
  if (part && titles?.[part[1]]) {
    // Only the holder of the token gets the file, as a real server insists.
    if (req.headers['x-plex-token'] !== SHARE_TOKEN) {
      res.statusCode = 401;
      return res.end();
    }
    const { body, type } = titles[part[1]];
    res.setHeader('Content-Type', type || 'video/mp4');
    res.setHeader('Accept-Ranges', 'bytes');
    const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '');
    if (range) {
      const start = Number(range[1]);
      const end = range[2] ? Math.min(Number(range[2]), body.length - 1) : body.length - 1;
      res.statusCode = 206;
      res.setHeader('Content-Range', `bytes ${start}-${end}/${body.length}`);
      res.setHeader('Content-Length', end - start + 1);
      return res.end(body.subarray(start, end + 1));
    }
    res.setHeader('Content-Length', body.length);
    return res.end(body);
  }
  res.statusCode = 404;
  return res.end();
});

const TV_HOST = '10.20.30.40';
const tv = await standInTv();
const realFetch = standInNetwork({ plexBase: plex.base });
standInDiscovery(() => [{ location: `http://${TV_HOST}:${tv.port}/desc.xml`, address: TV_HOST }]);

// Imported only after DATA_DIR is set and the stand-ins are in place. ffmpeg
// is not replaced here: the app starts the real one.
const { app } = await import('../src/app.js');
await import('../src/routes/tv.js');
const listener = await new Promise((resolve) => {
  const l = app.listen(0, '127.0.0.1', () => resolve(l));
});
const base = `http://127.0.0.1:${listener.address().port}`;
const controlUrl = `http://${TV_HOST}:${tv.port}/ctl`;
await discoverRenderers(20);

after(() => {
  for (const server of [listener, plex.server, tv.server, other.server]) server.close();
});

/**
 * Sends a title to the TV as the owner, then asks for the stream as the TV
 * does. `resumeAt` asks for it from that many seconds in, the way a TV does
 * when it reconnects in the middle of a film.
 */
async function relay(ratingKey, { resumeAt = 0 } = {}) {
  tv.commands.length = 0;
  const cast = await realFetch(`${base}/api/tv/play`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ serverKey: SERVER_KEY, ratingKey: String(ratingKey), controlUrl }),
  });
  const answer = await cast.json();
  assert.equal(cast.status, 200, answer.error);
  assert.equal(answer.relayed, true);
  const handed = new URL(tv.commands.find((c) => c.action === 'SetAVTransportURI' && c.uri).uri);
  const stream = await realFetch(`${base}${handed.pathname}${handed.search}`, {
    headers: resumeAt ? { 'TimeSeekRange.dlna.org': `npt=${resumeAt.toFixed(1)}-` } : {},
  });
  return { status: stream.status, type: stream.headers.get('content-type'), bytes: Buffer.from(await stream.arrayBuffer()) };
}

/** MPEG-TS is a run of 188-byte packets, each starting with the sync byte 0x47. */
function assertMpegTs({ status, type, bytes }, what) {
  assert.equal(status, 200, what);
  assert.equal(type, 'video/mpeg', what);
  assert.ok(bytes.length >= 188 * 100, `${what}: only ${bytes.length} bytes came out`);
  for (const at of [0, 188, 376, 188 * 99]) assert.equal(bytes[at], 0x47, `${what}: no sync byte at ${at}`);
}

for (const [key, kind] of [[1, 'an mkv'], [2, 'an mp4'], [3, 'a ts']]) {
  test(`a film in ${kind} file is converted for the TV, from the start and when the TV resumes ${RESUME_AT} seconds in`, { skip }, async () => {
    const whole = await relay(key);
    assertMpegTs(whole, 'from the start');
    const resumed = await relay(key, { resumeAt: RESUME_AT });
    assertMpegTs(resumed, 'resumed');
    assert.ok(resumed.bytes.length < whole.bytes.length, 'the resumed stream is the rest of the film, not the whole of it again');
    assert.equal(other.seen.length, 0);
  });
}

test('a film whose container Plex does not name is still converted', { skip }, async () => {
  assertMpegTs(await relay(4), 'from the start');
  assertMpegTs(await relay(4, { resumeAt: RESUME_AT }), 'resumed');
  assert.equal(other.seen.length, 0);
});

test('a text playlist in place of the film makes the converter contact no other address, and the relay ends with an error', { skip }, async () => {
  for (const key of [11, 12, 13, 14]) {
    plex.seen.length = 0;
    const answer = await relay(key);
    const label = `title ${key} (${titles[key].container || 'no container named'})`;
    assert.ok(plex.seen.some((r) => r.url === `/library/parts/${key}/file`), `${label}: the converter read the playlist`);
    assert.deepEqual(other.seen.map((r) => r.url), [], `${label}: the address in the playlist was asked`);
    assert.ok(answer.status >= 400, `${label}: the relay answered ${answer.status}`);
    assert.equal(answer.bytes.length, 0, label);
  }
});

test('a proxy setting on this computer is not passed to the converter, which reads from this computer itself', { skip }, async () => {
  const names = ['http_proxy', 'HTTP_PROXY', 'all_proxy'];
  const before = names.map((name) => process.env[name]);
  for (const name of names) process.env[name] = other.base;
  try {
    assertMpegTs(await relay(1), 'with a proxy set');
    assert.deepEqual(other.seen.map((r) => r.url), [], 'the proxy was asked for the converter\'s input');
  } finally {
    names.forEach((name, i) => {
      if (before[i] === undefined) delete process.env[name];
      else process.env[name] = before[i];
    });
  }
});
